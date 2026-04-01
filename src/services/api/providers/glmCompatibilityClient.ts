import Anthropic from '@anthropic-ai/sdk'
import type { ClientOptions } from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaStopReason,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import { logForDebugging } from '../../../utils/debug.js'
import { safeParseJSON } from '../../../utils/json.js'

type FetchLike = NonNullable<ClientOptions['fetch']>

type CountTokensResponse = {
  input_tokens: number
}

type GLMClientOptions = {
  apiKey?: string
  baseURL?: string
  defaultHeaders: Record<string, string>
  fetch: FetchLike
  fetchOptions?: NonNullable<ClientOptions['fetchOptions']>
  timeout: number
}

type OpenAIChatCompletionRequest = {
  model: string
  messages: OpenAIMessage[]
  max_tokens?: number
  temperature?: number
  stream?: boolean
  stop?: string[]
  tools?: OpenAITool[]
  tool_choice?: 'auto' | { type: 'function'; function: { name: string } }
  response_format?: {
    type: 'json_schema'
    json_schema: {
      name: string
      strict?: boolean
      schema: Record<string, unknown>
    }
  }
  stream_options?: {
    include_usage?: boolean
  }
}

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: {
          name: string
          arguments: string
        }
      }>
    }
  | { role: 'tool'; tool_call_id: string; content: string }

type OpenAITool = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

type OpenAIChatCompletionResponse = {
  id?: string
  model?: string
  choices?: Array<{
    message?: {
      role?: 'assistant'
      content?: string | null
      tool_calls?: Array<{
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

type OpenAIChatCompletionChunk = {
  id?: string
  model?: string
  choices?: Array<{
    delta?: {
      role?: 'assistant'
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function resolveGLMBaseURL(baseURL?: string): string {
  const configured =
    baseURL ||
    process.env.GLM_BASE_URL ||
    process.env.ZAI_BASE_URL ||
    'https://open.bigmodel.cn/api/coding/paas/v4'

  return configured.endsWith('/chat/completions')
    ? configured
    : `${configured.replace(/\/$/, '')}/chat/completions`
}

function getGLMApiKey(explicitApiKey?: string): string {
  const key =
    explicitApiKey ||
    process.env.GLM_API_KEY ||
    process.env.ZAI_API_KEY ||
    process.env.OPENAI_API_KEY

  if (!key) {
    throw new Error(
      'Missing GLM API key. Set GLM_API_KEY, ZAI_API_KEY, or OPENAI_API_KEY.',
    )
  }

  return key
}

function mapUsage(usage?: {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}) {
  return {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }
}

function flattenTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }

  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || !('type' in block)) {
      continue
    }
    switch (block.type) {
      case 'text':
        if ('text' in block && typeof block.text === 'string') {
          parts.push(block.text)
        }
        break
      case 'tool_result':
        if ('content' in block) {
          parts.push(flattenTextContent(block.content))
        }
        break
      case 'thinking':
      case 'redacted_thinking':
        break
      default:
        parts.push(`[${String(block.type)} omitted]`)
        break
    }
  }

  return parts.join('\n')
}

function anthropicMessagesToOpenAI(
  params: Pick<BetaMessageStreamParams, 'messages' | 'system'>,
): OpenAIMessage[] {
  const out: OpenAIMessage[] = []

  const systemText = Array.isArray(params.system)
    ? params.system
        .map(block =>
          block && typeof block === 'object' && 'text' in block
            ? String(block.text)
            : '',
        )
        .filter(Boolean)
        .join('\n')
    : typeof params.system === 'string'
      ? params.system
      : ''

  if (systemText) {
    out.push({ role: 'system', content: systemText })
  }

  for (const message of params.messages) {
    if (typeof message.content === 'string') {
      out.push({
        role: message.role as 'user' | 'assistant',
        content: message.content,
      } as OpenAIMessage)
      continue
    }

    if (message.role === 'assistant') {
      const textParts: string[] = []
      const toolCalls: NonNullable<
        Extract<OpenAIMessage, { role: 'assistant' }>['tool_calls']
      > = []

      for (const block of message.content) {
        switch (block.type) {
          case 'text':
            textParts.push(block.text)
            break
          case 'tool_use':
          case 'server_tool_use':
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            })
            break
          case 'thinking':
          case 'redacted_thinking':
            break
          default:
            break
        }
      }

      out.push({
        role: 'assistant',
        content: textParts.length > 0 ? textParts.join('\n') : null,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      })
      continue
    }

    let pendingUserText: string[] = []
    const flushUserText = () => {
      if (pendingUserText.length === 0) {
        return
      }
      out.push({
        role: 'user',
        content: pendingUserText.join('\n'),
      })
      pendingUserText = []
    }

    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          pendingUserText.push(block.text)
          break
        case 'tool_result':
          flushUserText()
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: flattenTextContent(block.content),
          })
          break
        default:
          pendingUserText.push(`[${block.type} omitted]`)
          break
      }
    }

    flushUserText()
  }

  return out
}

