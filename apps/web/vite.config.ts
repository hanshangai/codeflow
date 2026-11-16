import { defineConfig, loadEnv, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";
import { copyFileSync, existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { parseEnv } from "node:util";

function disableConditionalCacheInDev(): Plugin {
  return {
    name: "disable-conditional-cache-in-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // 避免浏览器发起条件请求后命中本地损坏缓存导致 ERR_CACHE_READ_FAILURE。
        delete req.headers["if-none-match"];
        delete req.headers["if-modified-since"];

        const originalSetHeader = res.setHeader.bind(res);
        res.setHeader = ((name: string, value: number | string | readonly string[]) => {
          if (name.toLowerCase() === "etag" || name.toLowerCase() === "last-modified") {
            return res;
          }
          return originalSetHeader(name, value);
        }) as typeof res.setHeader;

        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        next();
      });
    },
  };
}

/** 将发布目标生成的 SEO 文件写入 dist，避免测试构建改写仓库内生产 SEO 文件。 */
function copyReleaseSeoAssets(): Plugin {
  return {
    name: "copy-release-seo-assets",
    apply: "build",
    closeBundle() {
      const generatedRoot = String(process.env.CODEFLOWAI_SEO_OUTPUT_DIR || "").trim();
      if (!generatedRoot) return;
      const distDir = resolve(__dirname, "dist");
      for (const fileName of ["robots.txt", "sitemap.xml"]) {
        const sourceFile = resolve(generatedRoot, "public", fileName);
        if (!existsSync(sourceFile)) {
          throw new Error(`缺少发布目标 SEO 文件：${sourceFile}`);
        }
        copyFileSync(sourceFile, resolve(distDir, fileName));
      }
    },
  };
}

/** 原始文件赋值与合并结果均拒绝退役配置，空环境覆盖不能隐藏错误。 */
function assertOfficialDeploymentEnv(env: Record<string, string | undefined>): void {
  const removed = ["VITE_CODEFLOWAI_EDITION", "CODEFLOWAI_RELEASE_EDITION", "CODEFLOWAI_EDITION", "AIDT_EDITION"]
    .filter(key => String(env[key] ?? "").trim());
  if (removed.length) throw new Error("Customer deployment settings were removed; remove: " + removed.join(", "));
}

/** Web 工程配置；dev 读取本地 env，release build 由发布脚本注入目标 VITE_*。 */
export default defineConfig(({ command, mode }) => {
  const envDir = command === "serve" ? resolve(__dirname, "../../env") : __dirname;
  for (const file of [".env", ".env.local", ".env." + mode, ".env." + mode + ".local"]) {
    const filePath = resolve(envDir, file);
    if (existsSync(filePath)) assertOfficialDeploymentEnv(parseEnv(readFileSync(filePath, "utf8")));
  }
  assertOfficialDeploymentEnv(loadEnv(mode, envDir, ""));
  return {
  ...(command === "serve" ? { envDir } : {}),
  plugins: [vue(), disableConditionalCacheInDev(), copyReleaseSeoAssets()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    // 允许 localhost 解析到 IPv6(::1) 时也能访问本地调试页。
    host: "::",
    allowedHosts: ["codeflowai.cn", "codeflow.hanshangai.com", "test.hanshangai.com"],
    port: 39281,
    strictPort: true,
  },
  optimizeDeps: {
    include: ["monaco-editor/esm/vs/editor/editor.api"],
  },
};
});

