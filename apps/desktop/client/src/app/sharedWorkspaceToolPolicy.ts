import type {
  ExecutableToolDescriptor,
  SharedWorkspaceOperationId,
  SharedWorkspaceOperationKey,
  SharedWorkspaceToolPolicyKey,
} from "@codeflowai/shared";

import type { HostToolExecutionResult } from "../engines/threadSession.js";
import { MANAGED_SERVICE_TOOL_ID } from "../orchestration/managedServiceRuntime.js";

export type SharedWorkspaceToolExecutionContext = {
  sharedWorkspaceId: string;
  operationId: SharedWorkspaceOperationId;
  routeEventId?: string | null;
  operationKey: SharedWorkspaceOperationKey;
  toolPolicyKey: SharedWorkspaceToolPolicyKey | null;
  lockToken?: string | null;
  lockVersion?: number | null;
  allowSharedUpgrade?: boolean | null;
};

export type SharedWorkspaceToolPolicyDecision =
  | { allowed: true; reason: "no-context" | "shared-write" | "read-only-tool" | "interactive-tool" }
  | { allowed: false; code: "SHARED_WORKSPACE_TOOL_LOCK_REQUIRED"; message: string; operationKey: SharedWorkspaceOperationKey };

export function readSharedWorkspaceToolExecutionContext(body: Record<string, unknown>): SharedWorkspaceToolExecutionContext | null {
  const sharedWorkspaceId = stringValue(body.sharedWorkspaceId);
  const operationId = stringValue(body.sharedWorkspaceOperationId);
  const operationKey = stringValue(body.sharedWorkspaceOperationKey) || stringValue(body.sharedWorkspaceParentOperationKey);
  if (!sharedWorkspaceId || !operationId) return null;
  return {
    sharedWorkspaceId,
    operationId: operationId as SharedWorkspaceOperationId,
    routeEventId: stringValue(body.sharedWorkspaceRouteEventId),
    operationKey: (operationKey || "ai.thread.send.personal") as SharedWorkspaceOperationKey,
    toolPolicyKey: (stringValue(body.sharedWorkspaceToolPolicyKey) || null) as SharedWorkspaceToolPolicyKey | null,
    lockToken: stringValue(body.sharedWorkspaceLockToken),
    lockVersion: numberValue(body.sharedWorkspaceLockVersion),
    allowSharedUpgrade: typeof body.sharedWorkspaceAllowSharedUpgrade === "boolean"
      ? body.sharedWorkspaceAllowSharedUpgrade
      : null,
  };
}

export function evaluateSharedWorkspaceHostToolPolicy(input: {
  context: SharedWorkspaceToolExecutionContext | null | undefined;
  tool: Pick<ExecutableToolDescriptor, "toolId" | "runtime" | "permissions"> | null | undefined;
  toolInput: unknown;
}): SharedWorkspaceToolPolicyDecision {
  const context = input.context ?? null;
  if (!context) return { allowed: true, reason: "no-context" };
  if (context.toolPolicyKey === "ai.shared.write" || context.operationKey === "ai.thread.send.shared") {
    return { allowed: true, reason: "shared-write" };
  }
  const operationKey = resolveHostToolOperationKey(input.tool, input.toolInput);
  if (!operationKey) return { allowed: true, reason: "read-only-tool" };
  return denyWriteTool(operationKey);
}

export function evaluateSharedWorkspaceProviderNativeToolPolicy(input: {
  context: SharedWorkspaceToolExecutionContext | null | undefined;
  provider: "codex" | "claude";
  toolName: string;
  toolInput?: unknown;
}): SharedWorkspaceToolPolicyDecision {
  const context = input.context ?? null;
  if (!context) return { allowed: true, reason: "no-context" };
  if (context.toolPolicyKey === "ai.shared.write" || context.operationKey === "ai.thread.send.shared") {
    return { allowed: true, reason: "shared-write" };
  }
  const nativeKind = classifyProviderNativeTool(input.toolName, input.toolInput);
  if (nativeKind === "interactive") return { allowed: true, reason: "interactive-tool" };
  if (nativeKind === "read") return { allowed: true, reason: "read-only-tool" };
  return denyWriteTool(nativeKind === "terminal" ? "terminal.action" : "workspace.fs.write");
}

export function sharedWorkspaceToolDeniedResult(decision: Extract<SharedWorkspaceToolPolicyDecision, { allowed: false }>): HostToolExecutionResult {
  return {
    ok: false,
    code: decision.code,
    message: decision.message,
    output: {
      code: decision.code,
      message: decision.message,
      operationKey: decision.operationKey,
    },
    durationMs: 0,
  };
}

export function buildSharedWorkspaceProviderNativeDenyMessage(decision: Extract<SharedWorkspaceToolPolicyDecision, { allowed: false }>): string {
  return `${decision.message}（${decision.code}）`;
}

function resolveHostToolOperationKey(
  tool: Pick<ExecutableToolDescriptor, "toolId" | "runtime" | "permissions"> | null | undefined,
  toolInput: unknown,
): SharedWorkspaceOperationKey | null {
  if (!tool) return null;
  const toolId = String(tool.toolId ?? "").trim();
  if (toolId === MANAGED_SERVICE_TOOL_ID) {
    const action = stringValue((toolInput as Record<string, unknown> | null | undefined)?.action);
    return action === "ensure" || action === "stop" ? "terminal.action" : null;
  }
  return null;
}

function classifyProviderNativeTool(toolName: string, toolInput: unknown): "read" | "write" | "terminal" | "interactive" {
  const normalized = `${toolName} ${JSON.stringify(summarizeNativeInput(toolInput))}`.toLowerCase();
  if (
    normalized.includes("requestuserinput")
    || normalized.includes("askuser")
  ) {
    return "interactive";
  }
  if (
    normalized.includes("command")
    || normalized.includes("bash")
    || normalized.includes("shell")
    || normalized.includes("terminal")
    || normalized.includes("exec")
  ) {
    return "terminal";
  }
  if (
    normalized.includes("write")
    || normalized.includes("edit")
    || normalized.includes("patch")
    || normalized.includes("apply")
    || normalized.includes("delete")
    || normalized.includes("move")
    || normalized.includes("rename")
    || normalized.includes("filechange")
    || normalized.includes("git")
  ) {
    return "write";
  }
  if (
    normalized.includes("read")
    || normalized.includes("grep")
    || normalized.includes("search")
    || normalized.includes("glob")
    || normalized.includes("list")
    || normalized.includes("stat")
    || normalized.includes("view")
  ) {
    return "read";
  }
  if (normalized.includes("requestapproval") || normalized.includes("approval")) {
    return "interactive";
  }
  return "write";
}

function denyWriteTool(operationKey: SharedWorkspaceOperationKey): Extract<SharedWorkspaceToolPolicyDecision, { allowed: false }> {
  return {
    allowed: false,
    code: "SHARED_WORKSPACE_TOOL_LOCK_REQUIRED",
    message: "个人 AI 会话中的写工具需要切换到共享写入上下文",
    operationKey,
  };
}

function summarizeNativeInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ["tool", "tool_name", "name", "subtype", "command", "path", "file_path", "cwd"]) {
    if (typeof record[key] === "string") result[key] = record[key];
  }
  return result;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}
