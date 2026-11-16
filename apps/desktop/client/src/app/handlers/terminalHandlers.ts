import type { WorkspaceId } from "@codeflowai/shared";

import { logger } from "../../logger.js";
import type { TerminalManager } from "../../terminal/terminalManager.js";
import { readTerminalActions, writeTerminalActions } from "../../terminal/terminalActionsConfig.js";
import {
  listLaunchableTerminalShellOptions,
  resolveMacOSProtectedTerminalCwdHint,
  validateTerminalActionDefinition,
} from "../../terminal/terminalSecurityPolicy.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import type { ClientToServerMessage, ServerToClientMessage } from "../../protocol/messages.js";
import type { WorkspaceOperationGate } from "../../workspace-migration/workspaceOperationGate.js";

export type TerminalHandlerDeps = {
  terminalManager: TerminalManager;
  workspaces: Map<WorkspaceId, string>;
  workspaceOperationGate?: WorkspaceOperationGate;
  send: (msg: ClientToServerMessage) => void | { accepted: boolean };
};

/** 云账号只控制已登记工作区；执行和响应均复核原账号，业务仍沿原终端入口。 */
export function handleDesktopCloudTerminalMessage(deps: TerminalHandlerDeps & { assertOwner(): void }, msg: ServerToClientMessage): void {
  deps.assertOwner();
  const workspaceId = "workspaceId" in msg ? String(msg.workspaceId ?? "").trim() : "";
  if (!workspaceId || !deps.workspaces.has(workspaceId as WorkspaceId)) {
    throw Object.assign(new Error("云终端操作缺少已登记的本机工作区"), { code: "DESKTOP_CLOUD_TERMINAL_SCOPE_REQUIRED",
      workspaceId, terminalId: "terminalId" in msg ? msg.terminalId : undefined, requestId: "requestId" in msg ? msg.requestId : undefined });
  }
  handleTerminalMessage({ ...deps, send(message) { deps.assertOwner(); return deps.send(message); } }, msg);
}

/** 单个终端失败返回明确错误；投递只试一次，再失败保留原业务原因。 */
export function handleTerminalMessage(deps: TerminalHandlerDeps, msg: ServerToClientMessage): void {
  let responseAttempted = false;
  const send: TerminalHandlerDeps["send"] = message => {
    responseAttempted = true;
    const result = deps.send(message);
    if (result && !result.accepted) throw Object.assign(new Error("终端消息投递被拒绝"), { code: "TERMINAL_SEND_REJECTED" });
    return result;
  };
  try { handleTerminalCommand({ ...deps, send }, msg); }
  catch (error) {
    if (responseAttempted) throw error;
    try {
      const terminalId = "terminalId" in msg ? msg.terminalId : undefined;
      const terminal = terminalId ? deps.terminalManager.get(terminalId) : null;
      send({ t: "terminal.error", terminalId, workspaceId: terminal?.workspaceId ?? ("workspaceId" in msg ? msg.workspaceId : undefined),
        message: "终端操作失败，请重试或重新创建终端" });
    }
    catch (deliveryError) { throw new AggregateError([error, deliveryError], "终端操作与错误响应均失败", { cause: error }); }
  }
}

