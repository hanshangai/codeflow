import assert from "node:assert/strict";
import test from "node:test";

import { toDesktopTerminalEvent } from "../src/terminal/localTerminalEvents.js";

test("local terminal events inject the trusted clientId and keep workspace ownership", () => {
  assert.deepEqual(
    toDesktopTerminalEvent({ t: "terminal.output", terminalId: "term-1", workspaceId: "local-client:workspace", data: "ok" }, "local-client"),
    { t: "terminal.output", clientId: "local-client", workspaceId: "local-client:workspace", terminalId: "term-1", data: "ok" },
  );
  const created = toDesktopTerminalEvent({ t: "terminal.created", requestId: "create-1", terminal: {
    id: "term-1", workspaceId: "local-client:workspace", label: "Terminal", shell: null, cwd: null,
    status: "running", exitCode: null, createdAt: 1, foregroundProcess: null,
  } }, "local-client");
  assert.equal(created.t, "terminal.created");
  assert.equal((created as { clientId: string }).clientId, "local-client");
  assert.equal((created as { terminal: { workspaceId: string } }).terminal.workspaceId, "local-client:workspace");
});

/** 显式失败同时核对结构化错误码，避免只依赖中文消息。 */
const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === "object"
  && (error as { code?: unknown }).code === expected);

test("local terminal events fail explicitly when workspace ownership is missing", () => {
  assert.throws(() => toDesktopTerminalEvent({ t: "terminal.output", terminalId: "term-1", data: "ok" }, "local-client"),
    code("TERMINAL_LOCAL_EVENT_WORKSPACE_REQUIRED"));
  assert.throws(() => toDesktopTerminalEvent({ t: "terminal.listed", requestId: "list-1", terminals: [] }, "local-client"),
    code("TERMINAL_LOCAL_EVENT_WORKSPACE_REQUIRED"));
  assert.throws(() => toDesktopTerminalEvent({ t: "terminal.created", terminal: {
    id: "term-1", label: "Terminal", shell: null, cwd: null, status: "running", exitCode: null, createdAt: 1, foregroundProcess: null,
  } }, "local-client"), code("TERMINAL_LOCAL_EVENT_WORKSPACE_REQUIRED"));
});

test("local terminal events fail explicitly when the trusted clientId is missing", () => {
  assert.throws(() => toDesktopTerminalEvent({ t: "terminal.output", terminalId: "term-1", workspaceId: "workspace", data: "ok" }, "  "),
    code("TERMINAL_LOCAL_EVENT_CLIENT_REQUIRED"));
});
