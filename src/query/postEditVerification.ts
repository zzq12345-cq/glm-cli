import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Message, UserMessage } from '../types/message.js'

const AUTO_VERIFY_FAILURE_LIMIT = 2
const AUTO_VERIFY_TIMEOUT_MS = parseInt(
  process.env.CLAUDE_CODE_AUTO_VERIFY_TIMEOUT_MS ?? String(2 * 60 * 1000),
  10,
)
const AUTO_VERIFY_OUTPUT_LINE_LIMIT = 80
const AUTO_VERIFY_OUTPUT_CHAR_LIMIT = 12_000
const FILE_EDIT_TOOL_NAME = 'Edit'
const FILE_WRITE_TOOL_NAME = 'Write'

type VerificationCommandKind = 'test' | 'lint' | 'typecheck' | 'build'

type ProjectDetectionResult = {
  rootDir: string
  signals: string[]
  commands: Partial<Record<VerificationCommandKind, string>>
}

type TaskClassification = {
  shouldVerify: boolean
}

type ExecResult = {
  stdout: string
  stderr: string
  code: number
  interrupted: boolean
  outputFilePath?: string
}

type PostEditVerificationOutcome = 'passed' | 'failed'

type PostEditVerificationToolUseResult = {
  type: 'post_edit_verification'
  outcome: PostEditVerificationOutcome
  command: string
  kind: VerificationCommandKind
  exitCode: number
}

type PostEditVerificationLimitToolUseResult = {
  type: 'post_edit_verification_limit_reached'
  failureCount: number
}

type PostEditVerificationToolUseMetadata =
  | PostEditVerificationToolUseResult
  | PostEditVerificationLimitToolUseResult

export type PostEditVerificationResult = {
  attempted: boolean
  messages: UserMessage[]
  outcome?: PostEditVerificationOutcome
}

type PostEditVerificationDeps = {
  exec: (
    command: string,
    abortSignal: AbortSignal,
    shellType: 'bash',
    options: {
      timeout: number
      preventCwdChanges: boolean
      shouldUseSandbox: boolean
    },
  ) => Promise<{
    result: Promise<ExecResult>
    cleanup: () => void
  }>
  createUserMessage: (args: {
    content: string | unknown[]
    isMeta?: true
    toolUseResult?: unknown
  }) => UserMessage
  detectProjectContext: () => Promise<ProjectDetectionResult | null>
  quote: (args: ReadonlyArray<unknown>) => string
  truncateToLines: (text: string, maxLines: number) => string
}

export function didSuccessfulExplicitCodeEditOccur(
  toolUseBlocks: readonly ToolUseBlock[],
  toolResults: readonly Message[],
): boolean {
  const codeEditToolUseIds = new Set(
    toolUseBlocks
      .filter(
        block =>
          block.name === FILE_EDIT_TOOL_NAME ||
          block.name === FILE_WRITE_TOOL_NAME,
      )
      .map(block => block.id),
  )

  if (codeEditToolUseIds.size === 0) {
    return false
  }

  for (const message of toolResults) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue
    }

    for (const contentBlock of message.message.content) {
      if (
        contentBlock.type === 'tool_result' &&
        codeEditToolUseIds.has(contentBlock.tool_use_id) &&
        contentBlock.is_error !== true
      ) {
        return true
      }
    }
  }

  return false
}

export function selectVerificationCommand(
  project: ProjectDetectionResult | null,
): { command: string; kind: VerificationCommandKind } | null {
  if (!project) {
    return null
  }

  const commandKinds: VerificationCommandKind[] = [
    'test',
    'lint',
    'typecheck',
    'build',
  ]

  for (const kind of commandKinds) {
    const command = project.commands[kind]
    if (command) {
      return { command, kind }
    }
  }

  return null
}

export function countPostEditVerificationFailuresSinceLastUserTurn(
  messages: readonly Message[],
): number {
  let failureCount = 0

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) {
      continue
    }

    const metadata = readPostEditVerificationMetadata(message)
    if (
      metadata?.type === 'post_edit_verification' &&
      metadata.outcome === 'failed'
    ) {
      failureCount += 1
    }

    if (message.type === 'user' && !message.isMeta) {
      break
    }
  }

  return failureCount
}

