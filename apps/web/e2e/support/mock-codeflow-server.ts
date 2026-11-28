import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";

const DEFAULT_PORT = 39290;
const port = readPort(process.argv, DEFAULT_PORT);

/** Reads the mock server port from CLI args and falls back to the local default. */
function readPort(argv: string[], fallback: number): number {
  const index = argv.indexOf("--port");
  const value = index >= 0 ? Number(argv[index + 1]) : Number.NaN;
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Writes a JSON response with no cache so every UI check observes fresh data. */
function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    "access-control-allow-headers": "authorization, content-type, x-web-session-id",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  res.end(text);
}

/** Reads and parses a JSON request body; empty bodies resolve to an empty object. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

// ===== 会话内存态（threads REST 端点 + conversation.event 推送共用） =====

type MockThread = {
  id: string;
  title: string;
  threadType: string;
  engine: string;
  createdAt: number;
  updatedAt: number;
  events: unknown[];
};

const threads = new Map<string, MockThread>();
let seqCounter = 0;

function now(): number {
  return Date.now();
}

function pushEvent(thread: MockThread, type: string, payload: Record<string, unknown>): unknown {
  seqCounter += 1;
  const event = {
    schema: 1,
    seq: seqCounter,
    ts: now(),
    workspaceId: "workspace_chat_core_e2e",
    threadId: thread.id,
    engine: thread.engine,
    type,
    payload,
  };
  thread.events.push(event);
  return event;
}

function toThreadSummary(thread: MockThread): Record<string, unknown> {
  return {
    id: thread.id,
    title: thread.title,
    threadType: thread.threadType,
    threadSubtype: null,
    archived: false,
    pinnedAt: null,
    groupId: null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    engine: thread.engine,
    sharedContext: null,
    readOnly: false,
  };
}

// ===== WebSocket（web.helloAck / subscribeAck / conversation.event / threads.changed） =====

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type WsConn = {
  socket: Duplex;
  webSessionId: string;
  workspaceId: string | null;
  buffer: Buffer;
};

const wsConns = new Set<WsConn>();

function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header: number[] = [0x81]; // FIN + text opcode
  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length < 65536) {
    header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    header.push(127);
    for (let i = 7; i >= 0; i -= 1) header.push((payload.length >> (i * 8)) & 0xff);
  }
  return Buffer.concat([Buffer.from(header), payload]);
}

function encodeControlFrame(opcode: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

function sendWs(conn: WsConn, msg: unknown): void {
  conn.socket.write(encodeTextFrame(JSON.stringify(msg)));
}

function broadcast(workspaceId: string, msg: unknown): void {
  for (const conn of wsConns) {
    if (conn.workspaceId === workspaceId) sendWs(conn, msg);
  }
}

// ===== 内置中转与引擎 Key 内存态：默认与真实环境一致（中转未启用、无 Key） =====

type MockRelayState = {
  state: "disabled" | "enabled";
  publicBaseUrl: string;
  providerGroupsConfigured: Record<string, boolean>;
  ensureFailureCode: string | null;
};

type MockEngineKey = {
  id: string;
  label: string;
  engine: "claude" | "codex";
  providerId: string;
  apiKey: string;
  baseUrl: string | null;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
};

const defaultMockRelayState = (): MockRelayState => ({
  state: "disabled",
  publicBaseUrl: "",
  providerGroupsConfigured: {},
  ensureFailureCode: null,
});
let mockRelay: MockRelayState = defaultMockRelayState();
let mockEngineKeys: MockEngineKey[] = [];
let mockEngineKeySeq = 0;

/** 写入或更新引擎 Key，并模拟 Client 语义：同 (engine, providerId) 首个 Key 自动启用。 */
function upsertMockEngineKey(input: { id?: string; label: string; engine: "claude" | "codex"; providerId: string; apiKey: string; baseUrl: string | null }): MockEngineKey {
  const existing = mockEngineKeys.find((key) => key.id === input.id
    || (key.engine === input.engine && key.providerId === input.providerId && key.label === input.label));
  const group = mockEngineKeys.filter((key) => key.engine === input.engine && key.providerId === input.providerId);
  if (existing) {
    existing.label = input.label;
    existing.apiKey = input.apiKey;
    existing.baseUrl = input.baseUrl;
    existing.updatedAt = now();
    return existing;
  }
  mockEngineKeySeq += 1;
  const created: MockEngineKey = {
    id: input.id ?? `engine-key-${mockEngineKeySeq}`,
    label: input.label,
    engine: input.engine,
    providerId: input.providerId,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    isActive: !group.some((key) => key.isActive),
    createdAt: now(),
    updatedAt: now(),
  };
  mockEngineKeys.push(created);
  return created;
}

