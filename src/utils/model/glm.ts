import type { ModelKey } from './configs.js'
import type { ModelName } from './model.js'

const DEFAULT_GLM_STRONG_MODEL = 'glm-4.5'
const DEFAULT_GLM_BALANCED_MODEL = 'glm-4.5'
const DEFAULT_GLM_FAST_MODEL = 'glm-4.5-air'

function getEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim()
    if (value) {
      return value
    }
  }
  return undefined
}

export function getDefaultGlmStrongModel(): ModelName {
  return getEnv('GLM_OPUS_MODEL', 'GLM_MODEL', 'ZAI_MODEL') ?? DEFAULT_GLM_STRONG_MODEL
}

export function getDefaultGlmBalancedModel(): ModelName {
  return getEnv('GLM_SONNET_MODEL', 'GLM_MODEL', 'ZAI_MODEL') ?? DEFAULT_GLM_BALANCED_MODEL
}

export function getDefaultGlmFastModel(): ModelName {
  return (
    getEnv('GLM_HAIKU_MODEL', 'GLM_SMALL_FAST_MODEL', 'GLM_FAST_MODEL') ??
    DEFAULT_GLM_FAST_MODEL
  )
}

export function getGlmModelStrings(): Record<ModelKey, string> {
  const fast = getDefaultGlmFastModel()
  const balanced = getDefaultGlmBalancedModel()
  const strong = getDefaultGlmStrongModel()

  return {
    haiku35: fast,
    haiku45: fast,
    sonnet35: balanced,
    sonnet37: balanced,
    sonnet40: balanced,
    sonnet45: balanced,
    sonnet46: balanced,
    opus40: strong,
    opus41: strong,
    opus45: strong,
    opus46: strong,
  }
}
