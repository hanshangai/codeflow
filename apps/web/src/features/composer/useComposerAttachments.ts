import { ref, watch, type ComputedRef } from "vue";
import { message } from "ant-design-vue";
import {
  formatByteSize,
  DOCUMENT_ATTACHMENT_LIMITS,
  isDocumentAttachmentName,
  INLINE_ATTACHMENT_LIMITS,
  measureTextFileAttachmentBytes,
  type TextFileAttachment,
  validateInlineThreadPayload,
} from "@codeflowai/shared";
import {
  collectClipboardFileReferenceUrls,
  resolveOversizedFileReferenceUrl,
} from "./oversized-file-reference";

export type ImageAttachment = { id: string; name: string; dataUrl: string; size: number };

/**
 * 管理 Composer 附件：图片、文本和提取文字后的 Office/PDF。
 * - 仅负责浏览器侧选择/读取/校验/预览，不涉及引擎协议。
 * - 文本文件不允许截断：超限直接拒绝，避免语义二义性。
 */
export function useComposerAttachments(opts: {
  canAdd: ComputedRef<boolean>;
  /** 是否允许图片（由模型/引擎能力决定；unknown 时可先允许并在发送侧兜底）。 */
  allowImages?: ComputedRef<boolean>;
  /** 是否允许文本文件（默认 true）。 */
  allowTextFiles?: ComputedRef<boolean>;
  /** 会话/账号范围变化时取消旧读取结果，避免附件跨会话串用。 */
  scopeKey?: ComputedRef<string>;
  /** 文档由 Client 解析，返回完整文字；调用失败必须拒绝。 */
  extractDocument?: (file: File, base64: string) => Promise<string>;
  /** 文件超出内联上限时，把可取得的完整 URL 交给输入框追加。 */
  onOversizedFileReference?: (referenceUrl: string, file: File) => void;
}) {
  const imageAttachments = ref<ImageAttachment[]>([]);
  const textFileAttachments = ref<TextFileAttachment[]>([]);
  const fileInputEl = ref<HTMLInputElement | null>(null);
  const pendingReads = ref(0);
  let readGeneration = 0;

  /** 使旧会话的异步结果失效；在切换草稿和清空附件时调用。 */
  function invalidateAttachmentReads(): void {
    readGeneration++;
    pendingReads.value = 0;
  }
  if (opts.scopeKey) watch(opts.scopeKey, invalidateAttachmentReads, { flush: "sync" });

  const previewFile = ref<TextFileAttachment | null>(null);
  const previewOpen = ref(false);

  function randomId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function readFileAsDataUrl(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("读取文件失败"));
      reader.readAsDataURL(file);
    });
  }

  /** 读取文本附件，优先严格 UTF-8，失败后按 GB18030/GBK 兼容中文本地文件。 */
  async function readFileAsText(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    return decodeTextAttachmentBuffer(buffer);
  }

  async function prepareImageAttachment(
    file: File,
    sourceLimit: number,
  ): Promise<{ dataUrl: string; size: number; compressed: boolean }> {
    if (file.size > sourceLimit) {
      throw new Error(`图片文件过大：${file.name}（最大 ${formatByteSize(sourceLimit)}）`);
    }
    if (file.size <= INLINE_ATTACHMENT_LIMITS.maxImageBytes) {
      return { dataUrl: await readFileAsDataUrl(file), size: file.size, compressed: false };
    }
    if (isImageCompressionUnsupported(file)) {
      throw new Error(`图片文件过大：${file.name}（当前类型不支持自动压缩，请手动压缩到 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxImageBytes)} 以内）`);
    }

    const compressed = await compressImageFile(file, INLINE_ATTACHMENT_LIMITS.maxImageBytes);
    if (!compressed) {
      throw new Error(`图片压缩后仍超过 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxImageBytes)}，请手动裁剪或压缩后重试：${file.name}`);
    }
    return { ...compressed, compressed: true };
  }

  function attachmentByteSize(file: Pick<TextFileAttachment, "text" | "size">): number {
    return measureTextFileAttachmentBytes(file);
  }

  function addTextAttachment(file: Omit<TextFileAttachment, "id"> & { id?: string }): boolean {
    const name = String(file.name ?? "").trim() || "file";
    const text = String(file.text ?? "");
    const displayName = String(file.displayName ?? "").trim() || null;
    const mime = String(file.mime ?? "").trim();
    const size = attachmentByteSize({ text, size: Number(file.size ?? 0) || 0 });

    if (size > INLINE_ATTACHMENT_LIMITS.maxTextFileBytes) {
      message.warning(`文本文件过大：${name}（最大 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxTextFileBytes)}）`);
      return false;
    }
    if (textFileAttachments.value.length >= INLINE_ATTACHMENT_LIMITS.maxTextFileCount) {
      message.warning(`最多只能添加 ${INLINE_ATTACHMENT_LIMITS.maxTextFileCount} 个文本文件`);
      return false;
    }

    const currentTotal = textFileAttachments.value.reduce((acc, x) => acc + attachmentByteSize(x), 0);
    if (currentTotal + size > INLINE_ATTACHMENT_LIMITS.maxTextFileTotalBytes) {
      message.warning(`文本附件总大小超过上限（最大 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxTextFileTotalBytes)}）`);
      return false;
    }
    if (!text.trim()) {
      message.warning(`文本文件内容为空：${name}`);
      return false;
    }

    const nextFile: TextFileAttachment = {
      id: String(file.id ?? "").trim() || randomId("file"),
      name,
      displayName,
      mime,
      size,
      text,
    };
    const budgetCheck = validateInlineThreadPayload(
      { text: "", images: imageAttachments.value, files: [...textFileAttachments.value, nextFile] },
      { contextLabel: "当前附件" },
    );
    if (!budgetCheck.ok) {
      message.warning(budgetCheck.message);
      return false;
    }

    textFileAttachments.value.push(nextFile);
    return true;
  }

  function openFilePicker(): void {
    if (!opts.canAdd.value) return;
    fileInputEl.value?.click();
  }

  function removeImage(id: string): void {
    imageAttachments.value = imageAttachments.value.filter((a) => a.id !== id);
  }

  function removeTextFile(id: string): void {
    textFileAttachments.value = textFileAttachments.value.filter((f) => f.id !== id);
  }

  function openTextFilePreview(f: TextFileAttachment): void {
    previewFile.value = f;
    previewOpen.value = true;
  }

  function closeTextFilePreview(): void {
    previewOpen.value = false;
    previewFile.value = null;
  }

  function isProbablyTextFile(file: File): boolean {
    if (file.type.startsWith("text/")) return true;
    const name = String(file.name ?? "").toLowerCase();
    return (
      name.endsWith(".md") ||
      name.endsWith(".txt") ||
      name.endsWith(".json") ||
      name.endsWith(".yaml") ||
      name.endsWith(".yml") ||
      name.endsWith(".toml") ||
      name.endsWith(".sql") ||
      name.endsWith(".log") ||
      name.endsWith(".env") ||
      name.endsWith(".ts") ||
      name.endsWith(".tsx") ||
      name.endsWith(".js") ||
      name.endsWith(".jsx") ||
      name.endsWith(".vue") ||
      name.endsWith(".css") ||
      name.endsWith(".html") ||
      name.endsWith(".xml") ||
      name.endsWith(".java") ||
      name.endsWith(".go") ||
      name.endsWith(".py") ||
      name.endsWith(".rs") ||
      name.endsWith(".sh") ||
      name.endsWith(".ps1") ||
      name.endsWith(".bat")
    );
  }

  /**
   * 同一入口处理选择、拖放与粘贴；读取中禁止发送，迟到结果不得写入其他草稿。
   */
  async function addAttachments(files: FileList | File[], options?: { referenceUrls?: readonly string[] }): Promise<void> {
    if (!opts.canAdd.value) return;
    const generation = readGeneration;
    pendingReads.value++;
    try {
      await readAttachments(files, generation, options);
    } finally {
      if (generation === readGeneration) pendingReads.value--;
    }
  }

  /** 任一异步读取返回后复核所属草稿与写权限，不接受切换后的旧结果。 */
  function assertReadScope(generation: number): void {
    if (generation !== readGeneration || !opts.canAdd.value) throw new Error("附件读取已取消：会话或写入状态已变化");
  }

  /** 文档提取后复用文本附件校验和预览，保留原文件名，不截断内容。 */
  async function readAttachments(files: FileList | File[], generation: number, options?: { referenceUrls?: readonly string[] }): Promise<void> {
    const list = Array.from(files);
    const referenceUrls = options?.referenceUrls ?? [];
    for (const [index, f] of list.entries()) {
      assertReadScope(generation);
      if (f.type.startsWith("image/")) {
        if (opts.allowImages && !opts.allowImages.value) {
          message.warning("当前模型/引擎不支持图片输入");
          continue;
        }
        if (imageAttachments.value.length >= INLINE_ATTACHMENT_LIMITS.maxImageCount) {
          message.warning(`最多只能添加 ${INLINE_ATTACHMENT_LIMITS.maxImageCount} 张图片`);
          break;
        }

        let prepared: { dataUrl: string; size: number; compressed: boolean };
        try {
          prepared = await prepareImageAttachment(f, INLINE_ATTACHMENT_LIMITS.maxImageSourceBytes);
        } catch (e) {
          assertReadScope(generation);
          if (await appendOversizedFileReference(f, referenceUrls, index)) {
            message.warning(`文件无法内联，已追加文件引用：${f.name}`);
          } else {
            message.warning(e instanceof Error ? e.message : String(e));
          }
          continue;
        }
        assertReadScope(generation);
        const nextImage = { id: randomId("img"), name: f.name, dataUrl: prepared.dataUrl, size: prepared.size };
        const budgetCheck = validateInlineThreadPayload(
          { text: "", images: [...imageAttachments.value, nextImage], files: textFileAttachments.value },
          { contextLabel: "当前附件" },
        );
        if (!budgetCheck.ok) {
          message.warning(budgetCheck.message);
          continue;
        }

        imageAttachments.value.push(nextImage);
        if (prepared.compressed) {
          message.info(`已自动压缩图片：${f.name}（${formatByteSize(f.size)} -> ${formatByteSize(prepared.size)}）`);
        }
        continue;
      }

      if (opts.allowTextFiles && !opts.allowTextFiles.value) {
        message.warning("当前模型/引擎不支持文本附件");
        continue;
      }
      if (isDocumentAttachmentName(f.name)) {
        if (f.size > DOCUMENT_ATTACHMENT_LIMITS.maxSourceBytes) {
          throw new Error(`文档文件过大：${f.name}（最大 ${formatByteSize(DOCUMENT_ATTACHMENT_LIMITS.maxSourceBytes)}）`);
        }
        if (textFileAttachments.value.length >= INLINE_ATTACHMENT_LIMITS.maxTextFileCount) {
          throw new Error(`最多只能添加 ${INLINE_ATTACHMENT_LIMITS.maxTextFileCount} 个文本或文档附件`);
        }
        if (!opts.extractDocument) throw new Error("当前入口不支持文档解析，请更新 Client 后重试");
        const dataUrl = await readFileAsDataUrl(f);
        assertReadScope(generation);
        const text = await opts.extractDocument(f, dataUrl.slice(dataUrl.indexOf(",") + 1));
        assertReadScope(generation);
        if (!addTextAttachment({ name: f.name, mime: "text/plain", size: new TextEncoder().encode(text).length, text })) {
          throw new Error(`文档未添加：${f.name}，请检查提取文字大小或附件总量`);
        }
        continue;
      }
      if (!isProbablyTextFile(f)) {
        message.warning(`暂不支持该文件类型：${f.name}`);
        continue;
      }
      if (f.size > INLINE_ATTACHMENT_LIMITS.maxTextFileBytes) {
        if (await appendOversizedFileReference(f, referenceUrls, index)) {
          message.warning(`文本文件过大，已追加文件引用：${f.name}`);
        } else {
          message.warning(`文本文件过大：${f.name}（最大 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxTextFileBytes)}）。浏览器未提供完整文件地址；请复制文件路径或使用 @ 引用当前工作区文件。`);
        }
        continue;
      }
      if (textFileAttachments.value.length >= INLINE_ATTACHMENT_LIMITS.maxTextFileCount) {
        message.warning(`最多只能添加 ${INLINE_ATTACHMENT_LIMITS.maxTextFileCount} 个文本文件`);
        break;
      }
      const currentTotal = textFileAttachments.value.reduce((acc, x) => acc + attachmentByteSize(x), 0);
      if (currentTotal + Math.max(0, Math.floor(f.size || 0)) > INLINE_ATTACHMENT_LIMITS.maxTextFileTotalBytes) {
        message.warning(`文本附件总大小超过上限（最大 ${formatByteSize(INLINE_ATTACHMENT_LIMITS.maxTextFileTotalBytes)}）`);
        continue;
      }
      let text = "";
      try {
        text = await readFileAsText(f);
      } catch (error) {
        message.warning(`读取文本文件失败：${f.name}（${error instanceof Error ? error.message : String(error)}）`);
        continue;
      }
      assertReadScope(generation);
      const added = addTextAttachment({
        name: f.name,
        displayName: null,
        mime: f.type || "",
        size: f.size,
        text,
      });
      if (!added) continue;
    }
  }

  /** 尝试把超限文件的完整 URL 追加到输入框；无法取得时返回 false。 */
  async function appendOversizedFileReference(file: File, referenceUrls: readonly string[], index: number): Promise<boolean> {
    const referenceUrl = resolveOversizedFileReferenceUrl(file, referenceUrls, index);
    if (referenceUrl && opts.onOversizedFileReference) {
      opts.onOversizedFileReference(referenceUrl, file);
      return true;
    }
    return false;
  }

  function onFileChange(ev: Event): void {
    const files = (ev.target as HTMLInputElement | null)?.files;
    if (!files || !files.length) return;
    void addAttachments(files).catch((e) => message.error(e instanceof Error ? e.message : String(e)));
    // 允许重复选择同一文件
    (ev.target as HTMLInputElement).value = "";
  }

  function onDrop(ev: DragEvent): void {
    if (!opts.canAdd.value) return;
    const files = ev.dataTransfer?.files;
    if (!files || !files.length) return;
    void addAttachments(files).catch((e) => message.error(e instanceof Error ? e.message : String(e)));
  }

  function onPaste(ev: ClipboardEvent): void {
    if (!opts.canAdd.value) return;

    // 优先使用 clipboardData.files（大多数浏览器的截图/拖拽文件）
    const files = Array.from(ev.clipboardData?.files ?? []);
    if (files.length) {
      ev.preventDefault();
      const referenceUrls = collectClipboardFileReferenceUrls(ev.clipboardData);
      void addAttachments(files, { referenceUrls }).catch((e) => message.error(e instanceof Error ? e.message : String(e)));
      return;
    }

    // 回退：部分浏览器截图数据仅在 clipboardData.items 中以 blob 形式存在
    const items = ev.clipboardData?.items;
    if (!items) return;
    const blobFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) blobFiles.push(f);
      }
    }
    if (!blobFiles.length) return;
    ev.preventDefault();
    const referenceUrls = collectClipboardFileReferenceUrls(ev.clipboardData);
    void addAttachments(blobFiles, { referenceUrls }).catch((e) => message.error(e instanceof Error ? e.message : String(e)));
  }

  /** 清空附件并取消尚未完成的读取，防止旧文件在发送后重新出现。 */
  function clearAttachments(): void {
    invalidateAttachmentReads();
    imageAttachments.value = [];
    textFileAttachments.value = [];
  }

  return {
    imageAttachments,
    textFileAttachments,
    fileInputEl,
    pendingReads,
    invalidateAttachmentReads,
    addAttachments,
    previewFile,
    previewOpen,
    openFilePicker,
    removeImage,
    removeTextFile,
    addTextAttachment,
    openTextFilePreview,
    closeTextFilePreview,
    onFileChange,
    onDrop,
    onPaste,
    clearAttachments,
  };
}

