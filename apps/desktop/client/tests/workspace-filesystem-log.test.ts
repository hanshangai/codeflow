import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { openClientDb } from "../src/db/clientDb.js";
import { handleFsExtractAttachment, handleFsReadFile, handleFsUploadChunk, handleFsUploadComplete, handleFsUploadCancel } from "../src/app/handlers/fsHandlers.js";
import { handleApiRequest, isWorkspaceApiRequestFailure, getWorkspaceApiRequestFailureDetails, type ApiHandlerContext } from "../src/app/handleApiRequest.js";
import { logger } from "../src/logger.js";
import { extractDocumentAttachmentInWorker } from "../src/fs/documentAttachmentWorkerClient.js";
import { beginUpload, cancelUpload, writeUploadChunk } from "../src/fs/fsService.js";

/** 日志使用真实工作区目录；外部投递只记录本次响应。 */
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-fs-log-"));
  const directory = path.join(root, "workspace");
  fs.mkdirSync(directory);
  const db = openClientDb({ dbPath: path.join(root, "app.db") });
  db.workspaces.upsert({ id: "workspace", title: "项目", path: directory });
  const responses: any[] = [];
  let marked = 0;
  const ctx = { db, clientId: "client", workspaces: new Map([["workspace", directory]]),
    send: (value: unknown) => { responses.push(value); }, onApiFailureLogged: () => { marked++; } } as unknown as ApiHandlerContext;
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, directory, responses, ctx, marked: () => marked };
}

/** 只读取本夹具生成的工作区日志，不读取应用或用户目录。 */
function logLines(directory: string): any[] {
  const logDirectory = path.join(directory, ".codeflowai");
  if (!fs.existsSync(logDirectory)) return [];
  return fs.readdirSync(logDirectory).filter(name => /^client-.*\.log$/.test(name))
    .flatMap(name => fs.readFileSync(path.join(logDirectory, name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
}

test("文档解析和文件读取失败仅记所属W，并标记已记录与返回明确失败", async t => {
  const f = fixture(t), applicationLogs: unknown[] = [];
  t.mock.method(logger, "warn", (...args) => { applicationLogs.push(args); });
  t.mock.method(logger, "error", (...args) => { applicationLogs.push(args); });
  await handleFsExtractAttachment(f.ctx, { t: "api.req", id: "attachment", method: "fs.extractAttachment",
    body: { workspaceId: "workspace", fileName: "合同.pdf", base64: "invalid" } } as never);
  await handleFsReadFile(f.ctx, { t: "api.req", id: "read", method: "fs.readFile", body: { workspaceId: "workspace", path: "missing.txt" } } as never);
  assert.equal(f.responses.length, 2);
  assert.ok(f.responses.every(response => response.body.ok === false));
  assert.equal(f.marked(), 2);
  const logs = logLines(f.directory);
  assert.deepEqual(logs.map(line => line.requestId), ["attachment", "read"]);
  assert.ok(logs.every(line => line.workspaceId === "workspace" && line.code && line.rootCause));
  assert.deepEqual(applicationLogs, []);
});

test("文档业务失败后日志拒绝保留双因，禁止标记或发送假成功", async t => {
  const f = fixture(t);
  f.db.writeWorkspaceLog = () => { throw 0; };
  await assert.rejects(handleFsExtractAttachment(f.ctx, { t: "api.req", id: "attachment-log", method: "fs.extractAttachment",
    body: { workspaceId: "workspace", fileName: "合同.pdf", base64: "invalid" } } as never), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[1], 0);
    assert.equal(error.cause, error.errors[0]);
    return true;
  });
  assert.equal(f.responses.length, 0);
  assert.equal(f.marked(), 0);
});

test("失败响应拒绝保留业务与投递原因，不重复记录或再次发送", async t => {
  const f = fixture(t), deliveryFailure = new Error("DELIVERY_FAILED");
  let sends = 0;
  f.ctx.send = () => { sends++; throw deliveryFailure; };
  await assert.rejects(handleFsExtractAttachment(f.ctx, { t: "api.req", id: "attachment-send", method: "fs.extractAttachment",
    body: { workspaceId: "workspace", fileName: "合同.pdf", base64: "invalid" } } as never), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[1], deliveryFailure);
    assert.equal(error.cause, error.errors[0]);
    return true;
  });
  assert.equal(sends, 1);
  assert.equal(f.marked(), 1);
  assert.equal(logLines(f.directory).length, 1);
});

