#!/usr/bin/env sh
# OpenCode → DeepSeek Harness 本地桥接器（macOS / Linux 启动脚本）
set -eu
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。请先安装 Node.js >= 18.17：https://nodejs.org/" >&2
  exit 1
fi

exec node bin.mjs start "$@"