function anthropicToolsToOpenAI(tools?: BetaToolUnion[]): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }

  const mapped = tools
    .filter(
      (tool): tool is BetaToolUnion & {
        name: string
        description?: string
        input_schema?: Record<string, unknown>
      } => Boolean(tool && typeof tool === 'object' && 'name' in tool),
    )
    .map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        ...(tool.description && { description: tool.description }),
        ...(tool.input_schema && { parameters: tool.input_schema }),
      },
    }))

  return mapped.length > 0 ? mapped : undefined
}

function anthropicToolChoiceToOpenAI(
  toolChoice: BetaMessageStreamParams['tool_choice'],
): OpenAIChatCompletionRequest['tool_choice'] {
  if (!toolChoice || toolChoice.type === 'auto') {
    return 'auto'
  }
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      type: 'function',
      function: {
        name: toolChoice.name,
      },
    }
  }
  return 'auto'
}

function buildOpenAIRequest(
  params: BetaMessageStreamParams,
): OpenAIChatCompletionRequest {
  const request: OpenAIChatCompletionRequest = {
    model: params.model,
    messages: anthropicMessagesToOpenAI(params),
    ...(typeof params.max_tokens === 'number' && { max_tokens: params.max_tokens }),
    ...(typeof params.temperature === 'number' && { temperature: params.temperature }),
    ...(Array.isArray(params.stop_sequences) &&
      params.stop_sequences.length > 0 && {
        stop: params.stop_sequences,
      }),
    ...(params.stream && {
      stream: true,
      stream_options: {
        include_usage: true,
      },
    }),
  }

  const tools = anthropicToolsToOpenAI(params.tools)
  if (tools) {
    request.tools = tools
    request.tool_choice = anthropicToolChoiceToOpenAI(params.tool_choice)
  }

  const outputFormat = params.output_config?.format
  if (
    outputFormat &&
    typeof outputFormat === 'object' &&
    outputFormat.type === 'json_schema'
  ) {
    request.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'structured_output',
        strict: true,
        schema: outputFormat.schema as Record<string, unknown>,
      },
    }
  }

  return request
}

function mapFinishReason(
  finishReason: string | null | undefined,
): BetaStopReason | null {
  switch (finishReason) {
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'stop':
    case 'content_filter':
    default:
      return 'end_turn'
  }
}

function parseToolArguments(
  argumentsText: string | undefined,
): Record<string, unknown> {
  const parsed = safeParseJSON(argumentsText ?? '{}', false)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

function responseToBetaMessage(
  params: BetaMessageStreamParams,
  response: OpenAIChatCompletionResponse,
): BetaMessage & { _request_id?: string } {
  const choice = response.choices?.[0]
  const message = choice?.message
  const content: BetaContentBlock[] = []

  if (message?.content) {
    content.push({ type: 'text', text: message.content } as unknown as BetaContentBlock)
  }

  for (const toolCall of message?.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: toolCall.id ?? randomUUID(),
      name: toolCall.function?.name ?? 'unknown_tool',
      input: parseToolArguments(toolCall.function?.arguments),
    } as BetaContentBlock)
  }

  return {
    id: response.id ?? randomUUID(),
    type: 'message',
    role: 'assistant',
    model: response.model ?? params.model,
    content,
    stop_reason: mapFinishReason(choice?.finish_reason),
    stop_sequence: null,
    usage: mapUsage(response.usage),
    _request_id: response.id,
  } as unknown as BetaMessage & { _request_id?: string }
}

function createApproxCountTokensResponse(
  params: Pick<BetaMessageStreamParams, 'messages' | 'system' | 'tools'>,
): CountTokensResponse {
  const payload = {
    system: params.system ?? [],
    messages: params.messages,
    tools: params.tools ?? [],
  }
  const serialized = JSON.stringify(payload)

  // 改进的 GLM Token 近似估算策略：
  // 英文字符/标记（ASCII）平均约 3.5 个字符一个 Token
  // 中文等非 ASCII 字符平均约 1.5 个字符一个 Token
  const asciiCount = serialized.replace(/[\u0100-\uffff]/g, '').length
  const nonAsciiCount = serialized.length - asciiCount

  return {
    input_tokens: Math.max(
      1,
      Math.ceil(asciiCount / 3.5 + nonAsciiCount / 1.5),
    ),
  }
}

