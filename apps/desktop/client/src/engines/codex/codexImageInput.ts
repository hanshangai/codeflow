import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";

import type { WorkspaceId } from "@codeflowai/shared";
import { writeEngineWorkspaceLog, type EngineWorkspaceLogWriter } from "../threadSession.js";
import type { WorkspaceLogEntry } from "../../logger.js";
import { summarizeImageInputs } from "../../diagnostics/imageInputDiagnostics.js";
import {
  assertWorkspaceCodeflowaiDirectory,
  ensureWorkspaceCodeflowaiDirectory,
  inspectWorkspaceCodeflowaiFile,
  isWorkspaceCodeflowaiFileDeviceMatch,
  type WorkspaceCodeflowaiDirectoryIdentity,
} from "../../codeflowai/workspaceCodeflowaiDirectory.js";
import { ensureWorkspacePrivateRuntimeGitExclude } from "../../git/workspacePrivateRuntimeGitExclude.js";

export type CodexImageInputLogContext = {
  workspacePath: string;
  workspaceId: string;
  threadId: string;
  clientTurnId: string;
  operation: "turn/start" | "turn/steer";
  writeWorkspaceLog: EngineWorkspaceLogWriter;
};

type PreparedImages = {
  /** 准备及释放共用的图片请求标识。 */
  requestId: string;
  /** 传给 Codex app-server 的 images（data URL 会被落盘为本地路径）。 */
  images: string[];
  /** 本次输入实际创建的临时文件数量。 */
  temporaryImageCount: number;
  /** 只释放本次图片；失败显式抛出，重复调用不隐式重试。 */
  cleanup: (reason?: string) => void;
};

type PreparingImage = { file: string; directory: WorkspaceCodeflowaiDirectoryIdentity; identity: fs.Stats | null; closed: boolean };

/**
 * Codex app-server 图片输入适配：
 * - Web 侧上传图片通常是 `data:image/...;base64,...`，Codex 对 data URL 支持不稳定；
 * - 仅 data URL 在可信工作区 .codeflowai 独占落盘，改走 `localImage` 输入。
 * - 返回前失败只回收本次独占创建的文件；成功后沿原 provider lease 释放。
 */
