import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSharedWorkspaceHostToolPolicy,
  evaluateSharedWorkspaceProviderNativeToolPolicy,
} from "../../apps/desktop/client/src/app/sharedWorkspaceToolPolicy.ts";
import { MANAGED_SERVICE_TOOL_ID } from "../../apps/desktop/client/src/orchestration/managedServiceRuntime.ts";

const personalContext = {
  sharedWorkspaceId: "sw_tool",
  operationId: "op_personal" as any,
  operationKey: "ai.thread.send.personal" as const,
  toolPolicyKey: "ai.personal.readonly" as const,
};

const sharedContext = {
  ...personalContext,
  operationId: "op_shared" as any,
  operationKey: "ai.thread.send.shared" as const,
  toolPolicyKey: "ai.shared.write" as const,
  lockToken: "lock-token",
  lockVersion: 2,
};

test("shared workspace personal AI policy blocks managed service side effects before execution", () => {
  const managedTool = {
    toolId: MANAGED_SERVICE_TOOL_ID as any,
    runtime: "builtin" as const,
    permissions: { requiresWrite: false },
  };

  const readDecision = evaluateSharedWorkspaceHostToolPolicy({
    context: personalContext,
    tool: managedTool,
    toolInput: { action: "status", serviceId: "dev-server" },
  });
  assert.equal(readDecision.allowed, true);

  const writeDecision = evaluateSharedWorkspaceHostToolPolicy({
    context: personalContext,
    tool: managedTool,
    toolInput: { action: "ensure", serviceId: "dev-server", command: "node", args: [] },
  });
  assert.equal(writeDecision.allowed, false);
  assert.equal(writeDecision.allowed ? "" : writeDecision.code, "SHARED_WORKSPACE_TOOL_LOCK_REQUIRED");

  const roleCommandDecision = evaluateSharedWorkspaceHostToolPolicy({
    context: personalContext,
    tool: {
      toolId: "role.shell" as any,
      runtime: "node" as const,
      permissions: { requiresWrite: false },
    },
    toolInput: { command: "node scripts/check.js" },
  });
  assert.equal(roleCommandDecision.allowed, true);

  const roleWriteDecision = evaluateSharedWorkspaceHostToolPolicy({
    context: personalContext,
    tool: {
      toolId: "role.write" as any,
      runtime: "builtin" as const,
      permissions: { requiresWrite: true },
    },
    toolInput: { path: "README.md" },
  });
  assert.equal(roleWriteDecision.allowed, true);

  const sharedDecision = evaluateSharedWorkspaceHostToolPolicy({
    context: sharedContext,
    tool: managedTool,
    toolInput: { action: "ensure", serviceId: "dev-server", command: "node", args: [] },
  });
  assert.equal(sharedDecision.allowed, true);
});

test("shared workspace personal AI policy blocks provider-native write tools and allows read tools", () => {
  const readDecision = evaluateSharedWorkspaceProviderNativeToolPolicy({
    context: personalContext,
    provider: "claude",
    toolName: "Read",
    toolInput: { file_path: "README.md" },
  });
  assert.equal(readDecision.allowed, true);

  const writeDecision = evaluateSharedWorkspaceProviderNativeToolPolicy({
    context: personalContext,
    provider: "codex",
    toolName: "item/tool/requestApproval",
    toolInput: { tool: "commandExecution", command: "echo changed > README.md" },
  });
  assert.equal(writeDecision.allowed, false);
  assert.equal(writeDecision.allowed ? "" : writeDecision.operationKey, "terminal.action");

  const sharedDecision = evaluateSharedWorkspaceProviderNativeToolPolicy({
    context: sharedContext,
    provider: "codex",
    toolName: "item/tool/requestApproval",
    toolInput: { tool: "commandExecution", command: "echo changed > README.md" },
  });
  assert.equal(sharedDecision.allowed, true);
});
