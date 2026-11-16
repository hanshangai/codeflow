import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { resolveClientBuildVersion } from "./build-version.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(scriptDir, "..");
const distDir = path.join(clientDir, "dist");
const buildTarget = String(process.env.CODEFLOWAI_CLIENT_BUILD_TARGET ?? "").trim().toLowerCase();
const repoRootDir = path.resolve(clientDir, "..", "..", "..");

fs.mkdirSync(distDir, { recursive: true });
const startupCapabilityPath = path.join(distDir, "desktop-startup-capability.json");
// 旧声明不能跨过本次构建失败，全部入口成功后才重新发布。
fs.rmSync(startupCapabilityPath, { force: true });
const bundledVersion = resolveClientBuildVersion(
  JSON.parse(fs.readFileSync(path.join(repoRootDir, "package.json"), "utf8")).version,
  process.env.CODEFLOWAI_CLIENT_BUILD_VERSION,
);

/** 按打包目标生成 client 包内默认 Server 地址。 */
function resolveBuiltDefaultServerWs(target) {
  if (target === "prod") return "wss://codeflow.hanshangai.com/ws/client";
  if (target === "test") return "wss://codeflow-test.hanshangai.com/ws/client";
  return "ws://127.0.0.1:39280/ws/client";
}

const commonBuildOptions = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: ["node22"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  treeShaking: true,
  charset: "utf8",
  tsconfig: path.join(clientDir, "tsconfig.json"),
  mainFields: ["module", "main"],
  conditions: ["node", "import", "default"],
  logLevel: "info",
};

// 校验器与运行时共用同一完整图边界，静态资源按原字节进入 Client payload。
const builtinValidatorPath = path.join(distDir, "orchAssetBundleValidation.cjs");
await build({
  ...commonBuildOptions,
  entryPoints: [path.join(clientDir, "src/orchestration/orchAssetBundleValidation.ts")],
  outfile: builtinValidatorPath,
});
const { readDesktopBuiltinAssetBundles } = createRequire(import.meta.url)(builtinValidatorPath);
// Client 包自带内置资产；构建只从 Client 资产目录复制，避免依赖 Server 源码。
const builtinSourceDir = path.join(clientDir, "assets", "orchestration-builtin");
readDesktopBuiltinAssetBundles(builtinSourceDir);
const builtinOutputDir = path.join(distDir, "orchestration-builtin");
fs.mkdirSync(builtinOutputDir, { recursive: true });
for (const entry of fs.readdirSync(builtinSourceDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
    fs.copyFileSync(path.join(builtinSourceDir, entry.name), path.join(builtinOutputDir, entry.name));
  }
}
readDesktopBuiltinAssetBundles(builtinOutputDir);

await build({
  ...commonBuildOptions,
  entryPoints: [path.join(clientDir, "src/index.ts")],
  outfile: path.join(distDir, "index.cjs"),
  external: [
    "node-pty",
    "@napi-rs/keyring",
    "pino",
    "pino-roll",
    "word-extractor",
    "unpdf",
    "ppt-codec",
  ],
  define: {
    "process.env.CODEFLOWAI_BUILD_DEFAULT_SERVER_WS": JSON.stringify(resolveBuiltDefaultServerWs(buildTarget)),
    CODEFLOWAI_BUNDLED_VERSION: JSON.stringify(bundledVersion),
  },
});

await build({
  ...commonBuildOptions,
  entryPoints: [path.join(clientDir, "src/clientDaemonSupervisor.ts")],
  outfile: path.join(distDir, "clientDaemonSupervisor.cjs"),
  external: ["pino", "pino-roll"],
  define: {
    CODEFLOWAI_BUNDLED_VERSION: JSON.stringify(bundledVersion),
  },
});

await build({
  ...commonBuildOptions,
  entryPoints: [path.join(clientDir, "src/fs/workspacePathIndexWorker.ts")],
  outfile: path.join(distDir, "workspacePathIndexWorker.cjs"),
});

await build({
  ...commonBuildOptions,
  entryPoints: [path.join(clientDir, "src/fs/documentAttachmentWorker.ts")],
  outfile: path.join(distDir, "documentAttachmentWorker.cjs"),
  external: ["word-extractor", "unpdf", "ppt-codec"],
});

await build({
  ...commonBuildOptions,
  entryPoints: [path.join(clientDir, "src/db/clientDbReaderWorker.ts")],
  outfile: path.join(distDir, "clientDbReaderWorker.cjs"),
});

await build({
  ...commonBuildOptions,
  entryPoints: [path.join(clientDir, "src/db/clientDbWriterWorker.ts")],
  outfile: path.join(distDir, "clientDbWriterWorker.cjs"),
  external: ["pino", "pino-roll"],
});

await build({
  ...commonBuildOptions,
  entryPoints: [path.join(clientDir, "src/workspace-migration/workspaceMigrationFileWorker.ts")],
  outfile: path.join(distDir, "workspaceMigrationFileWorker.cjs"),
});

await build({
  ...commonBuildOptions,
  entryPoints: [path.join(clientDir, "src/desktopUninstallWorker.ts")],
  outfile: path.join(distDir, "desktopUninstallWorker.cjs"),
  external: ["@napi-rs/keyring", "pino", "pino-roll"],
});

await build({
  ...commonBuildOptions,
  entryPoints: [path.join(clientDir, "src/legacy-migration/legacyClientMigrationWorker.ts")],
  outfile: path.join(distDir, "legacyClientMigrationWorker.cjs"),
  external: ["pino", "pino-roll"],
});

fs.writeFileSync(startupCapabilityPath, `${JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1,
  clientEntrySha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(distDir, "index.cjs"))).digest("hex"),
})}\n`, { encoding: "utf8", flag: "wx" });