export function prepareCodexImagesForTurn(
  images: string[],
  context: CodexImageInputLogContext,
): PreparedImages {
  const { workspacePath, writeWorkspaceLog, ...logContext } = context;
  const out: string[] = [];
  const tempFiles: PreparingImage[] = [];
  let missingLocalPathCount = 0;
  const hasImageInput = images.length > 0;
  const imageLeaseId = crypto.randomUUID();
  let imageIndex: number | null = null;
  let releaseFailure: Error | null = null;
  let released = false;
  let directory: WorkspaceCodeflowaiDirectoryIdentity | null = null;
  /** 图片lease沿已核W记录，描述/固定写失败仍交原prepare/cleanup错误owner。 */
  const log = (level: WorkspaceLogEntry["level"], message: string, data: () => Record<string, unknown>): void =>
    writeEngineWorkspaceLog(writeWorkspaceLog, context.workspaceId as WorkspaceId, () => ({ level, tag: "codex-image-input", message,
      data: { requestId: `codex-image:${imageLeaseId}`, ...data() } }));

  try {
    if (hasImageInput) {
      log("info", "Codex image input received", () => ({
        code: "codex_image_input_received",
        imageLeaseId,
        ...logContext,
        ...summarizeImageInputs(images),
      }));
    }

    for (const [index, img] of images.entries()) {
      imageIndex = index;
      const raw = String(img ?? "").trim();
      if (!raw) continue;

      const parsed = parseDataUrl(raw);
      if (!parsed) {
        if (raw.startsWith("data:")) {
          log("warn", "Codex image data URL is malformed", () => ({
            code: "codex_image_data_url_malformed",
            imageLeaseId,
            ...logContext,
            imageIndex: index,
          }));
        } else if (!/^https?:\/\//i.test(raw) && !fs.existsSync(raw)) {
          missingLocalPathCount += 1;
          log("warn", "Codex local image path is missing", () => ({
            code: "codex_local_image_path_missing",
            imageLeaseId,
            ...logContext,
            imageIndex: index,
          }));
        }
        out.push(raw);
        continue;
      }

      const ext = guessImageExt(parsed.mediaType);
      directory ??= ensureWorkspaceCodeflowaiDirectory(workspacePath);
      const fileName = `codeflowai-codex-img-${imageLeaseId}-${index}${ext}`;
      ensureWorkspacePrivateRuntimeGitExclude(workspacePath, [fileName]);
      assertWorkspaceCodeflowaiDirectory(directory);
      const file = path.join(directory.directoryPath, fileName);
      const buf = Buffer.from(parsed.base64Data, "base64");
      const fd = fs.openSync(file, "wx");
      const owned: PreparingImage = { file, directory, identity: null, closed: false };
      tempFiles.push(owned);
      let writeFailed = false, writeError: unknown;
      try {
        owned.identity = fs.fstatSync(fd);
        assertPreparedImageIdentity(owned);
        fs.writeFileSync(fd, buf);
        assertPreparedImageIdentity(owned);
      }
      catch (error) { writeFailed = true; writeError = error; }
      try { fs.closeSync(fd); owned.closed = true; }
      catch (closeError) {
        if (writeFailed) throw new AggregateError([writeError, closeError], "Codex 图片写入及关闭均失败", { cause: writeError });
        throw closeError;
      }
      if (writeFailed) throw writeError;
      assertPreparedImageIdentity(owned);
      log("info", "Codex temporary image created", () => ({
        code: "codex_image_temp_file_created",
        imageLeaseId,
        ...logContext,
        imageIndex: index,
        mediaType: parsed.mediaType,
        byteLength: buf.byteLength,
      }));
      out.push(file);
    }

    if (hasImageInput) {
      log("info", "Codex image input prepared", () => ({
        code: "codex_image_input_prepared",
        imageLeaseId,
        ...logContext,
        preparedImageCount: out.length,
        temporaryImageCount: tempFiles.length,
        missingLocalPathCount,
      }));
    }
    for (const owned of tempFiles) assertPreparedImageIdentity(owned);
  } catch (error) {
    const cleanupErrors: unknown[] = [], retainedFiles: string[] = [];
    for (const owned of tempFiles) {
      if (!owned.closed) { retainedFiles.push(owned.file); continue; }
      try {
        assertPreparedImageIdentity(owned);
        fs.unlinkSync(owned.file);
      } catch (cleanupError) { cleanupErrors.push(cleanupError); retainedFiles.push(owned.file); }
    }
    const code = retainedFiles.length > 0 ? "codex_image_preparation_cleanup_failed" : "codex_image_preparation_failed";
    const requestId = `codex-image:${imageLeaseId}`;
    const message = `Codex 图片准备失败，尚未发送输入（requestId=${requestId}）${retainedFiles.length > 0 ? "；临时图片未全部释放，请按日志核查现场" : ""}`;
    const failure = Object.assign(cleanupErrors.length > 0
      ? new AggregateError([error, ...cleanupErrors], message, { cause: error })
      : new Error(message, { cause: error }), { code });
    try {
      log("error", "Codex image preparation failed", () => ({
        code, errorCode: code, requestId, imageLeaseId, ...logContext, imageIndex,
        event: { category: "engine", action: "image_prepare", outcome: "fail" },
        rootCause: imagePreparationCause(error), cleanupCauses: cleanupErrors.map(cause => imagePreparationCause(cause)),
        retainedFiles, unconfirmedCloseCount: tempFiles.filter(owned => !owned.closed).length,
      }));
    } catch (loggingError) {
      throw Object.assign(new AggregateError([failure, loggingError], message, { cause: failure }), { code });
    }
    throw failure;
  }

  return {
    requestId: `codex-image:${imageLeaseId}`,
    images: out,
    temporaryImageCount: tempFiles.length,
    cleanup: (reason = "unspecified") => {
      if (releaseFailure) throw releaseFailure;
      if (released) return;
      released = true;
      const cleanupErrors: unknown[] = [], retainedFiles: string[] = [];
      for (const owned of tempFiles) {
        try {
          assertPreparedImageIdentity(owned);
          fs.unlinkSync(owned.file);
        } catch (error) {
          cleanupErrors.push(error);
          retainedFiles.push(owned.file);
        }
      }
      if (cleanupErrors.length === 0) return;
      const code = "codex_image_cleanup_failed", requestId = `codex-image:${imageLeaseId}`;
      const message = `Codex 临时图片未全部释放（requestId=${requestId}）；原操作可能已生效，请按日志人工核查，勿自动重跑`;
      releaseFailure = Object.assign(cleanupErrors.length > 1
        ? new AggregateError(cleanupErrors, message, { cause: cleanupErrors[0] })
        : new Error(message, { cause: cleanupErrors[0] }), { code, requestId });
      try {
        log("error", "Codex temporary image cleanup failed", () => ({
          code, errorCode: code, requestId, imageLeaseId, ...logContext,
          event: { category: "engine", action: "image_cleanup", outcome: "fail" },
          cleanupReason: reason, retainedFiles, retryable: false,
          cleanupCauses: cleanupErrors.map(error => imagePreparationCause(error)),
        }));
      } catch (loggingError) {
        releaseFailure = Object.assign(new AggregateError([releaseFailure, loggingError], message, { cause: releaseFailure }), { code, requestId });
      }
      throw releaseFailure;
    },
  };
}