export async function maybeRunPostEditVerification({
  messages,
  toolUseBlocks,
  toolResults,
  classification,
  abortSignal,
  deps,
}: {
  messages: readonly Message[]
  toolUseBlocks: readonly ToolUseBlock[]
  toolResults: readonly Message[]
  classification: TaskClassification | null
  abortSignal: AbortSignal
  deps?: Partial<PostEditVerificationDeps>
}): Promise<PostEditVerificationResult> {
  if (!classification?.shouldVerify) {
    return { attempted: false, messages: [] }
  }

  if (!didSuccessfulExplicitCodeEditOccur(toolUseBlocks, toolResults)) {
    return { attempted: false, messages: [] }
  }

  const priorFailures =
    countPostEditVerificationFailuresSinceLastUserTurn(messages)
  if (priorFailures >= AUTO_VERIFY_FAILURE_LIMIT) {
    const resolvedDeps = await resolveDeps(deps)
    return {
      attempted: false,
      messages: [
        createVerificationLimitReachedMessage(
          priorFailures,
          resolvedDeps.createUserMessage,
        ),
      ],
    }
  }

  const resolvedDeps = await resolveDeps(deps)
  const project = await resolvedDeps.detectProjectContext()
  const selectedCommand = selectVerificationCommand(project)
  if (!selectedCommand) {
    return { attempted: false, messages: [] }
  }

  const command = `cd ${resolvedDeps.quote([project.rootDir])} && ${selectedCommand.command}`

  let shellCommand:
    | Awaited<ReturnType<PostEditVerificationDeps['exec']>>
    | undefined
  try {
    shellCommand = await resolvedDeps.exec(command, abortSignal, 'bash', {
      timeout: AUTO_VERIFY_TIMEOUT_MS,
      preventCwdChanges: true,
      shouldUseSandbox: false,
    })
    const result = await shellCommand.result
    const outcome =
      result.code === 0 && result.interrupted !== true ? 'passed' : 'failed'

    return {
      attempted: true,
      outcome,
      messages: [
        createVerificationResultMessage({
          kind: selectedCommand.kind,
          command: selectedCommand.command,
          projectRoot: project.rootDir,
          result,
          outcome,
          createUserMessage: resolvedDeps.createUserMessage,
          truncateToLines: resolvedDeps.truncateToLines,
        }),
      ],
    }
  } catch (error) {
    return {
      attempted: true,
      outcome: 'failed',
      messages: [
        createVerificationExecutionErrorMessage(
          selectedCommand.kind,
          selectedCommand.command,
          project.rootDir,
          error,
          resolvedDeps.createUserMessage,
        ),
      ],
    }
  } finally {
    shellCommand?.cleanup()
  }
}

function createVerificationResultMessage({
  kind,
  command,
  projectRoot,
  result,
  outcome,
  createUserMessage,
  truncateToLines,
}: {
  kind: VerificationCommandKind
  command: string
  projectRoot: string
  result: ExecResult
  outcome: PostEditVerificationOutcome
  createUserMessage: PostEditVerificationDeps['createUserMessage']
  truncateToLines: PostEditVerificationDeps['truncateToLines']
}): UserMessage {
  const sections = [
    outcome === 'passed'
      ? `Automatic verification passed after the latest code edits using the ${kind} command.`
      : `Automatic verification failed after the latest code edits using the ${kind} command.`,
    `Working directory: ${projectRoot}\nCommand: ${command}\nExit code: ${result.code}${result.interrupted ? ' (interrupted)' : ''}`,
  ]

  const stdoutSection = formatOutputSection(
    'stdout',
    result.stdout,
    truncateToLines,
  )
  if (stdoutSection) {
    sections.push(stdoutSection)
  }

  const stderrSection = formatOutputSection(
    'stderr',
    result.stderr,
    truncateToLines,
  )
  if (stderrSection) {
    sections.push(stderrSection)
  }

  if (result.outputFilePath) {
    sections.push(`Full output path: ${result.outputFilePath}`)
  }

  sections.push(
    outcome === 'passed'
      ? 'Treat this as the latest verification status. Finish only if no further user-requested changes remain.'
      : 'Treat this output as the current source of truth. Fix the issue and rerun the narrowest relevant verification command.',
  )

  return createUserMessage({
    content: sections.join('\n\n'),
    isMeta: true,
    toolUseResult: {
      type: 'post_edit_verification',
      outcome,
      command,
      kind,
      exitCode: result.code,
    } satisfies PostEditVerificationToolUseResult,
  })
}

