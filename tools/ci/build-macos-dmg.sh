#!/usr/bin/env bash
set -euo pipefail

# macOS 未公证 DMG 构建：按当前构建机架构生成 ad-hoc 签名的 .app 与拖拽安装 DMG。
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
output="${1:?用法：build-macos-dmg.sh <新独占输出目录>}"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-macos-dmg.sh 必须在 macOS 构建机运行" >&2
  exit 1
fi
if [[ -e "$output" ]]; then
  echo "输出目录已存在：$output" >&2
  exit 1
fi
if [[ -e "$repo_root/apps/desktop/dist/resources" ]]; then
  echo "apps/desktop/dist/resources 已存在；请先确认并移除旧的装配产物" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/codeflow-dmg.XXXXXX")"
trap 'rm -rf "$work"' EXIT
cd "$repo_root"

pnpm -C packages/shared build
pnpm -C apps/desktop/client build
pnpm -C apps/desktop build
pnpm -C apps/web build

# 临时安装固定 npm 运行时，prepare-resources 会把它打进桌面资源。
npm install --prefix "$work/npm12" --no-package-lock --no-fund --no-audit npm@12.2.2

# 生成带 node_modules 的 Client 归档；根目录必须是 package/。
# hoisted 布局避免 pnpm 默认 symlink 自引用导致系统 tar 报错。
mkdir -p "$work/client-pack"
pnpm --filter @codeflowai/client deploy --prod --legacy --node-linker=hoisted "$work/client-pack/package"
tar -czf "$work/client.tgz" -C "$work/client-pack" package

node tools/ci/prepare-macos-resources.mjs "$work/client.tgz" "$work/npm12/node_modules/npm" "$work"

pnpm -C apps/desktop package:local:mac -- \
  "$repo_root/apps/desktop/dist/resources" "$output" --require-baseline-proof --target dmg
shasum -a 256 "$output"/*.dmg | tee "$output/SHA256SUMS"