/** 切换启用态：同 (engine, providerId) 互斥，未找到目标时返回 null。 */
function activateMockEngineKey(id: string): MockEngineKey | null {
  const target = mockEngineKeys.find((key) => key.id === id);
  if (!target) return null;
  for (const key of mockEngineKeys) {
    if (key.engine === target.engine && key.providerId === target.providerId) key.isActive = key.id === id;
  }
  target.updatedAt = now();
  return target;
}

function buildPresencePayload(): unknown {
  return {
    t: "presence.event",
    event: {
      type: "presence.updated",
      ts: now(),
      payload: {
        onlineWebCount: 1,
        clientOnline: true,
        onlineClients: [{ clientId: "mock-client", version: "0.1.0", connectedAt: 1, workspaceIds: ["workspace_chat_core_e2e"] }],
      },
    },
  };
}


/** 解析客户端帧；返回文本/关闭/心跳，尚未收满时返回 null。 */
function parseClientFrame(buffer: Buffer): { text: string; opcode: number; consumed: number } | null {
  if (buffer.length < 2) return null;
  const b0 = buffer[0];
  const b1 = buffer[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let length = b1 & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  let maskKey: Buffer | null = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    maskKey = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  let payload = buffer.subarray(offset, offset + length);
  if (masked && maskKey) {
    const unmasked = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ maskKey[i % 4];
    payload = unmasked;
  }
  return { text: payload.toString("utf8"), opcode, consumed: offset + length };
}

function handleWsMessage(conn: WsConn, raw: string): void {
  let msg: { t?: string; workspaceId?: string | null; requestId?: string; threadId?: string; title?: string };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    return;
  }
  if (msg.t === "web.subscribe" || msg.t === "web.subscribeReplace") {
    conn.workspaceId = String(msg.workspaceId ?? "");
    sendWs(conn, {
      t: "web.subscribeAck",
      requestId: String(msg.requestId ?? ""),
      workspaceId: msg.workspaceId ?? null,
      sinceSeq: 0,
      bufferedCount: 0,
      serverSeq: seqCounter,
    });
  }
  // 其余客户端消息（client.preempt.respond 等）在本骨架不处理，静默忽略。
}

/** WS 握手用 ticket 识别测试身份；管理后台类 spec 会在 ws-bridge 返回超管 ticket。 */
type MockHelloIdentity = {
  accountRole: string;
  homePath: string;
  userSummary: {
    userId: string;
    email: string;
    fullName: string;
    phone: string;
    avatarUrl: string | null;
    accountRole: string;
    status: string;
    enterpriseId: string | null;
    enterpriseName: string | null;
  };
  accessContext: {
    identityType: string;
    editionType: string;
    editionStatus: string;
    effectiveAccessScope: string;
    enterpriseId: string | null;
    enterpriseName: string | null;
  };
};

const MOCK_SUPER_ADMIN_TICKET_SUFFIX = "-super-admin";

const MOCK_ENTERPRISE_HELLO: MockHelloIdentity = {
  accountRole: "enterprise_admin",
  homePath: "/chat",
  userSummary: {
    userId: "chat-core-e2e-user",
    email: "chat-core-e2e@test.local",
    fullName: "E2E 用户",
    phone: "",
    avatarUrl: null,
    accountRole: "enterprise_admin",
    status: "active",
    enterpriseId: "enterprise_chat_core_e2e",
    enterpriseName: "E2E 企业",
  },
  accessContext: {
    identityType: "ENTERPRISE_ADMIN",
    editionType: "COMMUNITY",
    editionStatus: "ACTIVE",
    effectiveAccessScope: "ENTERPRISE_ADMIN",
    enterpriseId: "enterprise_chat_core_e2e",
    enterpriseName: "E2E 企业",
  },
};

