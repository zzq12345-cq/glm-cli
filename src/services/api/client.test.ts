import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let proxyFetchOptions: Record<string, unknown> = {}

mock.module('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    constructor(_args?: unknown) {}
  },
}))

mock.module('src/utils/auth.js', () => ({
  checkAndRefreshOAuthTokenIfNeeded: async () => {},
  getAnthropicApiKey: () => 'anthropic-test-key',
  getApiKeyFromApiKeyHelper: async () => null,
  getClaudeAIOAuthTokens: () => null,
  isClaudeAISubscriber: () => false,
  refreshAndGetAwsCredentials: async () => null,
  refreshGcpCredentialsIfNeeded: async () => {},
}))

mock.module('src/utils/http.js', () => ({
  getUserAgent: () => 'glm-cli-test',
}))

mock.module('src/utils/model/model.js', () => ({
  getSmallFastModel: () => 'claude-haiku-test',
}))

mock.module('src/utils/model/providers.js', () => ({
  getAPIProvider: () =>
    process.env.CLAUDE_CODE_USE_GLM ? 'glm' : 'firstParty',
  isFirstPartyAnthropicBaseUrl: () => true,
}))

mock.module('src/utils/proxy.js', () => ({
  getProxyFetchOptions: () => proxyFetchOptions,
}))

mock.module('../../bootstrap/state.js', () => ({
  getIsNonInteractiveSession: () => false,
  getSessionId: () => 'session-test-id',
}))

mock.module('../../constants/oauth.js', () => ({
  getOauthConfig: () => ({
    BASE_API_URL: 'https://oauth.example',
  }),
}))

mock.module('../../utils/debug.js', () => ({
  isDebugToStdErr: () => false,
  logForDebugging: () => {},
}))

mock.module('../../utils/json.js', () => ({
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

mock.module('../../utils/envUtils.js', () => ({
  getAWSRegion: () => 'us-east-1',
  getVertexRegionForModel: () => 'us-central1',
  isEnvTruthy: (value: string | undefined) => value === '1' || value === 'true',
}))

const { getAnthropicClient } = await import('./client.js')

beforeEach(() => {
  proxyFetchOptions = {
    proxy: 'http://proxy.internal:8080',
    keepalive: false,
  }
  process.env.CLAUDE_CODE_USE_GLM = '1'
  process.env.GLM_BASE_URL = 'https://glm.example/v4'
  delete process.env.ZAI_BASE_URL
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_USE_GLM
  delete process.env.GLM_BASE_URL
  delete process.env.ZAI_BASE_URL
})

describe('api client GLM wiring', () => {
  test('selects the GLM client path when CLAUDE_CODE_USE_GLM is enabled', async () => {
    let captured:
      | {
          url: string
          init: RequestInit & Record<string, unknown>
        }
      | undefined

    const fetchOverride: typeof globalThis.fetch = async (input, init) => {
      captured = {
        url: input instanceof Request ? input.url : String(input),
        init: (init ?? {}) as RequestInit & Record<string, unknown>,
      }

      return new Response(
        JSON.stringify({
          id: 'resp_1',
          model: 'glm-4.5',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }

    const client = await getAnthropicClient({
      apiKey: 'glm-test-key',
      maxRetries: 2,
      fetchOverride,
      source: 'unit_test',
    })

    const response = await client.beta.messages.create({
      model: 'glm-4.5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'ping' }],
    } as never)

    expect(response.content).toEqual([
      {
        type: 'text',
        text: 'ok',
      },
    ])
    expect(captured?.url).toBe('https://glm.example/v4/chat/completions')
    expect(captured?.init.proxy).toBe('http://proxy.internal:8080')
    expect(captured?.init.keepalive).toBe(false)
    const headers = new Headers(captured?.init.headers)
    expect(headers.get('authorization')).toBe('Bearer glm-test-key')
    expect(headers.get('user-agent')).toBe('glm-cli-test')
    expect(headers.get('x-claude-code-session-id')).toBe('session-test-id')
    expect(headers.get('x-app')).toBe('cli')
  })

  test('forwards updated proxy fetch options into the GLM request init', async () => {
    proxyFetchOptions = {
      dispatcher: {
        kind: 'proxy-dispatcher',
      },
      keepalive: false,
    }

    let capturedInit: (RequestInit & Record<string, unknown>) | undefined

    const fetchOverride: typeof globalThis.fetch = async (_input, init) => {
      capturedInit = (init ?? {}) as RequestInit & Record<string, unknown>
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }

    const client = await getAnthropicClient({
      apiKey: 'glm-test-key',
      maxRetries: 1,
      fetchOverride,
      source: 'unit_test',
    })

    await client.beta.messages.create({
      model: 'glm-4.5',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    } as never)

    expect(capturedInit?.dispatcher).toEqual({
      kind: 'proxy-dispatcher',
    })
    expect(capturedInit?.keepalive).toBe(false)
  })
})
