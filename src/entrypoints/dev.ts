/**
 * GLM-CLI 开发入口 — 绕过 bun:bundle 编译宏，直接从源码启动
 *
 * 用法: CLAUDE_CODE_USE_GLM=1 GLM_API_KEY=xxx bun run src/entrypoints/dev.ts
 */

// 1. 注入 MACRO 全局变量 (编译时由 bun build --define 注入)
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '2.1.87-glm.1',
  ISSUES_EXPLAINER:
    'report issues at https://github.com/zzq12345-cq/glm-cli/issues',
  VERSION_CHANGELOG: '',
}

// 2. 注册 bun:bundle 的 feature() shim
//    bun:bundle 是 Bun 编译期内置模块，在 `bun run` 模式下不存在。
//    通过 Bun.plugin 将 import { feature } from 'bun:bundle' 重定向到我们的 shim。
Bun.plugin({
  name: 'bun-bundle-shim',
  setup(build) {
    build.module('bun:bundle', () => ({
      exports: {
        feature: (_name: string) => {
          // 在开发模式下: 所有 feature gate 返回 false (安全默认值)，
          // 除了和 GLM 相关的核心路径
          return false
        },
      },
      loader: 'object',
    }))
  },
})

// Mock 所有 @ant/ 内部包，避免运行时报找不到模块
Bun.plugin({
  name: 'mock-internal',
  setup(build) {
    build.onResolve({ filter: /^@ant\/|^@anthropic-ai\/(?!sdk)/ }, (args) => {
      return { path: args.path, namespace: 'mock-internal' }
    })
    build.onLoad({ filter: /.*/, namespace: 'mock-internal' }, () => {
      return {
        contents: 'export default {};',
        loader: 'js',
      }
    })
  },
})

// 3. 启动正式入口
import('./cli.js')
