import test from "node:test";
import assert from "node:assert/strict";

import { resolveWorkspaceRuntimeDisplay } from "../src/utils/workspaceRuntimeDisplay.ts";

test("shared workspace runtime display uses Host status instead of account Client status", () => {
  assert.deepEqual(
    resolveWorkspaceRuntimeDisplay({ kind: "shared", status: "online" }, "offline"),
    { subject: "host", status: "online", tone: "online", label: "Host 在线", title: "共享工作区 Host: 在线" },
  );
  assert.equal(resolveWorkspaceRuntimeDisplay({ kind: "shared", status: "offline" }, "online").label, "Host 离线");
  assert.equal(resolveWorkspaceRuntimeDisplay({ kind: "shared", status: "unbound" }, "online").label, "Host 未绑定");
  assert.equal(resolveWorkspaceRuntimeDisplay({ kind: "shared", status: "unknown" }, "offline").label, "Host 确认中");
  assert.equal(resolveWorkspaceRuntimeDisplay({ kind: "shared", status: "forbidden" }, "online").label, "Host 不可用");
});

test("local and empty workspace runtime display keeps Client semantics", () => {
  assert.equal(resolveWorkspaceRuntimeDisplay({ kind: "local", status: "online" }, "offline").label, "Client 在线");
  assert.equal(resolveWorkspaceRuntimeDisplay({ kind: "local", status: "offline" }, "online").label, "Client 离线");
  assert.equal(resolveWorkspaceRuntimeDisplay({ kind: "local", status: "unknown" }, "online").label, "Client 确认中");
  assert.equal(resolveWorkspaceRuntimeDisplay({ kind: "none", status: "ready" }, "online").label, "Client 在线");
});