/** 原同步命令分派保留入口与副作用，延迟动作由 Manager entry 管理。 */
function handleTerminalCommand(deps: TerminalHandlerDeps, msg: ServerToClientMessage): void {
  if (msg.t === "terminal.create") {
    const workspaceId = String(msg.workspaceId ?? "").trim();
    if (!workspaceId) {
      deps.send({ t: "terminal.error", message: "参数错误：workspaceId" });
      return;
    }
    withWorkspaceWriteGate(deps, workspaceId as WorkspaceId, () => {
      deps.terminalManager.create({ workspaceId, requestId: msg.requestId, label: msg.label, shell: msg.shell, cwd: msg.cwd });
    });
    return;
  }

  if (msg.t === "terminal.input") {
    if (!terminalMatchesWorkspace(deps, msg.terminalId, msg.workspaceId)) return;
    deps.terminalManager.write(msg.terminalId, msg.data);
    return;
  }

  if (msg.t === "terminal.resize") {
    if (!terminalMatchesWorkspace(deps, msg.terminalId, msg.workspaceId)) return;
    deps.terminalManager.resize(msg.terminalId, msg.cols, msg.rows);
    return;
  }

  if (msg.t === "terminal.rename") {
    const terminal = deps.terminalManager.get(msg.terminalId);
    if (!terminalMatchesWorkspace(deps, msg.terminalId, msg.workspaceId)) return;
    const ok = deps.terminalManager.rename(msg.terminalId, msg.label);
    if (ok && terminal) {
      deps.send({ t: "terminal.renamed", terminalId: msg.terminalId, workspaceId: terminal.workspaceId, label: msg.label });
    } else {
      deps.send({ t: "terminal.error", terminalId: msg.terminalId, message: "终端不存在" });
    }
    return;
  }

  if (msg.t === "terminal.close") {
    const terminal = deps.terminalManager.get(msg.terminalId);
    if (!terminalMatchesWorkspace(deps, msg.terminalId, msg.workspaceId)) return;
    const closed = deps.terminalManager.close(msg.terminalId);
    if (closed && terminal) {
      deps.send({ t: "terminal.closed", terminalId: msg.terminalId, workspaceId: terminal.workspaceId });
    } else {
      deps.send({ t: "terminal.error", terminalId: msg.terminalId, message: "终端不存在" });
    }
    return;
  }

  if (msg.t === "terminal.list") {
    const workspaceId = String(msg.workspaceId ?? "").trim();
    let terminals = deps.terminalManager.list(workspaceId);
    // 恢复会启动进程，必须和 terminal.create 复用同一迁移门禁。
    if (!terminals.length) {
      withWorkspaceWriteGate(deps, workspaceId as WorkspaceId, () => {
        const restored = deps.terminalManager.restoreAll(workspaceId);
        if (restored.length) terminals = deps.terminalManager.list(workspaceId);
      });
    }
    deps.send({ t: "terminal.listed", requestId: msg.requestId, workspaceId, terminals });
    return;
  }

  if (msg.t === "terminal.runAction") {
    const workspaceId = String(msg.workspaceId ?? "").trim();
    const workspacePath = deps.workspaces.get(workspaceId as WorkspaceId) ?? null;
    if (!workspacePath) {
      deps.send({ t: "terminal.error", message: `未知 workspaceId：${workspaceId}` });
      return;
    }
    const actions = readTerminalActions(workspacePath);
    const action = actions.find((a) => a.id === msg.actionId);
    if (!action) {
      deps.send({ t: "terminal.error", message: `未知 actionId：${msg.actionId}` });
      return;
    }
    const info = withWorkspaceWriteGate(deps, workspaceId as WorkspaceId, () => deps.terminalManager.create({
      workspaceId, requestId: msg.requestId, label: action.label, shell: action.shell || undefined, cwd: action.cwd || undefined,
    }));
    // 延迟动作随现有终端生命周期取消与处理失败。
    if (action.command) deps.terminalManager.scheduleCommand(info.id, action.command, 500);
    return;
  }
}

