#!/bin/bash
# GLM-CLI 启动脚本
# 用法:
#   ./glm-cli.sh                      -- 交互模式
#   ./glm-cli.sh -p "修复这个 bug"     -- 非交互模式
#   ./glm-cli.sh --version            -- 查看版本
#
# 必须设置环境变量:
#   GLM_API_KEY    - 你的 GLM API 密钥
#   GLM_BASE_URL   - GLM API 地址 (可选，有默认值)
#   GLM_MODEL      - 使用的模型 (可选，默认 glm-4.5)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 强制启用 GLM provider
export CLAUDE_CODE_USE_GLM=1

# 检查 GLM_API_KEY
if [ -z "${GLM_API_KEY:-}" ] && [ -z "${ZAI_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "错误: 未设置 API 密钥。请设置以下环境变量之一:"
  echo "  export GLM_API_KEY=你的密钥"
  echo "  export ZAI_API_KEY=你的密钥"
  exit 1
fi

# 检查 bun 是否可用
if ! command -v bun &>/dev/null; then
  echo "错误: 未找到 bun 运行时。请先安装: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

exec bun run "${SCRIPT_DIR}/src/entrypoints/dev.ts" "$@"