const MOCK_SUPER_ADMIN_HELLO: MockHelloIdentity = {
  accountRole: "super_admin",
  homePath: "/admin",
  userSummary: {
    userId: "super_admin_01",
    email: "admin@example.test",
    fullName: "平台管理员",
    phone: "",
    avatarUrl: null,
    accountRole: "super_admin",
    status: "active",
    enterpriseId: null,
    enterpriseName: null,
  },
  accessContext: {
    identityType: "SUPER_ADMIN",
    editionType: "COMMUNITY",
    editionStatus: "ACTIVE",
    effectiveAccessScope: "SUPER_ADMIN",
    enterpriseId: null,
    enterpriseName: null,
  },
};

/** 按握手 ticket 选择超管或企业管理员身份；缺省保持企业管理员，兼容聊天/编排类 spec。 */
function resolveMockHelloIdentity(ticket: string): MockHelloIdentity {
  return ticket.endsWith(MOCK_SUPER_ADMIN_TICKET_SUFFIX) ? MOCK_SUPER_ADMIN_HELLO : MOCK_ENTERPRISE_HELLO;
}

/** 处理 /ws/web 的升级握手，并回 web.helloAck。 */
function handleWsUpgrade(req: IncomingMessage, socket: Duplex): void {
  const key = String(req.headers["sec-websocket-key"] ?? "");
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n"
    + "Upgrade: websocket\r\n"
    + "Connection: Upgrade\r\n"
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const conn: WsConn = {
    socket,
    webSessionId: randomUUID(),
    workspaceId: url.searchParams.get("wid") || null,
    buffer: Buffer.alloc(0),
  };
  const identity = resolveMockHelloIdentity(String(url.searchParams.get("ticket") ?? ""));
  wsConns.add(conn);
  console.log(`[mock-ws] upgrade ok session=${conn.webSessionId} role=${identity.accountRole}`);
  sendWs(conn, {
    t: "web.helloAck",
    webSessionId: conn.webSessionId,
    serverNow: now(),
    authMode: "account",
    accountRole: identity.accountRole,
    homePath: identity.homePath,
    userSummary: identity.userSummary,
    accessContext: identity.accessContext,
  });
  sendWs(conn, buildPresencePayload());
  socket.on("data", (chunk: Buffer) => {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    try {
      let parsed = parseClientFrame(conn.buffer);
      while (parsed) {
        conn.buffer = conn.buffer.subarray(parsed.consumed);
        if (parsed.opcode === 0x8) {
          socket.end();
          wsConns.delete(conn);
          return;
        }
        if (parsed.opcode === 0x9) {
          socket.write(encodeControlFrame(0xa, Buffer.alloc(0))); // ping -> pong
        } else if (parsed.opcode === 0x1 && parsed.text) {
          handleWsMessage(conn, parsed.text);
        }
        parsed = parseClientFrame(conn.buffer);
      }
    } catch (error) {
      console.log(`[mock-ws] frame error ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  socket.on("close", (code) => {
    console.log(`[mock-ws] close code=${code} session=${conn.webSessionId}`);
    wsConns.delete(conn);
  });
  socket.on("error", (error: unknown) => {
    console.log(`[mock-ws] error ${error instanceof Error ? error.message : String(error)}`);
    wsConns.delete(conn);
  });
}

// ===== threads REST 端点 =====

function handleThreadsRoutes(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/threads/groups") {
    sendJson(res, 200, { ok: true, groups: [] });
    return true;
  }

  if (req.method === "GET" && path === "/api/threads") {
    sendJson(res, 200, {
      ok: true,
      threads: [...threads.values()].map(toThreadSummary),
      runningByThreadId: {},
      hasMore: false,
      nextCursor: null,
    });
    return true;
  }

  if (req.method === "POST" && path === "/api/threads/create") {
    void readJsonBody(req).then((body) => {
      const threadId = randomUUID();
      const engine = String(body.engine ?? "codex");
      const title = String(body.title ?? "").trim() || "新会话";
      const created = now();
      threads.set(threadId, {
        id: threadId,
        title,
        threadType: "chat",
        engine,
        createdAt: created,
        updatedAt: created,
        events: [],
      });
      broadcast("workspace_chat_core_e2e", {
        t: "threads.changed",
        workspaceId: "workspace_chat_core_e2e",
        threadId,
        kind: "created",
      });
      sendJson(res, 200, { ok: true, threadId, engine });
    }).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  if (req.method === "POST" && path === "/api/threads/send") {
    void readJsonBody(req).then((body) => {
      const threadId = String(body.threadId ?? "");
      const text = String(body.text ?? "");
      const thread = threads.get(threadId);
      if (!thread) {
        sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: "thread not found" });
        return;
      }
      const turnId = randomUUID();
      const userEvent = pushEvent(thread, "item.userMessage.created", { itemId: randomUUID(), text });
      const agentEvent = pushEvent(thread, "item.agentMessage.completed", {
        itemId: randomUUID(),
        engineMessageId: randomUUID(),
        text: `已收到：${text}`,
        revision: 1,
      });
      broadcast("workspace_chat_core_e2e", { t: "conversation.event", event: userEvent });
      broadcast("workspace_chat_core_e2e", { t: "conversation.event", event: agentEvent });
      sendJson(res, 200, { ok: true, turnId, dispatchMode: "chat_turn" });
    }).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  if (req.method === "POST" && path === "/api/threads/load") {
    void readJsonBody(req).then((body) => {
      const thread = threads.get(String(body.threadId ?? ""));
      if (!thread) {
        sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: "thread not found" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        thread: { ...toThreadSummary(thread), workspaceId: "workspace_chat_core_e2e", sessionId: null },
        events: thread.events,
      });
    }).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  if (req.method === "POST" && path === "/api/threads/rename") {
    void readJsonBody(req).then((body) => {
      const thread = threads.get(String(body.threadId ?? ""));
      const title = String(body.title ?? "").trim();
      if (!thread) {
        sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: "thread not found" });
        return;
      }
      thread.title = title || thread.title;
      thread.updatedAt = now();
      broadcast("workspace_chat_core_e2e", {
        t: "threads.changed",
        workspaceId: "workspace_chat_core_e2e",
        threadId: thread.id,
        kind: "updated",
        patch: { title: thread.title, updatedAt: thread.updatedAt },
      });
      sendJson(res, 200, { ok: true });
    }).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  if (req.method === "POST" && path === "/api/threads/delete") {
    void readJsonBody(req).then((body) => {
      const threadId = String(body.threadId ?? "");
      if (!threads.delete(threadId)) {
        sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: "thread not found" });
        return;
      }
      broadcast("workspace_chat_core_e2e", {
        t: "threads.changed",
        workspaceId: "workspace_chat_core_e2e",
        threadId,
        kind: "deleted",
      });
      sendJson(res, 200, { ok: true });
    }).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  if (req.method === "POST" && path === "/api/threads/draft/get") {
    void readJsonBody(req).then(() => {
      sendJson(res, 200, { ok: true, draft: null });
    }).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  if (req.method === "POST" && path === "/api/threads/file-changes/list") {
    void readJsonBody(req).then(() => {
      sendJson(res, 200, { ok: true, items: [] });
    }).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return true;
  }

  return false;
}

/** Handles public/auth endpoints plus the thread endpoints required by black-box UI baseline tests. */
async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (handleThreadsRoutes(req, res, url)) return;
  if (req.method === "GET" && url.pathname === "/api/workspaces") {
    sendJson(res, 200, {
      ok: true,
      workspaces: [{
        id: "workspace_chat_core_e2e",
        title: "E2E 工作区",
        path: "D:/e2e-workspace",
        createdAt: 1,
        updatedAt: 1,
        kind: "local",
      }],
      resolvedCurrentWorkspaceId: "workspace_chat_core_e2e",
      workspaceListAuthoritative: true,
    });
    return;
  }
  // 新建会话前 Web 会先取知识库快照（未初始化即视为不启用知识），并把失败当成创建失败；
  // 这里返回「未初始化」的最小合法快照，避免缺端点把会话创建整条链路打断。
  if (req.method === "GET" && url.pathname === "/api/knowledge/assets/snapshot") {
    sendJson(res, 200, {
      ok: true,
      data: {
        initialized: false,
        knowledgeId: null,
        root: "",
        tree: { schemaVersion: 1, instructions: "", nodes: [] },
        treeHash: null,
        states: [],
        canWrite: false,
      },
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/threads/latest-prefs") {
    sendJson(res, 200, { ok: true, prefs: null });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/engines/status") {
    sendJson(res, 200, {
      ok: true,
      engines: [
        { engineType: "codex", installed: true, version: "0.1.0", binPath: null, features: {}, models: [{ id: "gpt-6.2-sol", displayName: "GPT-6.2 Sol", providerId: "openai", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }], defaultReasoningEffort: "high" }], providerCredentialStatus: [{ providerId: "openai", available: true, sources: [], message: null }], error: null },
        { engineType: "claude", installed: true, version: "0.1.0", binPath: null, features: {}, models: [{ id: "claude-fable-5-2", displayName: "Claude Fable 5.2", providerId: "anthropic", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }], defaultReasoningEffort: "high" }], providerCredentialStatus: [{ providerId: "anthropic", available: true, sources: [], message: null }], error: null },
      ],
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/account/me/relay/key") {
    sendJson(res, 200, {
      ok: true,
      status: {
        state: mockRelay.state,
        publicBaseUrl: mockRelay.publicBaseUrl,
        providerGroupsConfigured: mockRelay.providerGroupsConfigured,
      },
      item: null,
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/account/me/relay/key/ensure") {
    void readJsonBody(req).then((body) => {
      if (mockRelay.ensureFailureCode) {
        sendJson(res, 500, { ok: false, code: mockRelay.ensureFailureCode, message: "测试：内置中转 Key 同步失败" });
        return;
      }
      const providerId = String(body.providerId ?? "openai").trim() || "openai";
      sendJson(res, 200, {
        ok: true,
        status: {
          state: mockRelay.state,
          publicBaseUrl: mockRelay.publicBaseUrl,
          providerGroupsConfigured: mockRelay.providerGroupsConfigured,
        },
        item: { integrationStatus: "synced", codeflowApiKeyId: `mock-relay-${providerId}` },
        key: { providerId, rawKey: "codeflowai_E2E_RELAY_KEY_0123456789", apiKeyId: `mock-relay-${providerId}`, keyPrefix: "codeflowai_" },
      });
    }).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/test/relay-key-state") {
    void readJsonBody(req).then((body) => {
      mockRelay = {
        state: body.state === "enabled" ? "enabled" : "disabled",
        publicBaseUrl: String(body.publicBaseUrl ?? "").trim(),
        providerGroupsConfigured: (body.providerGroupsConfigured as Record<string, boolean> | undefined) ?? {},
        ensureFailureCode: typeof body.ensureFailureCode === "string" && body.ensureFailureCode ? body.ensureFailureCode : null,
      };
      sendJson(res, 200, { ok: true });
    }).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/test/engine-keys") {
    void readJsonBody(req).then((body) => {
      const keys = Array.isArray(body.keys) ? body.keys : [];
      mockEngineKeys = keys.map((raw) => {
        const key = raw as Partial<MockEngineKey>;
        mockEngineKeySeq += 1;
        return {
          id: String(key.id ?? `engine-key-${mockEngineKeySeq}`),
          label: String(key.label ?? ""),
          engine: key.engine === "claude" ? "claude" : "codex",
          providerId: String(key.providerId ?? "openai"),
          apiKey: String(key.apiKey ?? "masked"),
          baseUrl: typeof key.baseUrl === "string" ? key.baseUrl : null,
          isActive: key.isActive !== false,
          createdAt: now(),
          updatedAt: now(),
        };
      });
      sendJson(res, 200, { ok: true, keys: mockEngineKeys });
    }).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  // 模拟真实 Server 的「引擎 Key 已变化」广播：引擎 Key 是 Client 全局事实，不按工作区过滤，
  // 因此发给全部 Web 连接（与 clientWs.broadcastEngineKeysChanged 一致，勿改成按 conn.workspaceId 过滤）。
  if (req.method === "POST" && url.pathname === "/api/test/engine-keys-changed") {
    for (const conn of wsConns) sendWs(conn, { t: "engineKeys.changed" });
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/test/reset") {
    threads.clear();
    seqCounter = 0;
    mockRelay = defaultMockRelayState();
    mockEngineKeys = [];
    mockEngineKeySeq = 0;
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/engine-keys") {
    sendJson(res, 200, { ok: true, keys: mockEngineKeys });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/engine-keys") {
    void readJsonBody(req).then((body) => {
      const engine = body.engine === "claude" ? "claude" : "codex";
      const key = upsertMockEngineKey({
        id: typeof body.id === "string" && body.id ? body.id : undefined,
        label: String(body.label ?? ""),
        engine,
        providerId: String(body.providerId ?? "openai"),
        apiKey: String(body.apiKey ?? ""),
        baseUrl: typeof body.baseUrl === "string" && body.baseUrl ? body.baseUrl : null,
      });
      sendJson(res, 200, { ok: true, key });
    }).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if ((req.method === "POST" && url.pathname === "/api/engine-keys/activate")
    || (req.method === "POST" && url.pathname === "/api/engine-keys/deactivate")) {
    void readJsonBody(req).then((body) => {
      const id = String(body.id ?? "");
      const key = url.pathname.endsWith("/deactivate")
        ? (() => {
            const target = mockEngineKeys.find((item) => item.id === id) ?? null;
            if (target) target.isActive = false;
            return target;
          })()
        : activateMockEngineKey(id);
      if (!key) {
        sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: "测试：Key 不存在" });
        return;
      }
      sendJson(res, 200, { ok: true, key });
    }).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/orch/intakes") {
    sendJson(res, 200, { ok: true, intakes: [], hasMore: false, nextCursor: null, statusCounts: [], totalCount: 0, listMetaById: {} });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/orch/instances") {
    sendJson(res, 200, { ok: true, instances: [], hasMore: false, nextCursor: null });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/orch/workflows") {
    sendJson(res, 200, { ok: true, workflows: [] });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/orch/requirement-analysis/sessions") {
    sendJson(res, 200, { ok: true, sessions: [], hasMore: false, nextCursor: null, totalCount: 0 });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/fs/tree") {
    sendJson(res, 200, { ok: true, nodes: [
      { name: "src", path: "src", isDir: true, children: [
        { name: "index.ts", path: "src/index.ts", isDir: false, size: 128, mtime: "2026-01-01T00:00:00Z" },
        { name: "README.md", path: "src/README.md", isDir: false, size: 64, mtime: "2026-01-01T00:00:00Z" },
      ] },
    ] });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/fs/readFile") {
    void readJsonBody(req).then((body) => {
      const filePath = String(body.path ?? "");
      const isMarkdown = filePath.endsWith(".md");
      sendJson(res, 200, {
        ok: true,
        path: filePath,
        content: isMarkdown ? "# 示例文档\n\n这是资源预览的示例内容。" : "export const hello = () => \"你好\";\n",
        isBinary: false,
        size: 128,
        mimeType: isMarkdown ? "text/markdown" : "text/typescript",
        encoding: "utf8",
      });
    }).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/workspaces/prefs") {
    sendJson(res, 200, { ok: true, prefs: {} });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/reminders/items") {
    void readJsonBody(req).then((body) => {
      const workspaceId = String(body.workspaceId ?? "workspace_chat_core_e2e");
      sendJson(res, 200, { ok: true, summary: { workspaceId, pendingActionCount: 0, pendingReceiptCount: 0, updatedAt: null }, items: [] });
    }).catch((error: unknown) => {
      sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/reminders/workspaces") {
    sendJson(res, 200, { ok: true, summaries: [] });
    return;
  }
  if (url.pathname === "/api/account/me/model-context-preferences") {
    // 创建会话会读取账号模型偏好；E2E 不依赖真实偏好，统一返回空集合。
    sendJson(res, 200, { ok: true, preferences: [] });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/account/me/summary") {
    // 用例通过 sessionToken 标识注入身份；摘要必须与注入角色一致，避免覆盖为固定企业管理员。
    const authorization = String(req.headers.authorization ?? "");
    const superAdmin = authorization.includes("super-admin") || authorization.includes("relay-pricing");
    sendJson(res, 200, {
      ok: true,
      userId: superAdmin ? "super-admin-e2e" : "chat-core-e2e-user",
      email: superAdmin ? "super-admin@test.local" : "chat-core-e2e@test.local",
      fullName: superAdmin ? "平台管理员" : "E2E 用户",
      phone: "",
      avatarUrl: null,
      accountRole: superAdmin ? "super_admin" : "enterprise_admin",
      accessContext: superAdmin
        ? { identityType: "SUPER_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "SUPER_ADMIN", enterpriseId: null, enterpriseName: null }
        : { identityType: "ENTERPRISE_ADMIN", editionType: "COMMUNITY", editionStatus: "ACTIVE", effectiveAccessScope: "ENTERPRISE_ADMIN", enterpriseId: "enterprise_chat_core_e2e", enterpriseName: "E2E 企业" },
      enterpriseSummary: superAdmin ? null : { enterpriseId: "enterprise_chat_core_e2e", name: "E2E 企业", status: "active", entitlement: { openedAt: 1, source: "LEGACY", sourceId: "e2e" } },
      pendingEnterpriseInvitations: [],
      keySummary: null,
      securitySummary: null,
      inviteCode: "",
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/account/in-app-notices/active") {
    sendJson(res, 200, { ok: true, items: [], serverNow: Date.now() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, { ok: true, status: "ready" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/orch/roles") {
    sendJson(res, 200, { ok: true, roles: [] });
    return;
  }
  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/public/contact-info") {
    sendJson(res, 200, {
      ok: true,
      contactInfo: {
        phone: "",
        email: "support@example.test",
        wechatContacts: [],
        wechatGroupQrImage: "",
        officialAccountQrImage: "",
        address: "",
      },
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/public/personal-package/plans") {
    sendJson(res, 200, { ok: true, plans: [] });
    return;
  }
  if (req.method === "POST" && url.pathname.endsWith("/api/account/auth/login")) {
    const body = await readJsonBody(req);
    const email = String(body.email ?? "").trim();
    if (!email) {
      sendJson(res, 400, { ok: false, code: "BAD_REQUEST", message: "缺少邮箱" });
      return;
    }
    sendJson(res, 401, { ok: false, code: "INVALID_CREDENTIALS", message: "邮箱或密码不正确" });
    return;
  }
  if (req.method === "POST" && url.pathname.endsWith("/api/account/auth/check-email")) {
    sendJson(res, 200, { ok: true, exists: false });
    return;
  }
  if (req.method === "POST" && url.pathname.endsWith("/api/account/me/ws-bridge")) {
    sendJson(res, 200, { ok: true, bridgeToken: "mock-bridge-token" });
    return;
  }
  console.log(`[mock-404] ${req.method ?? "GET"} ${url.pathname}`);
  sendJson(res, 404, { ok: false, code: "NOT_FOUND", message: `${req.method ?? "GET"} ${url.pathname} is not mocked` });
}

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 500, { ok: false, code: "MOCK_SERVER_ERROR", message });
  });
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/ws/web") {
    socket.destroy();
    return;
  }
  handleWsUpgrade(req, socket);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock-codeflow-server listening on http://127.0.0.1:${port}`);
});
