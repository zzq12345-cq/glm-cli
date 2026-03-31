import { afterEach, describe, expect, mock, test } from 'bun:test'

mock.module('../../../utils/debug.js', () => ({
  logForDebugging: () => {},
  isDebugToStdErr: () => false,
}))

mock.module('../../../utils/json.js', () => ({
  safeParseJSON(json: string | null | undefined): unknown {
    if (!json) {
      return null
    }
    try {
      return JSON.parse(json)
    } catch {
      return null
    }
  },
}))

const { createGLMCompatibilityClient } = await import(
  './glmCompatibilityClient.js'
)

type CapturedRequest = {
  url: string
  body: unknown
  headers: Headers
  init: RequestInit & Record<string, unknown>
}

function createJSONFetch(responseBody: unknown, init?: ResponseInit) {
  let captured: CapturedRequest | null = null

  const fetch: typeof globalThis.fetch = async (input, requestInit) => {
    captured = {
      url: input instanceof Request ? input.url : String(input),
      body: requestInit?.body ? JSON.parse(String(requestInit.body)) : null,
      headers: new Headers(requestInit?.headers),
      init: (requestInit ?? {}) as RequestInit & Record<string, unknown>,
    }

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      ...init,
    })
  }

  return {
    fetch,
    getCapturedRequest: () => captured,
  }
}

