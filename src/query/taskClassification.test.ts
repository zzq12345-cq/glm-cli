import { describe, expect, mock, test } from 'bun:test'

mock.module('../utils/messages.js', () => ({
  getContentText(
    content: string | Array<{ type: string; text?: string }>,
  ): string | null {
    if (typeof content === 'string') {
      return content
    }
    if (!Array.isArray(content)) {
      return null
    }
    const text = content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          block.type === 'text' && typeof block.text === 'string',
      )
      .map(block => block.text)
      .join('\n')
      .trim()

    return text || null
  },
}))

const {
  classifyTaskFromMessages,
  classifyTaskText,
  formatTaskClassificationForSystemContext,
} = await import('./taskClassification.js')

function createUserMessage(text: string) {
  return {
    type: 'user',
    isMeta: false,
    message: {
      content: [{ type: 'text', text }],
    },
  } as const
}

describe('taskClassification', () => {
  test('classifies read-only Chinese source-reading requests', () => {
    const classification = classifyTaskText('阅读一下 claude.ts 源码，解释下主要流程')

    expect(classification.intent).toBe('read_only')
    expect(classification.scope).toBe('read_only')
    expect(classification.wantsCodeChanges).toBe(false)
    expect(classification.shouldVerify).toBe(false)
  })

  test('classifies repository-wide GLM adaptation work as multi-file edits', () => {
    const classification = classifyTaskText(
      '把整个项目适配成 glm provider，并增强 workflow 和 adapter',
    )

    expect(classification.intent).toBe('edit_multi')
    expect(classification.scope).toBe('multi_file')
    expect(classification.wantsCodeChanges).toBe(true)
    expect(classification.shouldVerify).toBe(true)
  })

  test('classifies failing test repairs from the latest user message', () => {
    const classification = classifyTaskFromMessages([
      createUserMessage('先阅读代码结构'),
      createUserMessage(
        'Fix failing tests in src/query.ts and src/services/api/client.ts',
      ),
    ] as never)

    expect(classification).not.toBeNull()
    expect(classification?.intent).toBe('test_fix')
    expect(classification?.scope).toBe('multi_file')
    expect(classification?.shouldVerify).toBe(true)
  })

  test('formats system-context guidance for downstream prompts', () => {
    const formatted = formatTaskClassificationForSystemContext(
      classifyTaskText('修复 src/query.ts 里的 bug'),
    )

    expect(formatted).toContain('intent=bug_fix')
    expect(formatted).toContain('verification=expected')
    expect(formatted).toContain('Guidance:')
  })
})
