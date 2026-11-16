import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  DOCUMENT_ATTACHMENT_LARGE_FILE_THRESHOLD_BYTES,
  DOCUMENT_ATTACHMENT_LIMITS,
  resolveDocumentAttachmentTimeoutMs,
} from "@codeflowai/shared";

let activeWorkers = 0;

/** 限制并行数与处理时长；maxSourceBytes 由工作区策略限制。 */
export async function extractDocumentAttachmentInWorker(
  fileName: string,
  base64: string,
  maxSourceBytes: number = DOCUMENT_ATTACHMENT_LIMITS.maxSourceBytes,
): Promise<string> {
  if (activeWorkers >= 2) throw Object.assign(new Error("文档解析繁忙，请稍后重试"), { code: "RATE_LIMITED" });
  // base64 解码和重编码放到 Worker，避免大文件在 Client 主线程生成多份完整副本。
  const worker = createDocumentWorker({ fileName, base64, maxSourceBytes });
  activeWorkers++;
  const sourceBytes = Math.max(0, Math.floor(base64.length * 3 / 4));
  const timeoutMs = resolveDocumentAttachmentTimeoutMs(sourceBytes);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failure: unknown;
  let failed = false;
  try {
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("文档解析超时，请拆分文件后重试"), { code: "TIMEOUT" })), timeoutMs);
      worker.once("message", (reply: { ok?: boolean; text?: unknown; message?: string }) => {
        if (reply.ok === true && typeof reply.text === "string") resolve(reply.text);
        else reject(Object.assign(new Error(reply.message || "文档解析 Worker 返回无效结果"), { code: "BAD_REQUEST" }));
      });
      worker.once("error", (error) => reject(Object.assign(new Error("文档解析 Worker 异常", { cause: error }), { code: "INTERNAL_ERROR" })));
      worker.once("exit", (code) => reject(Object.assign(new Error(`文档解析 Worker 未返回结果便退出：${code}`), { code: "INTERNAL_ERROR" })));
    });
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    clearTimeout(timer);
    try { await worker.terminate(); }
    catch (cleanupError) {
      throw Object.assign(new Error("文档解析 Worker 清理失败", {
        cause: failed ? new AggregateError([failure, cleanupError], "文档解析及清理失败", { cause: failure }) : cleanupError,
      }), { code: "INTERNAL_ERROR" });
    }
    finally { activeWorkers--; }
  }
}

/** 发布态仅加载配套 Worker；开发态沿用项目现有 tsx Worker 引导方式。 */
function createDocumentWorker(workerData: { fileName: string; base64: string; maxSourceBytes: number }): Worker {
  const bundledFile = typeof __filename === "string" ? __filename : "";
  const candidates = bundledFile ? [path.join(path.dirname(bundledFile), "documentAttachmentWorker.cjs")] : [
    path.resolve(process.cwd(), "apps/desktop/client/src/fs/documentAttachmentWorker.ts"),
    path.resolve(process.cwd(), "src/fs/documentAttachmentWorker.ts"),
  ];
  const workerPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!workerPath) throw Object.assign(new Error("找不到文档解析 Worker，请安装完整 Client 包"), { code: "INTERNAL_ERROR" });
  // 大文件需要额外的 base64、Buffer、校验字符串和解析结构。
  const heapMb = workerData.maxSourceBytes > DOCUMENT_ATTACHMENT_LARGE_FILE_THRESHOLD_BYTES ? 512 : 256;
  const options = { workerData, resourceLimits: { maxOldGenerationSizeMb: heapMb } };
  if (workerPath.endsWith(".cjs")) return new Worker(pathToFileURL(workerPath), options);
  const require = createRequire(path.resolve(process.cwd(), "package.json"));
  const bootstrap = `import { tsImport } from ${JSON.stringify(pathToFileURL(require.resolve("tsx/esm/api")).href)}; await tsImport(${JSON.stringify(pathToFileURL(workerPath).href)}, import.meta.url);`;
  return new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
    ...options, execArgv: ["--conditions", "development"],
  });
}