test("文档Worker收口保留falsy业务和清理原因，并真正回收测试Worker", async t => {
  const terminate = Worker.prototype.terminate;
  const once = Worker.prototype.once;
  let terminated = 0;
  t.mock.method(Worker.prototype, "once", function (this: Worker, event: string | symbol, listener: (...args: any[]) => void) {
    if (event === "message") throw undefined;
    return once.call(this, event, listener);
  });
  t.mock.method(Worker.prototype, "terminate", async function (this: Worker) {
    await terminate.call(this);
    terminated++;
    throw 0;
  });
  await assert.rejects(extractDocumentAttachmentInWorker("合同.pdf", Buffer.from("%PDF-test").toString("base64")), error => {
    assert.ok(error instanceof Error && error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [undefined, 0]);
    assert.equal(error.cause.cause, undefined);
    return true;
  });
  assert.equal(terminated, 1);
});

for (const method of ["fs.uploadChunk", "fs.uploadComplete", "fs.uploadCancel"] as const) {
  test(`${method}失败沿真实uploadId固定W，不采信请求伪造的工作区`, async t => {
    const f = fixture(t), app: unknown[] = [];
    const other = path.join(f.directory, "other"); fs.mkdirSync(other);
    f.db.workspaces.upsert({ id: "other", title: "异工作区", path: other }); f.ctx.workspaces.set("other", other);
    const upload = beginUpload(f.directory, { fileName: "upload.txt", sizeBytes: 1 });
    const unlink = fs.unlinkSync;
    if (method === "fs.uploadCancel") t.mock.method(fs, "unlinkSync", target => {
      if (String(target).endsWith(`${upload.uploadId}.part`)) throw Object.assign(new Error("PRIVATE_UPLOAD_FAILURE"), { code: "EIO" });
      return unlink(target);
    });
    t.mock.method(logger, "error", (...args) => { app.push(args); });
    t.mock.method(logger, "warn", (...args) => { app.push(args); });
    try {
      await handleApiRequest(f.ctx, { t: "api.req", id: method, method, path: "/upload",
        body: { uploadId: upload.uploadId, workspaceId: "other", offset: 1, base64: "eA==" } } as never);
      assert.equal(f.responses[0].status, 500);
      assert.deepEqual(logLines(f.directory).map(row => ({ workspaceId: row.workspaceId, requestId: row.requestId })),
        [{ workspaceId: "workspace", requestId: method }]);
      assert.equal(logLines(other).length, 0); assert.equal(app.length, 0);
    } finally { t.mock.restoreAll(); cancelUpload(upload.uploadId); }
  });
}

test("上传完成后索引失败仍保已删除session的原W，并保提交后的真实文件", async t => {
  const f = fixture(t), original = new Error("INDEX_FAILED"), app: unknown[] = [];
  const upload = beginUpload(f.directory, { fileName: "uploaded.txt", sizeBytes: 1 });
  writeUploadChunk({ uploadId: upload.uploadId, offset: 0, base64: "eA==" });
  f.ctx.workspacePathIndex = { applyChanges() { throw original; } } as any;
  t.mock.method(logger, "error", (...args) => { app.push(args); });
  await handleApiRequest(f.ctx, { t: "api.req", id: "complete-index", method: "fs.uploadComplete", path: "/upload",
    body: { uploadId: upload.uploadId } } as never);
  assert.equal(f.responses[0].status, 500); assert.equal(fs.readFileSync(path.join(f.directory, "uploaded.txt"), "utf8"), "x");
  assert.equal(logLines(f.directory)[0].workspaceId, "workspace"); assert.equal(app.length, 0);
});

