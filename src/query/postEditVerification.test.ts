import { describe, expect, test } from 'bun:test'

const {
  countPostEditVerificationFailuresSinceLastUserTurn,
  didSuccessfulExplicitCodeEditOccur,
  maybeRunPostEditVerification,
  selectVerificationCommand,
} = await import('./postEditVerification.js')

function createUserMessage({
  content,
  isMeta,
  toolUseResult,
}: {
  content: string
  isMeta?: true
  toolUseResult?: unknown
}) {
  return {
    type: 'user',
    isMeta,
    message: {
      role: 'user',
      content,
    },
    toolUseResult,
    uuid: 'test-message',
    timestamp: '2026-01-01T00:00:00.000Z',
  } as const
}

function createHumanMessage(text: string) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: text,
    },
  } as const
}

function createVerificationFailureMessage() {
  return createUserMessage({
    content: 'Automatic verification failed.',
    isMeta: true,
    toolUseResult: {
      type: 'post_edit_verification',
      outcome: 'failed',
      command: 'bun test',
      kind: 'test',
      exitCode: 1,
    },
  })
}

function createSuccessfulToolResultMessage(toolUseId: string) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'The file has been updated successfully.',
        },
      ],
    },
  } as const
}

const defaultClassification = {
  intent: 'bug_fix',
  scope: 'single_file',
  wantsCodeChanges: true,
  shouldVerify: true,
  guidance: 'verify after editing',
} as const

const testDeps = {
  createUserMessage,
  detectProjectContext: async () => ({
    rootDir: '/repo',
    signals: ['Node.js'],
    commands: {
      test: 'bun test',
      lint: 'bun run lint',
    },
  }),
  quote: (args: ReadonlyArray<unknown>) => `'${String(args[0])}'`,
  truncateToLines: (text: string, maxLines: number) => {
    const lines = text.split('\n')
    return lines.length <= maxLines
      ? text
      : lines.slice(0, maxLines).join('\n') + '…'
  },
}

describe('postEditVerification', () => {
  test('runs the narrowest detected verification command after a successful edit golden path', async () => {
    const calls: Array<{
      command: string
      shellType: string
      options?: Record<string, unknown>
    }> = []
    let cleanedUp = false

    const result = await maybeRunPostEditVerification({
      messages: [createHumanMessage('修复 src/query.ts 并跑验证')],
      toolUseBlocks: [
        {
          id: 'edit_1',
          name: 'Edit',
          input: { file_path: 'src/query.ts' },
        } as never,
      ],
      toolResults: [createSuccessfulToolResultMessage('edit_1') as never],
      classification: defaultClassification,
      abortSignal: new AbortController().signal,
      deps: {
        ...testDeps,
        exec: async (command, _signal, shellType, options) => {
          calls.push({ command, shellType, options })
          return {
            result: Promise.resolve({
              stdout: '11 pass\n0 fail',
              stderr: '',
              code: 0,
              interrupted: false,
            }),
            cleanup: () => {
              cleanedUp = true
            },
          }
        },
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      command: "cd '/repo' && bun test",
      shellType: 'bash',
      options: {
        timeout: 120000,
        preventCwdChanges: true,
        shouldUseSandbox: false,
      },
    })
    expect(cleanedUp).toBe(true)
    expect(result.attempted).toBe(true)
    expect(result.outcome).toBe('passed')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.toolUseResult).toEqual({
      type: 'post_edit_verification',
      outcome: 'passed',
      command: 'bun test',
      kind: 'test',
      exitCode: 0,
    })
    expect(result.messages[0]?.message.content).toContain(
      'Automatic verification passed',
    )
  })

  test('stops auto verification after two failures in the same user turn', async () => {
    let execCalled = false

    const result = await maybeRunPostEditVerification({
      messages: [
        createHumanMessage('继续修复'),
        createVerificationFailureMessage(),
        createVerificationFailureMessage(),
      ] as never,
      toolUseBlocks: [
        {
          id: 'edit_2',
          name: 'Write',
          input: { file_path: 'src/query.ts' },
        } as never,
      ],
      toolResults: [createSuccessfulToolResultMessage('edit_2') as never],
      classification: defaultClassification,
      abortSignal: new AbortController().signal,
      deps: {
        ...testDeps,
        exec: async () => {
          execCalled = true
          throw new Error('exec should not run')
        },
      },
    })

    expect(execCalled).toBe(false)
    expect(result.attempted).toBe(false)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]?.toolUseResult).toEqual({
      type: 'post_edit_verification_limit_reached',
      failureCount: 2,
    })
  })

  test('counts only failures from the current user turn', () => {
    const failureCount = countPostEditVerificationFailuresSinceLastUserTurn([
      createHumanMessage('上一个任务'),
      createVerificationFailureMessage(),
      createHumanMessage('当前任务'),
      createVerificationFailureMessage(),
    ] as never)

    expect(failureCount).toBe(1)
  })

  test('detects successful explicit edit tools and chooses fallback command order', () => {
    expect(
      didSuccessfulExplicitCodeEditOccur(
        [
          {
            id: 'edit_ok',
            name: 'Edit',
            input: {},
          } as never,
        ],
        [createSuccessfulToolResultMessage('edit_ok') as never],
      ),
    ).toBe(true)

    expect(
      selectVerificationCommand({
        rootDir: '/repo',
        signals: ['Node.js'],
        commands: {
          lint: 'bun run lint',
          build: 'bun run build',
        },
      }),
    ).toEqual({
      command: 'bun run lint',
      kind: 'lint',
    })
  })
})