/** 路径、工作区目录及已捕获 fd 必须仍指向本次独占普通图片，异常时保留现场。 */
function assertPreparedImageIdentity(owned: PreparingImage): void {
  const identity = owned.identity;
  if (!identity || !identity.isFile() || identity.nlink !== 1) {
    throw Object.assign(new Error("Codex 临时图片身份变化，保留现场"), { code: "codex_image_temp_identity_changed" });
  }
  const current = inspectWorkspaceCodeflowaiFile(owned.directory, path.basename(owned.file));
  if (!current || !isWorkspaceCodeflowaiFileDeviceMatch(identity.dev, current.dev) || current.ino !== identity.ino) {
    throw Object.assign(new Error("Codex 临时图片身份变化，保留现场"), { code: "codex_image_temp_identity_changed" });
  }
}

/** 有界记录包装根因和系统诊断字段，不记录图片、data URL 或异常私文。 */
function imagePreparationCause(error: unknown, depth = 0): Record<string, unknown> {
  if (error === null || typeof error !== "object" && typeof error !== "function") return { name: "NonError" };
  const fields = Object.getOwnPropertyDescriptors(error), result: Record<string, unknown> = {
    name: types.isNativeError(error) && Object.getPrototypeOf(error) === AggregateError.prototype ? "AggregateError" : "Error",
  };
  for (const key of ["name", "code", "syscall"]) {
    const field = fields[key];
    if (field && "value" in field && typeof field.value === "string") result[key] = field.value;
  }
  if (depth < 2) {
    if (fields.cause && "value" in fields.cause) result.cause = imagePreparationCause(fields.cause.value, depth + 1);
    const errors = fields.errors && "value" in fields.errors ? fields.errors.value : undefined;
    if (Array.isArray(errors)) {
      const entries = Object.getOwnPropertyDescriptors(errors) as unknown as Record<string, PropertyDescriptor>, causes: unknown[] = [];
      for (let index = 0; index < Math.min(Number(entries.length?.value ?? 0), 10); index++) {
        const entry = entries[String(index)];
        if (entry && "value" in entry) causes.push(imagePreparationCause(entry.value, depth + 1));
      }
      result.errors = causes;
    }
  }
  return result;
}

function parseDataUrl(dataUrl: string): { mediaType: string; base64Data: string } | null {
  if (!dataUrl.startsWith("data:")) return null;
  const idx = dataUrl.indexOf(",");
  if (idx < 0) return null;
  const head = dataUrl.slice(5, idx);
  const base64Data = dataUrl.slice(idx + 1).trim();
  if (!/;base64$/i.test(head)) return null;
  const mediaType = head.replace(/;base64$/i, "").trim() || "image/png";
  if (!base64Data) return null;
  return { mediaType, base64Data };
}

function guessImageExt(mediaType: string): string {
  const mt = String(mediaType ?? "").toLowerCase();
  if (mt.includes("png")) return ".png";
  if (mt.includes("jpeg") || mt.includes("jpg")) return ".jpg";
  if (mt.includes("gif")) return ".gif";
  if (mt.includes("webp")) return ".webp";
  if (mt.includes("bmp")) return ".bmp";
  return ".png";
}
