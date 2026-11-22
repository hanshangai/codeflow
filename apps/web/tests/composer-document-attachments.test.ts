import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computed, effectScope, ref } from "vue";
import { message } from "ant-design-vue";
import {
  DOCUMENT_ATTACHMENT_EXTENSIONS,
  DOCUMENT_ATTACHMENT_LIMITS,
  INLINE_ATTACHMENT_LIMITS,
  validateInlineThreadPayload,
} from "@codeflowai/shared";
import { useComposerAttachments } from "../src/features/composer/useComposerAttachments.ts";

/** Node 提供 File/Blob，仅读取 data URL 的浏览器边界由测试模拟。 */
class TestFileReader {
  result = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** 读取真实 File 字节，异常通过 FileReader 的错误事件交回调用方。 */
  readAsDataURL(file: Blob): void {
    void file.arrayBuffer().then((bytes) => {
      this.result = `data:${file.type};base64,${Buffer.from(bytes).toString("base64")}`;
      this.onload?.();
    }, () => this.onerror?.());
  }
}

/** 为每个用例隔离 Vue scope、FileReader 和消息提示。 */
function harness(t: TestContext, extractDocument: (file: File, base64: string) => Promise<string>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "FileReader");
  Object.defineProperty(globalThis, "FileReader", { configurable: true, value: TestFileReader });
  t.mock.method(message, "warning", () => undefined);
  t.mock.method(message, "error", () => undefined);
  const scope = effectScope();
  const session = ref("thread-a");
  const writable = ref(true);
  const attachments = scope.run(() => useComposerAttachments({
    canAdd: computed(() => writable.value), scopeKey: computed(() => session.value), extractDocument,
  }))!;
  t.after(() => {
    scope.stop();
    if (previous) Object.defineProperty(globalThis, "FileReader", previous);
    else Reflect.deleteProperty(globalThis, "FileReader");
  });
  return { ...attachments, session, writable };
}

/** 等待 FileReader 与事件入口异步任务完成，不访问真实 Server。 */
async function settle(): Promise<void> {
  for (let index = 0; index < 6; index++) await new Promise((resolve) => setImmediate(resolve));
}

test("全部新旧文档格式共用提取入口，按提取文字而非二进制大小计算预算", async (t) => {
  const seen: string[] = [];
  const attachments = harness(t, async (file, base64) => {
    seen.push(file.name);
    assert.equal(Buffer.from(base64, "base64").length, file.size);
    return "中文表格\t12";
  });
  for (const extension of DOCUMENT_ATTACHMENT_EXTENSIONS) {
    await attachments.addAttachments([new File([Buffer.alloc(300 * 1024)], `资料.${extension}`)]);
    assert.equal(attachments.textFileAttachments.value[0]?.name, `资料.${extension}`);
    assert.equal(attachments.textFileAttachments.value[0]?.size, Buffer.byteLength("中文表格\t12"));
    assert.equal(validateInlineThreadPayload({ files: attachments.textFileAttachments.value }).ok, true);
    attachments.clearAttachments();
  }
  assert.equal(seen.length, 7);
});

test("常用文本与日志格式按文本附件内联", async (t) => {
  const attachments = harness(t, async () => { throw new Error("文本文件不应触发文档提取"); });
  const names = ["事件日志.jsonl", "数据.ndjson", "指标.csv", "脚本.mjs", "样式.scss", "配置.ini"];
  for (const name of names) await attachments.addAttachments([new File([`内容:${name}`], name)]);
  assert.deepEqual(attachments.textFileAttachments.value.map((file) => file.name), names);
});

test("无扩展名的 Dockerfile 与 Makefile 按文本附件内联", async (t) => {
  const attachments = harness(t, async () => { throw new Error("文本文件不应触发文档提取"); });
  for (const name of ["Dockerfile", "Makefile"]) await attachments.addAttachments([new File([`内容:${name}`], name)]);
  assert.deepEqual(attachments.textFileAttachments.value.map((file) => file.name), ["Dockerfile", "Makefile"]);
});

test("选择、拖放、粘贴文件均提取文字", async (t) => {
  const attachments = harness(t, async (file) => `文字：${file.name}`);
  const file = new File(["bytes"], "资料.doc");
  attachments.onFileChange({ target: { files: [file], value: "selected" } } as unknown as Event);
  await settle();
  attachments.onDrop({ dataTransfer: { files: [file] } } as unknown as DragEvent);
  await settle();
  let prevented = false;
  attachments.onPaste({ clipboardData: { files: [file], getData: () => "" }, preventDefault: () => { prevented = true; } } as unknown as ClipboardEvent);
  await settle();
  assert.equal(prevented, true);
  assert.equal(attachments.textFileAttachments.value.length, 3);
  assert.ok(attachments.textFileAttachments.value.every((value) => value.text === "文字：资料.doc"));
});

