import assert from "node:assert/strict";
import test from "node:test";

import { isDesktopTerminalEvent } from "@codeflowai/shared";

const terminal = { id: "term-1", workspaceId: "local-client:workspace", label: "Terminal", shell: null, cwd: null,
  status: "running", exitCode: null, createdAt: 1, foregroundProcess: null };

test("desktop terminal contract accepts complete runtime events", () => {
  assert.equal(isDesktopTerminalEvent({ t: "terminal.created", clientId: "local-client", terminal }), true);
  assert.equal(isDesktopTerminalEvent({ t: "terminal.output", clientId: "local-client", workspaceId: "local-client:workspace", terminalId: "term-1", data: "" }), true);
  assert.equal(isDesktopTerminalEvent({ t: "terminal.exited", clientId: "local-client", workspaceId: "local-client:workspace", terminalId: "term-1", exitCode: 0 }), true);
  assert.equal(isDesktopTerminalEvent({ t: "terminal.closed", clientId: "local-client", workspaceId: "local-client:workspace", terminalId: "term-1" }), true);
  assert.equal(isDesktopTerminalEvent({ t: "terminal.renamed", clientId: "local-client", workspaceId: "local-client:workspace", terminalId: "term-1", label: "Build" }), true);
  assert.equal(isDesktopTerminalEvent({ t: "terminal.foregroundChanged", clientId: "local-client", workspaceId: "local-client:workspace", terminalId: "term-1", foregroundProcess: null }), true);
  assert.equal(isDesktopTerminalEvent({ t: "terminal.listed", clientId: "local-client", workspaceId: "local-client:workspace", terminals: [{ ...terminal, scrollback: "ok" }] }), true);
  assert.equal(isDesktopTerminalEvent({ t: "terminal.error", clientId: "local-client", workspaceId: "local-client:workspace", message: "failed" }), true);
});

test("desktop terminal contract rejects missing ownership, foreign terminals and unknown shapes", () => {
  assert.equal(isDesktopTerminalEvent({ t: "terminal.output", workspaceId: "local-client:workspace", terminalId: "term-1", data: "ok" }), false);
  assert.equal(isDesktopTerminalEvent({ t: "terminal.output", clientId: "local-client", terminalId: "term-1", data: "ok" }), false);
  assert.equal(isDesktopTerminalEvent({ t: "terminal.listed", clientId: "local-client", workspaceId: "local-client:workspace",
    terminals: [{ ...terminal, workspaceId: "other-client:workspace" }] }), false);
  assert.equal(isDesktopTerminalEvent({ t: "terminal.created", clientId: "local-client", terminal: { ...terminal, status: "unknown" } }), false);
  assert.equal(isDesktopTerminalEvent({ t: "terminal.exited", clientId: "local-client", workspaceId: "local-client:workspace", terminalId: "term-1", exitCode: 1.5 }), false);
  assert.equal(isDesktopTerminalEvent({ t: "terminal.unknown", clientId: "local-client", workspaceId: "local-client:workspace" }), false);
  assert.equal(isDesktopTerminalEvent({ t: "engineKeys.changed" }), false);
});
