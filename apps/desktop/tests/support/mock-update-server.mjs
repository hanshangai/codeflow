import crypto from "node:crypto";
import http from "node:http";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const REGISTER_PATH = "/api/software/desktop/devices/register";
const RELEASE_PATH = "/api/software/desktop/release";
const ARCHIVE_PATH = /^\/api\/software\/desktop\/releases\/([^/]+)\/archive$/u;
const RECEIPTS_PATH = "/api/software/desktop/update-receipts";
const FAILURES_PATH = "/api/software/desktop/update-failures";

/** 清单既接受已验证的字节，也接受对象；字节路径保留原始签名输入。 */
function toBytes(value) {
  return value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(JSON.stringify(value), "utf8");
}

/** 按注册出现的顺序取出第一个命中的故障；一次性消费，避免污染后续请求。 */
function takeFault(faults, pathname) {
  const index = faults.findIndex(({ match }) => typeof match === "string"
    ? pathname === match || pathname.startsWith(match)
    : match instanceof RegExp && match.test(pathname));
  return index < 0 ? null : faults.splice(index, 1)[0].fault;
}

/** 仅接受单段开放区间 `bytes=N-`；越界返回 null 由调用方回 416。 */
function parseRangeStart(range, size) {
  const match = /^bytes=(\d+)-$/u.exec(range ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  return Number.isSafeInteger(start) && start >= 0 && start < size ? start : null;
}

/** 所有 mock 响应统一走这里，避免半写响应头。 */
function writeJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, { ...JSON_HEADERS, "content-length": String(body.byteLength) });
  response.end(body);
}

/** 读取完整请求体；流错误向上抛出，不吞掉连接故障。 */
async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * 启动桌面更新协议的本地 mock Server。
 *
 * 覆盖生产协议的五个入口：设备登记、发布清单、归档下载（Range/ETag）、阶段回执、失败补报。
 * 设备签名在此只记录不验签——mock 的职责是驱动客户端，真实验签由 Server 单测覆盖。
 * 调用方必须在结束时 await close()。
 */
export async function startMockUpdateServer(options = {}) {
  const state = {
    manifest: options.manifest === undefined ? null : toBytes(options.manifest),
    archive: options.archive === undefined ? null : Buffer.from(options.archive),
    requests: [],
    receipts: [],
    failures: [],
    faults: [],
  };

  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://mock.invalid").pathname;
    let body;
    try {
      body = await readBody(request);
    } catch {
      request.socket.destroy();
      return;
    }
    state.requests.push({ method: request.method, path: pathname, headers: { ...request.headers }, body });

    const fault = takeFault(state.faults, pathname);
    if (fault) {
      if (fault.delayMs) await new Promise(resolve => setTimeout(resolve, fault.delayMs));
      if (fault.destroy) {
        request.socket.destroy();
        return;
      }
      if (fault.status) {
        writeJson(response, fault.status, fault.body ?? { ok: false, code: "MOCK_FAILURE" });
        return;
      }
    }

    try {
      if (request.method === "POST" && pathname === REGISTER_PATH) {
        const value = JSON.parse(body.toString("utf8"));
        writeJson(response, 200, {
          ok: true,
          deviceId: value.deviceId,
          publicKeySha256: crypto.createHash("sha256").update(Buffer.from(value.publicKeyBase64, "base64")).digest("hex"),
        });
        return;
      }

      if (request.method === "GET" && pathname === RELEASE_PATH) {
        if (!state.manifest) {
          writeJson(response, 404, { ok: false, code: "MOCK_NO_RELEASE" });
          return;
        }
        response.writeHead(200, { ...JSON_HEADERS, "content-length": String(state.manifest.byteLength) });
        response.end(state.manifest);
        return;
      }

      if (request.method === "GET" && ARCHIVE_PATH.test(pathname)) {
        if (!state.archive) {
          writeJson(response, 404, { ok: false, code: "MOCK_NO_ARCHIVE" });
          return;
        }
        const archive = state.archive;
        const etag = `"${crypto.createHash("sha256").update(archive).digest("hex")}"`;
        const range = request.headers.range;
        const start = range ? parseRangeStart(range, archive.byteLength) : 0;
        if (start === null) {
          response.writeHead(416, { etag });
          response.end();
          return;
        }
        const slice = archive.subarray(start);
        const headers = {
          "content-type": "application/octet-stream",
          "content-length": String(slice.byteLength),
          etag,
          "accept-ranges": "bytes",
        };
        if (start > 0) headers["content-range"] = `bytes ${start}-${archive.byteLength - 1}/${archive.byteLength}`;
        response.writeHead(start > 0 ? 206 : 200, headers);
        response.end(slice);
        return;
      }

      if (request.method === "POST" && pathname === RECEIPTS_PATH) {
        const value = JSON.parse(body.toString("utf8"));
        state.receipts.push(value);
        writeJson(response, 200, {
          ok: true,
          deviceId: value.deviceId,
          requestId: value.requestId,
          releaseId: value.releaseId,
          archiveSha256: value.archiveSha256,
          stage: value.stage,
          at: value.at,
          payloadSha256: value.payloadSha256,
        });
        return;
      }

      if (request.method === "POST" && pathname === FAILURES_PATH) {
        const value = JSON.parse(body.toString("utf8"));
        state.failures.push(value);
        writeJson(response, 200, { ok: true, errorId: value.errorId, deviceId: value.deviceId, payloadSha256: value.payloadSha256 });
        return;
      }

      writeJson(response, 404, { ok: false, code: "MOCK_NOT_FOUND" });
    } catch {
      writeJson(response, 500, { ok: false, code: "MOCK_HANDLER_FAILED" });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    state,
    requests: state.requests,
    receipts: state.receipts,
    failures: state.failures,
    /** 替换当前发布的清单与归档。 */
    setRelease(next) {
      state.manifest = toBytes(next.manifest);
      state.archive = Buffer.from(next.archive);
    },
    setManifest(next) {
      state.manifest = toBytes(next);
    },
    setArchive(next) {
      state.archive = Buffer.from(next.archive);
    },
    /** 对下一次命中的请求注入故障：status/body 或 destroy（断开连接）。 */
    failNext(match, fault) {
      state.faults.push({ match, fault });
    },
    /** 按路径取请求记录；调用方据此断言签名头、Range 与 ETag。 */
    requestsFor(pathname) {
      return state.requests.filter(entry => entry.path === pathname);
    },
    async close() {
      await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    },
  };
}