/** 本机终端控制面只校验目标与运行时，云账号关联不改变本机归属。 */
export async function handleTerminalRuntimeApi(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const workspaceId = String(body.workspaceId ?? "").trim() as WorkspaceId;
  const respond = (status: number, responseBody: Record<string, unknown>): void => {
    ctx.send({ t: "api.res", id: req.id, status, body: responseBody });
  };
  if (!workspaceId) {
    respond(400, { ok: false, code: "BAD_REQUEST", message: "参数错误：workspaceId" });
    return;
  }
  const terminalManager = ctx.terminalManager, publish = ctx.publishTerminalEvent;
  if (!terminalManager || !publish) {
    respond(500, { ok: false, code: "TERMINAL_LOCAL_RUNTIME_UNAVAILABLE", message: "本机终端运行时不可用" });
    return;
  }
  if (body.requestId != null && typeof body.requestId !== "string") {
    respond(400, { ok: false, code: "BAD_REQUEST", message: "参数错误：requestId" });
    return;
  }
  const requestId = optionalText(body.requestId);
  const validateTerminal = (terminalId: string) => {
    const terminal = terminalManager.get(terminalId);
    if (!terminal || terminal.workspaceId !== workspaceId) {
      respond(404, { ok: false, code: "NOT_FOUND", message: "终端不存在或不属于当前工作区" });
      return null;
    }
    return terminal;
  };

  if (req.method === "terminal.create") {
    if (["label", "shell", "cwd"].some((field) => body[field] != null && typeof body[field] !== "string")) {
      respond(400, { ok: false, code: "BAD_REQUEST", message: "参数错误：label/shell/cwd" });
      return;
    }
    const label = optionalText(body.label), shell = optionalText(body.shell), cwd = optionalText(body.cwd);
    const info = withWorkspaceWriteGate({ workspaceOperationGate: ctx.workspaceOperationGate }, workspaceId, () => terminalManager.create({
      workspaceId, requestId, label: label || undefined, shell: shell || undefined, cwd: cwd || undefined,
    }));
    respond(200, { ok: true, terminal: info });
    return;
  }

  if (req.method === "terminal.runAction") {
    const actionId = optionalText(body.actionId);
    if (!actionId) {
      respond(400, { ok: false, code: "BAD_REQUEST", message: "参数错误：actionId" });
      return;
    }
    const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
    if (!workspacePath) {
      respond(404, { ok: false, code: "NOT_FOUND", message: `未知 workspaceId：${workspaceId}` });
      return;
    }
    const action = readTerminalActions(workspacePath).find((candidate) => candidate.id === actionId);
    if (!action) {
      respond(404, { ok: false, code: "NOT_FOUND", message: `未知 actionId：${actionId}` });
      return;
    }
    const info = withWorkspaceWriteGate({ workspaceOperationGate: ctx.workspaceOperationGate }, workspaceId, () => terminalManager.create({
      workspaceId, requestId, label: action.label, shell: action.shell || undefined, cwd: action.cwd || undefined,
    }));
    if (action.command) terminalManager.scheduleCommand(info.id, action.command, 500);
    respond(200, { ok: true, terminal: info });
    return;
  }

  if (req.method === "terminal.list") {
    let terminals = terminalManager.list(workspaceId);
    // 同步恢复同时持数据库许可和迁移门禁；排队后复核，避免并发列表重复启动进程。
    if (!terminals.length) {
      const restore = () => withWorkspaceWriteGate({ workspaceOperationGate: ctx.workspaceOperationGate }, workspaceId, () => {
        terminals = terminalManager.list(workspaceId);
        if (!terminals.length) {
          terminalManager.restoreAll(workspaceId);
          terminals = terminalManager.list(workspaceId);
        }
      });
      if (ctx.withDatabase) await ctx.withDatabase(req.id, restore);
      else restore();
    }
    respond(200, { ok: true, requestId, workspaceId, clientId: ctx.clientId,
      terminals: terminals.map((terminal) => ({ ...terminal, clientId: ctx.clientId })) });
    return;
  }

  const terminalId = optionalText(body.terminalId);
  if (!terminalId) {
    respond(400, { ok: false, code: "BAD_REQUEST", message: "参数错误：terminalId" });
    return;
  }
  const terminal = validateTerminal(terminalId);
  if (!terminal) return;

  if (req.method === "terminal.input") {
    if (typeof body.data !== "string") {
      respond(400, { ok: false, code: "BAD_REQUEST", message: "参数错误：data" });
      return;
    }
    terminalManager.write(terminalId, body.data);
    respond(200, { ok: true });
    return;
  }
  if (req.method === "terminal.resize") {
    if (!Number.isSafeInteger(body.cols) || !Number.isSafeInteger(body.rows) || (body.cols as number) <= 0 || (body.rows as number) <= 0) {
      respond(400, { ok: false, code: "BAD_REQUEST", message: "参数错误：cols/rows" });
      return;
    }
    terminalManager.resize(terminalId, body.cols as number, body.rows as number);
    respond(200, { ok: true });
    return;
  }
  if (req.method === "terminal.rename") {
    const label = optionalText(body.label);
    if (!label) {
      respond(400, { ok: false, code: "BAD_REQUEST", message: "参数错误：label" });
      return;
    }
    if (!terminalManager.rename(terminalId, label)) {
      respond(404, { ok: false, code: "NOT_FOUND", message: "终端不存在" });
      return;
    }
    publish({ t: "terminal.renamed", clientId: ctx.clientId, workspaceId, terminalId, label });
    respond(200, { ok: true, label });
    return;
  }
  if (req.method === "terminal.close") {
    if (!terminalManager.close(terminalId)) {
      respond(404, { ok: false, code: "NOT_FOUND", message: "终端不存在" });
      return;
    }
    publish({ t: "terminal.closed", clientId: ctx.clientId, workspaceId, terminalId });
    respond(200, { ok: true });
    return;
  }
  respond(404, { ok: false, code: "UNKNOWN_METHOD", message: "未知终端方法" });
}