test("已知上传失败及W日志双错保因，未知uploadId不能借请求W归属日志", async t => {
  const f = fixture(t), upload = beginUpload(f.directory, { fileName: "upload.txt", sizeBytes: 1 }), app: any[] = [];
  const writer = t.mock.method(f.db, "writeWorkspaceLog", () => { throw false; });
  try {
    await assert.rejects(handleApiRequest(f.ctx, { t: "api.req", id: "upload-log", method: "fs.uploadChunk", path: "/upload",
      body: { uploadId: upload.uploadId, offset: 1, base64: "eA==" } } as never), error => {
      assert.ok(isWorkspaceApiRequestFailure(error)); assert.equal(error.errors[1], false); return true;
    });
    assert.equal(f.responses.length, 0); writer.mock.restore();
    t.mock.method(logger, "error", (...args) => { app.push(args); });
    await handleApiRequest(f.ctx, { t: "api.req", id: "unknown-upload", method: "fs.uploadChunk", path: "/upload",
      body: { uploadId: "unknown", workspaceId: "workspace", offset: 0, base64: "eA==" } } as never);
    assert.equal(f.responses[0].status, 500); assert.equal(app[0][2].workspaceId, null);
    assert.equal(logLines(f.directory).length, 0);
  } finally { cancelUpload(upload.uploadId); }
});

for (const method of ["chunk", "complete", "cancel"] as const) {
  test(`上传${method}成功后的投递失败只尝试一次，不落第二条业务失败`, t => {
    const f = fixture(t), rejection = new Error("UPLOAD_RESPONSE_FAILED");
    const upload = beginUpload(f.directory, { fileName: "uploaded.txt", sizeBytes: method === "cancel" ? 1 : 0 });
    let sends = 0;
    f.ctx.send = () => { sends++; throw rejection; };
    const handler = method === "chunk" ? handleFsUploadChunk : method === "complete" ? handleFsUploadComplete : handleFsUploadCancel;
    try {
      assert.throws(() => handler(f.ctx, { t: "api.req", id: "upload-response", method: `fs.upload${method}`, path: "/upload",
        body: { uploadId: upload.uploadId, offset: 0, base64: "" } } as never), error => error === rejection);
      assert.equal(sends, 1); assert.equal(logLines(f.directory).length, 0);
    } finally { cancelUpload(upload.uploadId); }
  });
}

for (const method of ["fs.uploadChunk", "fs.uploadComplete", "fs.uploadCancel"] as const) {
  test(`${method}成功响应投递拒绝沿入站session固定W，不重复发送`, async t => {
    const f = fixture(t), rejection = { accepted: false, reason: "PRIVATE_UPLOAD_RESPONSE_FAILURE" }, app: unknown[] = [];
    const upload = beginUpload(f.directory, { fileName: "uploaded.txt", sizeBytes: method === "fs.uploadCancel" ? 1 : 0 });
    let sends = 0;
    f.ctx.send = () => { sends++; return rejection as any; };
    t.mock.method(logger, "error", (...args) => { app.push(args); });
    try {
      await assert.rejects(handleApiRequest(f.ctx, { t: "api.req", id: "upload-response", method, path: "/upload",
        body: { uploadId: upload.uploadId, offset: 0, base64: "" } } as never), error => {
        assert.ok(isWorkspaceApiRequestFailure(error));
        assert.equal(getWorkspaceApiRequestFailureDetails(error)?.workspaceId, "workspace");
        assert.equal(getWorkspaceApiRequestFailureDetails(error)?.responseAttempted, true);
        assert.equal(getWorkspaceApiRequestFailureDetails(error)?.responseDelivered, false); return true;
      });
      assert.equal(sends, 1); assert.equal(logLines(f.directory).length, 1); assert.equal(app.length, 0);
      assert.ok(!JSON.stringify(logLines(f.directory)).includes(rejection.reason));
    } finally { cancelUpload(upload.uploadId); }
  });
}
