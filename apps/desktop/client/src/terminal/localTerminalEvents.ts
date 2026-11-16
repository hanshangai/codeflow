import type { ClientToServerMessage, DesktopTerminalEvent } from "@codeflowai/shared";

/** 本机投递为终端主通道；云副本拒绝必须令云模块显式失败，不能影响本机PTY。 */
export function publishTerminalRuntimeMessage(message: ClientToServerMessage, deps: {
  clientId: string;
  publishLocal(event: DesktopTerminalEvent): void;
  cloud?: { send(message: ClientToServerMessage): { accepted: boolean; reason?: string | null }; fail(error: Error): void };
}): void {
  const event = toDesktopTerminalEvent(message, deps.clientId);
  deps.publishLocal(event);
  if (!deps.cloud) return;
  const result = deps.cloud.send(message);
  if (result.accepted) return;
  const workspaceId = event.t === "terminal.created" ? event.terminal.workspaceId : event.workspaceId;
  const terminalId = event.t === "terminal.created" ? event.terminal.id : "terminalId" in event ? event.terminalId : undefined;
  deps.cloud.fail(Object.assign(new Error("终端云同步副本被拒绝"), { code: "TERMINAL_CLOUD_EVENT_REJECTED", clientId: deps.clientId,
    messageType: event.t, workspaceId, terminalId, requestId: "requestId" in event ? event.requestId : undefined, reason: result.reason }));
}

/** 终端事件必须携带已注册本机工作区；缺失时显式失败，不投递无归属事件。 */
function requireWorkspaceId(value: unknown): string {
  const workspaceId = typeof value === "string" ? value.trim() : "";
  if (!workspaceId) throw Object.assign(new Error("终端本机事件缺少 workspaceId"), { code: "TERMINAL_LOCAL_EVENT_WORKSPACE_REQUIRED" });
  return workspaceId;
}

/** 将本机终端运行消息转换成 desktop.event；clientId 只在此可信边界注入。 */
export function toDesktopTerminalEvent(message: ClientToServerMessage, clientId: string): DesktopTerminalEvent {
  const normalizedClientId = String(clientId ?? "").trim();
  if (!normalizedClientId) throw Object.assign(new Error("终端本机事件缺少 clientId"), { code: "TERMINAL_LOCAL_EVENT_CLIENT_REQUIRED" });
  switch (message.t) {
    case "terminal.created":
      return { t: "terminal.created", clientId: normalizedClientId,
        terminal: { ...message.terminal, workspaceId: requireWorkspaceId(message.terminal.workspaceId) },
        ...(message.requestId ? { requestId: message.requestId } : {}) };
    case "terminal.output":
      return { t: "terminal.output", clientId: normalizedClientId, workspaceId: requireWorkspaceId(message.workspaceId),
        terminalId: message.terminalId, data: message.data };
    case "terminal.exited":
      return { t: "terminal.exited", clientId: normalizedClientId, workspaceId: requireWorkspaceId(message.workspaceId),
        terminalId: message.terminalId, exitCode: message.exitCode };
    case "terminal.closed":
      return { t: "terminal.closed", clientId: normalizedClientId, workspaceId: requireWorkspaceId(message.workspaceId),
        terminalId: message.terminalId };
    case "terminal.renamed":
      return { t: "terminal.renamed", clientId: normalizedClientId, workspaceId: requireWorkspaceId(message.workspaceId),
        terminalId: message.terminalId, label: message.label };
    case "terminal.foregroundChanged":
      return { t: "terminal.foregroundChanged", clientId: normalizedClientId, workspaceId: requireWorkspaceId(message.workspaceId),
        terminalId: message.terminalId, foregroundProcess: message.foregroundProcess };
    case "terminal.listed": {
      const workspaceId = requireWorkspaceId(message.workspaceId);
      return { t: "terminal.listed", clientId: normalizedClientId, workspaceId,
        ...(message.requestId ? { requestId: message.requestId } : {}),
        terminals: message.terminals.map((terminal) => ({ ...terminal, workspaceId: requireWorkspaceId(terminal.workspaceId ?? workspaceId) })) };
    }
    case "terminal.error":
      return { t: "terminal.error", clientId: normalizedClientId, workspaceId: requireWorkspaceId(message.workspaceId),
        ...(message.terminalId ? { terminalId: message.terminalId } : {}),
        ...(message.requestId ? { requestId: message.requestId } : {}), message: message.message };
    default:
      throw Object.assign(new Error(`终端本机事件类型不支持：${(message as { t: string }).t}`), { code: "TERMINAL_LOCAL_EVENT_UNSUPPORTED" });
  }
}