test("切换会话后旧文档明确取消，不能写入新草稿", async (t) => {
  let finish!: (text: string) => void;
  const attachments = harness(t, () => new Promise((resolve) => { finish = resolve; }));
  const pending = attachments.addAttachments([new File(["bytes"], "资料.pdf")]);
  await settle();
  assert.equal(attachments.pendingReads.value, 1);
  attachments.session.value = "thread-b";
  const rejected = assert.rejects(pending, /读取已取消/);
  finish("旧会话正文");
  await rejected;
  assert.equal(attachments.pendingReads.value, 0);
  assert.equal(attachments.textFileAttachments.value.length, 0);
});

test("超限和解析失败停止本批，不添加空白或后续文件", async (t) => {
  let calls = 0;
  const attachments = harness(t, async () => { calls++; throw new Error("文件已加密"); });
  await assert.rejects(attachments.addAttachments([new File([Buffer.alloc(DOCUMENT_ATTACHMENT_LIMITS.maxSourceBytes + 1)], "大文件.pdf")]), /文档文件过大/);
  assert.equal(calls, 0);
  await assert.rejects(attachments.addAttachments([new File(["bytes"], "加密.pdf"), new File(["later"], "后续.txt")]), /文件已加密/);
  assert.equal(attachments.textFileAttachments.value.length, 0);
  assert.equal(attachments.pendingReads.value, 0);
});

test("文档源文件统一 20MB", async (t) => {
  const attachments = harness(t, async () => "提取结果");
  const within = new File([Buffer.alloc(8 * 1024 * 1024 + 1)], "大文件.pdf");
  await attachments.addAttachments([within]);
  assert.equal(attachments.textFileAttachments.value.length, 1);
  attachments.clearAttachments();

  const oversized = new File([Buffer.alloc(DOCUMENT_ATTACHMENT_LIMITS.maxSourceBytes + 1)], "超过上限.pdf");
  await assert.rejects(attachments.addAttachments([oversized]), /文档文件过大/);
});

test("文本附件单文件上限为 2MB", async (t) => {
  const attachments = harness(t, async () => "unused");
  await attachments.addAttachments([new File([Buffer.alloc(1.5 * 1024 * 1024, 0x61)], "日志.jsonl")]);
  assert.equal(attachments.textFileAttachments.value.length, 1);
  await attachments.addAttachments([new File([Buffer.alloc(INLINE_ATTACHMENT_LIMITS.maxTextFileBytes + 1, 0x61)], "超大.jsonl")]);
  assert.equal(attachments.textFileAttachments.value.length, 1);
});

test("图片源文件统一 12MB", async (t) => {
  const attachments = harness(t, async () => "提取结果");
  const file = new File([Buffer.alloc(INLINE_ATTACHMENT_LIMITS.maxImageSourceBytes + 1)], "大图.png", { type: "image/png" });
  await attachments.addAttachments([file]);
  assert.equal(attachments.imageAttachments.value.length, 0);
});

test("粘贴图片上限放宽到 10 张", () => {
  const image = (index: number) => ({ name: `${index}.png`, dataUrl: "data:image/png;base64,AA==", size: 1 });
  assert.equal(validateInlineThreadPayload({ images: Array.from({ length: 10 }, (_, index) => image(index)) }).ok, true);
  assert.equal(validateInlineThreadPayload({ images: Array.from({ length: 11 }, (_, index) => image(index)) }).ok, false);
});

test("输入框解析期间禁发，并为选择器开放文档格式", () => {
  const source = readFileSync(new URL("../src/features/composer/components/chat-composer.vue", import.meta.url), "utf8");
  assert.match(source, /DOCUMENT_ATTACHMENT_EXTENSIONS\.map/);
  const canSend = source.match(/const canSend = computed\(\(\) => \{([\s\S]*?)\n\}\);/)?.[1];
  assert.ok(canSend, "应保留发送可用性计算入口");
  assert.match(canSend, /if \(pendingReads\.value\) return false;/);
  assert.ok(canSend.indexOf("if (pendingReads.value)") < canSend.indexOf("return shouldAllowComposerSend("), "附件解析应在通用发送判断前阻断发送");
  assert.match(source, /function applyDraft[\s\S]*?invalidateAttachmentReads\(\)/);
  assert.match(source, /const send = async \(\) => \{[\s\S]*?if \(pendingReads\.value\) \{[\s\S]*?return;/);
});