function isImageCompressionUnsupported(file: File): boolean {
  const type = String(file.type ?? "").trim().toLowerCase();
  return type === "image/gif" || type === "image/svg+xml";
}

export async function compressImageFile(file: File, targetMaxBytes: number): Promise<{ dataUrl: string; size: number } | null> {
  const source = await loadImageSource(file);
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器不支持图片压缩");

    const longestEdge = Math.max(source.width, source.height);
    const baseScale = longestEdge > 2560 ? 2560 / longestEdge : 1;
    const scales = buildImageCompressionScales(baseScale);
    const encoders = [
      { type: "image/webp", quality: 0.88 },
      { type: "image/webp", quality: 0.8 },
      { type: "image/webp", quality: 0.72 },
      { type: "image/jpeg", quality: 0.86 },
      { type: "image/jpeg", quality: 0.76 },
      { type: "image/jpeg", quality: 0.66 },
    ] as const;

    let smallest: Blob | null = null;
    for (const scale of scales) {
      const width = Math.max(1, Math.round(source.width * scale));
      const height = Math.max(1, Math.round(source.height * scale));
      canvas.width = width;
      canvas.height = height;
      ctx.clearRect(0, 0, width, height);
      source.draw(ctx, width, height);

      for (const encoder of encoders) {
        const blob = await canvasToBlob(canvas, encoder.type, encoder.quality);
        if (!blob) continue;
        if (!smallest || blob.size < smallest.size) smallest = blob;
        if (blob.size <= targetMaxBytes) {
          return {
            dataUrl: await readBlobAsDataUrl(blob),
            size: blob.size,
          };
        }
      }
    }

    if (smallest && smallest.size <= targetMaxBytes) {
      return {
        dataUrl: await readBlobAsDataUrl(smallest),
        size: smallest.size,
      };
    }
    return null;
  } finally {
    source.close();
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

async function loadImageSource(file: File): Promise<{
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  close: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (ctx, width, height) => ctx.drawImage(bitmap, 0, 0, width, height),
        close: () => bitmap.close(),
      };
    } catch {
      // fallback to Image element below
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`图片解码失败：${file.name}`));
      image.src = objectUrl;
    });
    return {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      draw: (ctx, width, height) => ctx.drawImage(img, 0, 0, width, height),
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function buildImageCompressionScales(baseScale: number): number[] {
  const candidates = [baseScale, baseScale * 0.85, baseScale * 0.72, baseScale * 0.6, baseScale * 0.48];
  const seen = new Set<string>();
  const out: number[] = [];
  for (const candidate of candidates) {
    const normalized = Math.min(1, Math.max(0.25, candidate));
    const key = normalized.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(blob);
  });
}

/** 解码浏览器侧文本附件字节，保持与 Client 文件预览一致的编码顺序。 */
function decodeTextAttachmentBuffer(buffer: ArrayBuffer): string {
  for (const encoding of ["utf-8", "gb18030", "gbk"]) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(buffer);
    } catch {
      // 继续尝试下一个兼容编码，全部失败后再显式报错。
    }
  }
  throw new Error("无法按 UTF-8 或 GBK 解码");
}