/** 可选文本字段只接受字符串；空串归一为空，交由调用方决定是否必填。 */
function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

/** 处理 api.req：terminal.shells.list */
export async function handleTerminalShellsList(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }
  try {
    const result = await listLaunchableTerminalShellOptions({ cwd: workspacePath });
    if (result.unavailableShells.length > 0) {
      logger.warn("terminal", "terminal shell probe filtered unavailable shells", {
        workspaceId,
        cwd: workspacePath,
        platform: process.platform,
        arch: process.arch,
        unavailableShells: result.unavailableShells,
      });
    }
    if (result.shells.length === 0) {
      const reason = result.unavailableShells[0]
        ? `${result.unavailableShells[0].shell}: ${result.unavailableShells[0].reason}`
        : "没有候选 Shell";
      const macOSHint = resolveMacOSProtectedTerminalCwdHint(workspacePath);
      ctx.send({
        t: "api.res",
        id: req.id,
        status: 500,
        body: { ok: false, message: `未检测到可启动的终端 Shell：${reason}${macOSHint ? `；${macOSHint}` : ""}` },
      });
      return;
    }
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, shells: result.shells } });
  } catch (e) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: e instanceof Error ? e.message : String(e) } });
  }
}

/** 在终端运行态进入 manager 前持有短写租约，关闭迁移检查竞态。 */
function withWorkspaceWriteGate<T>(deps: Pick<TerminalHandlerDeps, "workspaceOperationGate">, workspaceId: WorkspaceId, action: () => T): T {
  const release = deps.workspaceOperationGate?.beginWrite(workspaceId) ?? (() => {});
  let result: T | undefined, failure: { reason: unknown } | undefined;
  try { result = action(); } catch (error) { failure = { reason: error }; }
  try { release(); }
  catch (cleanupError) { failure = { reason: failure ? new AggregateError([failure.reason, cleanupError], "终端操作与准入释放均失败", { cause: failure.reason }) : cleanupError }; }
  if (failure) throw failure.reason;
  return result as T;
}

/** 校验终端副作用请求的工作区归属；旧请求缺省 workspaceId 时按 terminalId 兼容。 */
function terminalMatchesWorkspace(deps: TerminalHandlerDeps, terminalId: string, workspaceId?: string): boolean {
  const terminal = deps.terminalManager.get(terminalId);
  if (!terminal) {
    deps.send({ t: "terminal.error", terminalId, workspaceId, message: "终端不存在" });
    return false;
  }
  if (workspaceId && terminal.workspaceId !== workspaceId) {
    deps.send({ t: "terminal.error", terminalId, workspaceId, message: "终端不属于指定工作区" });
    return false;
  }
  return true;
}

/** 处理 api.req：terminal.actions.list */
export function handleTerminalActionsList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  if (!workspaceId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }
  const actions = readTerminalActions(workspacePath);
  ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, actions } });
}

/** 处理 api.req：terminal.actions.save */
export function handleTerminalActionsSave(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  const workspaceId = String((req.body as any)?.workspaceId ?? "").trim() as WorkspaceId;
  const actions = (req.body as any)?.actions;
  if (!workspaceId || !Array.isArray(actions)) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：workspaceId/actions" } });
    return;
  }
  const workspacePath = ctx.workspaces.get(workspaceId) ?? null;
  if (!workspacePath) {
    ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: `未知 workspaceId：${workspaceId}` } });
    return;
  }
  try {
    actions.forEach((action, index) => validateTerminalActionDefinition(workspacePath, action, index));
  } catch (e) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: e instanceof Error ? e.message : String(e) } });
    return;
  }
  try {
    const saved = writeTerminalActions(workspacePath, actions);
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, actions: saved } });
  } catch (e) {
    ctx.send({ t: "api.res", id: req.id, status: 500, body: { ok: false, message: e instanceof Error ? e.message : String(e) } });
  }
}