async function parseError(response: Response): Promise<never> {
  const bodyText = await response.text()
  let errorObj: any
  try {
    errorObj = JSON.parse(bodyText)
  } catch {
    errorObj = { message: bodyText }
  }

  throw Anthropic.APIError.generate(
    response.status,
    errorObj,
    `GLM API request failed with ${response.status} ${response.statusText}`,
    response.headers as any,
  )
}

async function fetchJSON(
  options: GLMClientOptions,
  body: OpenAIChatCompletionRequest,
  requestOptions?: { signal?: AbortSignal },
): Promise<OpenAIChatCompletionResponse> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => {
    controller.abort('glm_request_timeout')
  }, options.timeout)
  requestOptions?.signal?.addEventListener('abort', () => {
    controller.abort(requestOptions.signal?.reason)
  })

  let response: Response
  try {
    response = await options.fetch(resolveGLMBaseURL(options.baseURL), {
      ...options.fetchOptions,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getGLMApiKey(options.apiKey)}`,
        ...options.defaultHeaders,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (error: unknown) {
    if (
      controller.signal.aborted &&
      controller.signal.reason === 'glm_request_timeout'
    ) {
      throw new Anthropic.APIConnectionTimeoutError({
        message: 'Request timed out waiting for GLM API',
      })
    }
    if (requestOptions?.signal?.aborted) {
      throw new Anthropic.APIUserAbortError()
    }
    throw new Anthropic.APIConnectionError({
      message: error instanceof Error ? error.message : String(error),
      cause: error instanceof Error ? error : undefined,
    })
  } finally {
    clearTimeout(timeoutId)
  }

  if (!response.ok) {
    await parseError(response)
  }

  return (await response.json()) as OpenAIChatCompletionResponse
}

async function* iterateSSE(
  response: Response,
): AsyncGenerator<OpenAIChatCompletionChunk> {
  if (!response.body) {
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    while (true) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary === -1) {
        break
      }

      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)

      for (const line of rawEvent.split(/\r?\n/)) {
        if (!line.startsWith('data:')) {
          continue
        }
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') {
          continue
        }
        yield JSON.parse(data) as OpenAIChatCompletionChunk
      }
    }
  }

  const trailing = buffer.trim()
  if (!trailing) {
    return
  }
  for (const line of trailing.split(/\r?\n/)) {
    if (!line.startsWith('data:')) {
      continue
    }
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') {
      continue
    }
    yield JSON.parse(data) as OpenAIChatCompletionChunk
  }
}

class GLMMessageStream implements AsyncIterable<BetaRawMessageStreamEvent> {
  public readonly controller = new AbortController()
  private readonly requestId = randomUUID()
  private responsePromise: Promise<Response> | null = null

  constructor(
    private readonly options: GLMClientOptions,
    private readonly body: OpenAIChatCompletionRequest,
    private readonly requestOptions?: { signal?: AbortSignal },
  ) {
    this.requestOptions?.signal?.addEventListener('abort', () => {
      this.controller.abort(this.requestOptions?.signal?.reason)
    })
  }

  private ensureResponse(): Promise<Response> {
    if (this.responsePromise) {
      return this.responsePromise
    }

    this.responsePromise = this.options
      .fetch(resolveGLMBaseURL(this.options.baseURL), {
        ...this.options.fetchOptions,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getGLMApiKey(this.options.apiKey)}`,
          ...this.options.defaultHeaders,
        },
        body: JSON.stringify(this.body),
        signal: this.controller.signal,
      })
      .catch((error: unknown) => {
        if (
          this.controller.signal.aborted &&
          this.controller.signal.reason === 'glm_stream_timeout'
        ) {
          throw new Anthropic.APIConnectionTimeoutError({
            message: 'Request timed out waiting for GLM API',
          })
        }
        if (this.requestOptions?.signal?.aborted) {
          throw new Anthropic.APIUserAbortError()
        }
        throw new Anthropic.APIConnectionError({
          message: error instanceof Error ? error.message : String(error),
          cause: error instanceof Error ? error : undefined,
        })
      })

    const timeoutId = setTimeout(() => {
      if (!this.controller.signal.aborted) {
        this.controller.abort('glm_stream_timeout')
      }
    }, this.options.timeout)
    this.responsePromise.finally(() => clearTimeout(timeoutId))

    return this.responsePromise
  }

  async withResponse(): Promise<{
    data: GLMMessageStream
    request_id: string
    response: Response
  }> {
    const response = await this.ensureResponse()
    if (!response.ok) {
      await parseError(response)
    }

    return {
      data: this,
      request_id: this.requestId,
      response,
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<BetaRawMessageStreamEvent> {
    const response = await this.ensureResponse()
    if (!response.ok) {
      await parseError(response)
    }

    let messageStarted = false
    let textBlockIndex: number | null = null
    const toolIndexToBlockIndex = new Map<number, number>()
    const toolIndexToMeta = new Map<
      number,
      {
        id: string
        name: string
      }
    >()
    const blockOrder: number[] = []
    let nextBlockIndex = 0
    let usage = mapUsage()
    let stopReason: BetaStopReason | null = null
    let model = this.body.model

    for await (const chunk of iterateSSE(response)) {
      if (!messageStarted) {
        model = chunk.model ?? model
        messageStarted = true
        yield {
          type: 'message_start',
          message: {
            id: chunk.id ?? this.requestId,
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage,
          } as unknown as BetaMessage,
        } as BetaRawMessageStreamEvent
      }

      if (chunk.usage) {
        usage = mapUsage(chunk.usage)
      }

      const choice = chunk.choices?.[0]
      if (!choice) {
        continue
      }

      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (textBlockIndex === null) {
          textBlockIndex = nextBlockIndex++
          blockOrder.push(textBlockIndex)
          yield {
            type: 'content_block_start',
            index: textBlockIndex,
            content_block: {
              type: 'text',
              text: '',
              citations: [],
            },
          } as BetaRawMessageStreamEvent
        }

        yield {
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: {
            type: 'text_delta',
            text: delta.content,
          },
        } as BetaRawMessageStreamEvent
      }

      for (const toolCall of delta.tool_calls ?? []) {
        const toolIndex = toolCall.index ?? 0
        let blockIndex = toolIndexToBlockIndex.get(toolIndex)
        if (blockIndex === undefined) {
          const meta = {
            id: toolCall.id ?? randomUUID(),
            name: toolCall.function?.name ?? 'unknown_tool',
          }
          blockIndex = nextBlockIndex++
          toolIndexToBlockIndex.set(toolIndex, blockIndex)
          toolIndexToMeta.set(toolIndex, meta)
          blockOrder.push(blockIndex)
          yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: meta.id,
              name: meta.name,
              input: '',
            },
          } as BetaRawMessageStreamEvent
        } else {
          const meta = toolIndexToMeta.get(toolIndex)
          if (toolCall.id && meta) {
            meta.id = toolCall.id
          }
          if (toolCall.function?.name && meta) {
            meta.name = toolCall.function.name
          }
        }

        if (toolCall.function?.arguments) {
          yield {
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: toolCall.function.arguments,
            },
          } as BetaRawMessageStreamEvent
        }
      }

      if (choice.finish_reason) {
        stopReason = mapFinishReason(choice.finish_reason)
      }
    }

    if (!messageStarted) {
      return
    }

    for (const blockIndex of blockOrder) {
      yield {
        type: 'content_block_stop',
        index: blockIndex,
      } as BetaRawMessageStreamEvent
    }

    yield {
      type: 'message_delta',
      usage,
      delta: {
        stop_reason: stopReason ?? 'end_turn',
        stop_sequence: null,
      },
    } as BetaRawMessageStreamEvent

    yield {
      type: 'message_stop',
    } as BetaRawMessageStreamEvent
  }
}

