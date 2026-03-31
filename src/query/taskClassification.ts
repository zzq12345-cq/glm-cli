import type { Message, UserMessage } from '../types/message.js'
import { getContentText } from '../utils/messages.js'

export type TaskIntent =
  | 'read_only'
  | 'edit_single'
  | 'edit_multi'
  | 'bug_fix'
  | 'refactor'
  | 'test_fix'
  | 'unknown'

export type TaskScope = 'read_only' | 'single_file' | 'multi_file' | 'unknown'

export type TaskClassification = {
  intent: TaskIntent
  scope: TaskScope
  wantsCodeChanges: boolean
  shouldVerify: boolean
  guidance: string
}

const READ_ONLY_RE =
  /\b(explain|read|review|analy[sz]e|inspect|understand|walk through)\b|阅读|解释|分析|看一下|看下|源码|review/iu
const EDIT_RE =
  /\b(add|change|modify|edit|implement|adapt|replace|update|wire|support|integrate)\b|增加|修改|改成|实现|适配|接入|替换|支持|增强/iu
const BUG_RE =
  /\b(fix|bug|error|issue|broken|fail(?:ing)?|crash|regression)\b|修复|报错|错误|异常|故障|失败/iu
const REFACTOR_RE =
  /\b(refactor|cleanup|clean up|reorganize|rename)\b|重构|整理|重命名/iu
const VERIFY_RE =
  /\b(test|tests|testing|lint|typecheck|type check|build|compile|ci)\b|测试|单测|构建|编译|类型检查|lint/iu
const MULTI_FILE_RE =
  /\b(project|repo|repository|codebase|whole|across|adapter|provider|workflow|architecture|system)\b|整个项目|全局|代码库|工作流|适配器|提供者|架构/iu
const FILE_PATH_RE =
  /(?:[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|java|kt|swift|rb|php|css|scss|md))/g

export function classifyTaskFromMessages(
  messages: readonly Message[],
): TaskClassification | null {
  const latestUserText = findLatestUserText(messages)
  if (!latestUserText) {
    return null
  }
  return classifyTaskText(latestUserText)
}

export function formatTaskClassificationForSystemContext(
  classification: TaskClassification,
): string {
  return `Heuristic task profile: intent=${classification.intent}; scope=${classification.scope}; code_changes=${classification.wantsCodeChanges ? 'yes' : 'no'}; verification=${classification.shouldVerify ? 'expected' : 'optional'}. Guidance: ${classification.guidance}`
}

function findLatestUserText(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.type !== 'user') {
      continue
    }

    const userMessage = message as UserMessage
    if (userMessage.isMeta) {
      continue
    }

    const text = getContentText(userMessage.message.content)
    if (text) {
      return text
    }
  }

  return null
}

export function classifyTaskText(text: string): TaskClassification {
  const normalized = text.trim()
  const fileMatches = normalized.match(FILE_PATH_RE) ?? []
  const distinctFiles = new Set(fileMatches.map(match => match.toLowerCase()))
  const looksMultiFile =
    MULTI_FILE_RE.test(normalized) || distinctFiles.size >= 2
  const scope: TaskScope = READ_ONLY_RE.test(normalized) && !looksLikeEditTask(normalized)
    ? 'read_only'
    : looksMultiFile
      ? 'multi_file'
      : distinctFiles.size === 1
        ? 'single_file'
        : 'unknown'

  if (READ_ONLY_RE.test(normalized) && !looksLikeEditTask(normalized)) {
    return {
      intent: 'read_only',
      scope: 'read_only',
      wantsCodeChanges: false,
      shouldVerify: false,
      guidance:
        'Stay read-only unless the user explicitly asks for edits. Focus on understanding the code and citing the specific files or functions you used.',
    }
  }

  if (BUG_RE.test(normalized) && VERIFY_RE.test(normalized)) {
    return {
      intent: 'test_fix',
      scope,
      wantsCodeChanges: true,
      shouldVerify: true,
      guidance:
        'Use the failing check as the source of truth, patch the smallest relevant surface, and rerun the narrowest related verification command afterward.',
    }
  }

  if (REFACTOR_RE.test(normalized)) {
    return {
      intent: 'refactor',
      scope,
      wantsCodeChanges: true,
      shouldVerify: true,
      guidance:
        'Preserve behavior while improving structure. Match existing patterns carefully, keep the change surface explicit, and verify the most relevant command after editing.',
    }
  }

  if (BUG_RE.test(normalized)) {
    return {
      intent: 'bug_fix',
      scope,
      wantsCodeChanges: true,
      shouldVerify: true,
      guidance:
        'Diagnose the root cause before editing, patch the minimum surface that fixes it, and verify the failing path or the narrowest related command afterward.',
    }
  }

  if (looksLikeEditTask(normalized)) {
    return {
      intent: looksMultiFile ? 'edit_multi' : 'edit_single',
      scope,
      wantsCodeChanges: true,
      shouldVerify: true,
      guidance: looksMultiFile
        ? 'Identify the affected files before editing, keep the implementation scoped to that change surface, and verify with the narrowest relevant command afterward.'
        : 'Favor the smallest targeted change, read the whole target file before editing it, and run a narrow verification if one is available.',
    }
  }

  return {
    intent: 'unknown',
    scope,
    wantsCodeChanges: false,
    shouldVerify: false,
    guidance:
      'Infer the task from nearby context, but prefer reading the relevant files before acting and verify any non-trivial code changes if the task turns out to require edits.',
  }
}

function looksLikeEditTask(text: string): boolean {
  return EDIT_RE.test(text) || BUG_RE.test(text) || REFACTOR_RE.test(text)
}