function createSSEFetch(chunks: unknown[]) {
  const encoder = new TextEncoder()
  let capturedInit: (RequestInit & Record<string, unknown>) | null = null

  const payload = [
    ...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`),
    'data: [DONE]\n\n',
  ].join('')

  const splitPoint = Math.max(1, Math.floor(payload.length / 2))
  const parts = [payload.slice(0, splitPoint), payload.slice(splitPoint)]

  const fetch: typeof globalThis.fetch = async (_input, requestInit) => {
    capturedInit = (requestInit ?? {}) as RequestInit & Record<string, unknown>
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(encoder.encode(part))
          }
          controller.close()
        },
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
        },
      },
    )
  }

  return {
    fetch,
    getCapturedInit: () => capturedInit,
  }
}

async function createClient(
  fetch: typeof globalThis.fetch,
  fetchOptions?: Record<string, unknown>,
) {
  return createGLMCompatibilityClient({
    apiKey: 'test-glm-key',
    baseURL: 'https://glm.example/api/coding/paas/v4',
    defaultHeaders: {
      'x-test-header': 'glm-test',
    },
    fetch,
    fetchOptions,
    timeout: 5_000,
  })
}

afterEach(() => {
  delete process.env.GLM_MODEL
})

describe('glmCompatibilityClient', () => {
  test('maps Anthropic-style requests to OpenAI-compatible chat completions', async () => {
    const { fetch, getCapturedRequest } = createJSONFetch({
      id: 'resp_1',
      model: 'glm-4.5',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'I will inspect the file.',
            tool_calls: [
              {
                id: 'call_read',
                type: 'function',
                function: {
                  name: 'Read',
                  arguments: '{"path":"src/query.ts"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: {
        prompt_tokens: 17,
        completion_tokens: 9,
        total_tokens: 26,
      },
    })

    const client = await createClient(fetch, {
      proxy: 'http://proxy.internal:8080',
      keepalive: false,
    })
    const response = await client.beta.messages.create({
      model: 'glm-4.5',
      system: 'You are a coding assistant.',
      max_tokens: 128,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Inspect src/query.ts' }],
        },
      ],
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
        },
      ],
      tool_choice: {
        type: 'tool',
        name: 'Read',
      },
    } as never)

    const captured = getCapturedRequest()

    expect(captured?.url).toBe(
      'https://glm.example/api/coding/paas/v4/chat/completions',
    )
    expect(captured?.headers.get('authorization')).toBe('Bearer test-glm-key')
    expect(captured?.headers.get('x-test-header')).toBe('glm-test')
    expect(captured?.init.proxy).toBe('http://proxy.internal:8080')
    expect(captured?.init.keepalive).toBe(false)
    expect(captured?.body).toEqual({
      model: 'glm-4.5',
      messages: [
        {
          role: 'system',
          content: 'You are a coding assistant.',
        },
        {
          role: 'user',
          content: 'Inspect src/query.ts',
        },
      ],
      max_tokens: 128,
      tools: [
        {
          type: 'function',
          function: {
            name: 'Read',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
              },
              required: ['path'],
            },
          },
        },
      ],
      tool_choice: {
        type: 'function',
        function: {
          name: 'Read',
        },
      },
    })

    expect(response.stop_reason).toBe('tool_use')
    expect(response.content).toEqual([
      {
        type: 'text',
        text: 'I will inspect the file.',
      },
      expect.objectContaining({
        type: 'tool_use',
        id: 'call_read',
        name: 'Read',
        input: {
          path: 'src/query.ts',
        },
      }),
    ])
    expect(response.usage.input_tokens).toBe(17)
    expect(response.usage.output_tokens).toBe(9)
  })

  test('streams text and tool-call deltas through the Anthropic event shape', async () => {
    const { fetch, getCapturedInit } = createSSEFetch([
      {
        id: 'chatcmpl_1',
        model: 'glm-4.5',
        choices: [
          {
            delta: {
              content: 'I will inspect the file.',
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 0,
          total_tokens: 12,
        },
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_read',
                  type: 'function',
                  function: {
                    name: 'Read',
                    arguments: '{"path":"src/',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: 'function',
                  function: {
                    arguments: 'query.ts"}',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: 'tool_calls',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 20,
        },
      },
    ])

    const client = await createClient(fetch, {
      dispatcher: { kind: 'proxy-dispatcher' },
    })
    const stream = client.beta.messages.create({
      model: 'glm-4.5',
      max_tokens: 256,
      stream: true,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Inspect src/query.ts' }],
        },
      ],
      tools: [
        {
          name: 'Read',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
          },
        },
      ],
    } as never) as AsyncIterable<Record<string, unknown>>

    const events: Array<Record<string, unknown>> = []
    for await (const event of stream) {
      events.push(event)
    }

    expect(getCapturedInit()?.dispatcher).toEqual({
      kind: 'proxy-dispatcher',
    })

    expect(events.map(event => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])

    expect(events[0]?.message).toEqual(
      expect.objectContaining({
        model: 'glm-4.5',
        stop_reason: null,
      }),
    )
    expect(events[1]).toEqual(
      expect.objectContaining({
        type: 'content_block_start',
        index: 0,
      }),
    )
    expect(events[2]).toEqual(
      expect.objectContaining({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'I will inspect the file.',
        },
      }),
    )
    expect(events[3]).toEqual(
      expect.objectContaining({
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'call_read',
          name: 'Read',
          input: '',
        },
      }),
    )
    expect(events[4]).toEqual(
      expect.objectContaining({
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"path":"src/',
        },
      }),
    )
    expect(events[5]).toEqual(
      expect.objectContaining({
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: 'query.ts"}',
        },
      }),
    )
    expect(events[8]).toEqual(
      expect.objectContaining({
        type: 'message_delta',
        delta: {
          stop_reason: 'tool_use',
          stop_sequence: null,
        },
      }),
    )
  })

  test('provides approximate token counts and exposes the configured model list', async () => {
    process.env.GLM_MODEL = 'glm-4.5-plus'

    const fetch: typeof globalThis.fetch = async () => {
      throw new Error('network should not be used for this test')
    }

    const client = await createClient(fetch)
    const countTokens = await client.beta.messages.countTokens({
      system: 'You are a coding assistant.',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    } as never)

    const modelIds: string[] = []
    for await (const model of client.models.list()) {
      modelIds.push((model as { id: string }).id)
    }

    expect(countTokens.input_tokens).toBeGreaterThan(0)
    expect(modelIds).toEqual(['glm-4.5-plus'])
  })

  test('surfaces non-2xx API responses with status details', async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response('{"error":"invalid api key"}', {
        status: 401,
        statusText: 'Unauthorized',
        headers: {
          'Content-Type': 'application/json',
        },
      })

    const client = await createClient(fetch)

    await expect(
      client.beta.messages.create({
        model: 'glm-4.5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      } as never),
    ).rejects.toThrow(
      'GLM API request failed with 401 Unauthorized: {"error":"invalid api key"}',
    )
  })
})