export async function createGLMCompatibilityClient(
  options: GLMClientOptions,
): Promise<Anthropic> {
  const client = {
    beta: {
      messages: {
        create: (
          params: BetaMessageStreamParams,
          requestOptions?: {
            signal?: AbortSignal
          },
        ) => {
          const body = buildOpenAIRequest(params)
          if (params.stream) {
            return new GLMMessageStream(options, body, requestOptions)
          }
          return fetchJSON(options, body, requestOptions).then(response =>
            responseToBetaMessage(params, response),
          )
        },
        countTokens: (
          params: Pick<BetaMessageStreamParams, 'messages' | 'system' | 'tools'>,
        ) => Promise.resolve(createApproxCountTokensResponse(params)),
      },
    },
    models: {
      list: async function* () {
        const defaultModel = process.env.GLM_MODEL || process.env.ZAI_MODEL || 'glm-5.1'
        const models = new Set([defaultModel, 'glm-5.1', 'glm-4.5', 'glm-4.5-air'])
        for (const model of models) {
          yield {
            id: model as 'claude-3-opus-20240229',
            type: 'model',
            created_at: '2024-01-01T00:00:00Z',
            display_name: model,
          }
        }
      },
    },
  }

  logForDebugging(
    `[API:glm] Using OpenAI-compatible GLM client at ${resolveGLMBaseURL(options.baseURL)}`,
  )

  return client as unknown as Anthropic
}
