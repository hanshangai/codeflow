import { parentPort, workerData } from "node:worker_threads";
import { decodeDocumentAttachment, extractDocumentAttachment } from "./documentAttachmentExtractor.js";

if (!parentPort) throw new Error("文档解析 Worker 缺少父线程");
const port = parentPort;

/** 每个 Worker 只处理一个文件；成功或失败都显式响应并释放消息端口。 */
async function run(): Promise<void> {
  const { fileName, base64, maxSourceBytes } = workerData as {
    fileName: string;
    base64: string;
    maxSourceBytes: number;
  };
  try {
    const bytes = decodeDocumentAttachment(fileName, base64, maxSourceBytes);
    const text = await extractDocumentAttachment(fileName, bytes, maxSourceBytes);
    port.postMessage({ ok: true, text });
  } catch (error) {
    port.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
  } finally {
    port.close();
  }
}

void run();