function createVerificationExecutionErrorMessage(
  kind: VerificationCommandKind,
  command: string,
  projectRoot: string,
  error: unknown,
  createUserMessage: PostEditVerificationDeps['createUserMessage'],
): UserMessage {
  const message =
    error instanceof Error ? error.message : 'Unknown verification error'
  return createUserMessage({
    content: [
      `Automatic verification could not complete after the latest code edits.`,
      `Working directory: ${projectRoot}\nCommand: ${command}\nReason: ${message}`,
      'Treat this as a failed verification attempt and decide the next narrowest check manually if needed.',
    ].join('\n\n'),
    isMeta: true,
    toolUseResult: {
      type: 'post_edit_verification',
      outcome: 'failed',
      command,
      kind,
      exitCode: -1,
    } satisfies PostEditVerificationToolUseResult,
  })
}

function createVerificationLimitReachedMessage(
  failureCount: number,
  createUserMessage: PostEditVerificationDeps['createUserMessage'],
): UserMessage {
  return createUserMessage({
    content: [
      `Automatic verification has already failed ${failureCount} times for this user request.`,
      'Do not rely on further automatic project-wide verification in this turn. Use the latest failure output as the source of truth and choose the narrowest manual follow-up only if it is still necessary.',
    ].join('\n\n'),
    isMeta: true,
    toolUseResult: {
      type: 'post_edit_verification_limit_reached',
      failureCount,
    } satisfies PostEditVerificationLimitToolUseResult,
  })
}

function formatOutputSection(
  label: 'stdout' | 'stderr',
  output: string,
  truncateToLines: PostEditVerificationDeps['truncateToLines'],
): string {
  const trimmed = output.trim()
  if (!trimmed) {
    return ''
  }

  const truncatedByLines = truncateToLines(trimmed, AUTO_VERIFY_OUTPUT_LINE_LIMIT)
  const truncated =
    truncatedByLines.length > AUTO_VERIFY_OUTPUT_CHAR_LIMIT
      ? truncatedByLines.slice(0, AUTO_VERIFY_OUTPUT_CHAR_LIMIT) + '…'
      : truncatedByLines

  return `${label}:\n${truncated}`
}

function readPostEditVerificationMetadata(
  message: Message,
): PostEditVerificationToolUseMetadata | null {
  if (message.type !== 'user' || !message.toolUseResult) {
    return null
  }

  const result = message.toolUseResult
  if (typeof result !== 'object' || result === null || !('type' in result)) {
    return null
  }

  if (
    result.type === 'post_edit_verification' ||
    result.type === 'post_edit_verification_limit_reached'
  ) {
    return result as PostEditVerificationToolUseMetadata
  }

  return null
}

async function resolveDeps(
  overrides?: Partial<PostEditVerificationDeps>,
): Promise<PostEditVerificationDeps> {
  const [
    shellModule,
    projectDetectionModule,
    messagesModule,
    shellQuoteModule,
    stringUtilsModule,
  ] = await Promise.all([
    overrides?.exec
      ? Promise.resolve(null)
      : import('../utils/Shell.js'),
    overrides?.detectProjectContext
      ? Promise.resolve(null)
      : import('./projectDetection.js'),
    overrides?.createUserMessage
      ? Promise.resolve(null)
      : import('../utils/messages.js'),
    overrides?.quote
      ? Promise.resolve(null)
      : import('../utils/bash/shellQuote.js'),
    overrides?.truncateToLines
      ? Promise.resolve(null)
      : import('../utils/stringUtils.js'),
  ])

  return {
    exec: overrides?.exec ?? shellModule!.exec,
    detectProjectContext:
      overrides?.detectProjectContext ?? projectDetectionModule!.detectProjectContext,
    createUserMessage:
      overrides?.createUserMessage ?? messagesModule!.createUserMessage,
    quote: overrides?.quote ?? shellQuoteModule!.quote,
    truncateToLines:
      overrides?.truncateToLines ?? stringUtilsModule!.truncateToLines,
  }
}
