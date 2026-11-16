#!/usr/bin/env node

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 16;
const RECOMMENDED_NODE_VERSION = "22.17.1";
const REQUIREMENT_TEXT = "Node.js >=22.16.0 且 <23（推荐 22.17.1），或 Node.js 24.x";

/** 校验 npm 安装阶段的 Node 运行时，避免新包替换成功后才在启动阶段失败。 */
function isSupportedNodeVersion(raw = process.versions.node) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(String(raw ?? "").trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR) || major === 24;
}

if (!isSupportedNodeVersion()) {
  console.error(`[CLIENT_NODE_VERSION_UNSUPPORTED] 当前 Node.js ${process.version} 不满足 CodeFlow Client 要求：${REQUIREMENT_TEXT}。`);
  console.error("请先升级 Node.js，再重新执行安装：");
  console.error(`  nvm install ${RECOMMENDED_NODE_VERSION}`);
  console.error(`  nvm alias default ${RECOMMENDED_NODE_VERSION}`);
  console.error(`  nvm use ${RECOMMENDED_NODE_VERSION}`);
  console.error("  node -v");
  process.exit(23);
}
