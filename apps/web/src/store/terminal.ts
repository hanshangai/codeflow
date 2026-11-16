import { defineStore } from "pinia";
import type { AccountTerminalInfo, ServerToWebMessage, TerminalAction } from "@codeflowai/shared";

export type TerminalFilterMode = "all" | "currentWorkspace";
export type TerminalListFailure = { clientId: string; workspaceId: string; message: string };
type ListedTerminal = AccountTerminalInfo & { scrollback?: string };
const TERMINAL_SCROLLBACK_MAX_CHARS = 50 * 1024;

export type TerminalState = {
  terminals: AccountTerminalInfo[];
  activeTerminalKey: string | null;
  /** 过渡兼容字段；桌面终端改造完成后调用方统一使用 activeTerminalKey。 */
  activeTerminalId: string | null;
  activeTerminalByWorkspace: Record<string, string>;
  filterMode: TerminalFilterMode;
  onlineClientIds: string[];
  actions: TerminalAction[];
  listLoading: boolean;
  listRequestId: string | null;
  workspaceListRequestIds: Record<string, string>;
  scrollbackByTerminalKey: Record<string, string>;
  listFailures: TerminalListFailure[];
};

export type TerminalStore = ReturnType<typeof useTerminalStore>;

/** 构造 Web 侧终端复合键，隔离不同 Client 和工作区的同名 terminalId。 */
export function terminalKey(input: { clientId: string; workspaceId: string; id: string }): string {
  return `${input.clientId}\u0000${input.workspaceId}\u0000${input.id}`;
}

/** 判断终端是否属于指定 Client/工作区目标。 */
function terminalMatchesTarget(
  terminal: AccountTerminalInfo,
  target: { clientId: string; workspaceId: string },
): boolean {
  return terminal.clientId === target.clientId && terminal.workspaceId === target.workspaceId;
}

/** 账号级终端管理数据。 */
export const useTerminalStore = defineStore("terminal", {
  state: (): TerminalState => ({
    terminals: [],
    activeTerminalKey: null,
    activeTerminalId: null,
    activeTerminalByWorkspace: {},
    filterMode: "all",
    onlineClientIds: [],
    actions: [],
    listLoading: false,
    listRequestId: null,
    workspaceListRequestIds: {},
    scrollbackByTerminalKey: {},
    listFailures: [],
  }),

  getters: {
    activeTerminal(): AccountTerminalInfo | null {
      if (this.activeTerminalKey) {
        const exact = this.terminals.find((terminal) => terminalKey(terminal) === this.activeTerminalKey);
        if (exact) return exact;
      }
      if (!this.activeTerminalId) return null;
      const matches = this.terminals.filter((terminal) => terminal.id === this.activeTerminalId);
      return matches.length === 1 ? matches[0]! : null;
    },
    /** 账号范围是否存在在线运行终端。 */
    hasOnlineRunningTerminal(): boolean {
      const online = new Set(this.onlineClientIds);
      return this.terminals.some((terminal) => online.has(terminal.clientId) && terminal.status === "running");
    },
    /** 账号范围是否存在所属 Client 已离线的缓存终端。 */
    hasOfflineCachedTerminal(): boolean {
      const online = new Set(this.onlineClientIds);
      return this.terminals.some((terminal) => !online.has(terminal.clientId));
    },
    /** 查询终端所属 Client 是否在线。 */
    isTerminalOnline() {
      return (terminal: AccountTerminalInfo): boolean => this.onlineClientIds.includes(terminal.clientId);
    },
    /** 按当前过滤模式返回可见终端。 */
    visibleTerminals() {
      return (workspaceId: string | null | undefined, clientId?: string | null): AccountTerminalInfo[] => {
        if (this.filterMode === "all") return this.terminals;
        const normalized = String(workspaceId ?? "").trim();
        const normalizedClientId = String(clientId ?? "").trim();
        return normalized
          ? this.terminals.filter((terminal) => terminal.workspaceId === normalized && (!normalizedClientId || terminal.clientId === normalizedClientId))
          : [];
      };
    },
    /** 读取指定终端的有限 Web scrollback 缓存。 */
    terminalScrollback() {
      return (terminal: AccountTerminalInfo): string => this.scrollbackByTerminalKey[terminalKey(terminal)] ?? "";
    },
  },

  actions: {
    /** 标记账号级列表请求开始；仅最新 requestId 可以提交结果。 */
    beginListAll(requestId: string): void {
      this.listRequestId = requestId;
      this.listLoading = true;
      this.listFailures = [];
    },

    /** 同步账号下在线 Client；离线终端保留为只读缓存。 */
    syncOnlineClients(clientIds: string[]): void {
      this.onlineClientIds = Array.from(new Set(clientIds.map((id) => String(id).trim()).filter(Boolean)));
    },

    /** 应用账号级聚合结果；成功目标替换，失败目标保留缓存。 */
    onTerminalListAllResult(message: Extract<ServerToWebMessage, { t: "terminal.listAll.result" }>): void {
      if (!this.listRequestId || message.requestId !== this.listRequestId) return;
      const failed = new Set(message.failures.map((target) => `${target.clientId}\u0000${target.workspaceId}`));
      const successfulTargets = message.targets.filter((target) => !failed.has(`${target.clientId}\u0000${target.workspaceId}`));
      const retained = this.terminals.filter((terminal) =>
        !successfulTargets.some((target) => terminalMatchesTarget(terminal, target)),
      );
      this.terminals = mergeTerminals(retained, message.terminals);
      this.cacheListedScrollback(message.terminals);
      this.pruneScrollbackCache();
      this.listFailures = message.failures;
      this.listLoading = false;
      this.listRequestId = null;
      this.ensureActiveTerminal();
      this.pruneActiveTerminalMemory();
      this._emitEvent("listed", { terminals: message.terminals, failures: message.failures, accountWide: true });
    },

    /** 结束未发出或超时的账号级列表请求，保留现有缓存。 */
    failListAll(requestId: string, message: string): void {
      if (this.listRequestId !== requestId) return;
      this.listLoading = false;
      this.listRequestId = null;
      this.listFailures = [{ clientId: "", workspaceId: "", message }];
    },

    /** 记录单工作区列表请求，避免迟到响应覆盖较新 scrollback。 */
    beginWorkspaceList(clientId: string, workspaceId: string, requestId: string): void {
      this.workspaceListRequestIds[workspaceMemoryKey(clientId, workspaceId)] = requestId;
    },

    /** 取消指定单工作区列表等待，拒绝其后续迟到响应。 */
    cancelWorkspaceList(requestId: string): void {
      for (const [key, expected] of Object.entries(this.workspaceListRequestIds)) {
        if (expected === requestId) delete this.workspaceListRequestIds[key];
      }
    },

    /** 合并终端创建事件；仅无活动项时自动选择，避免其他 Web 抢占焦点。 */
    onTerminalCreated(terminal: AccountTerminalInfo, requestId?: string): void {
      if (!String(terminal.clientId ?? "").trim() || !String(terminal.workspaceId ?? "").trim()) {
        this._emitEvent("error", {
          requestId,
          message: "终端创建响应缺少 Client 或工作区归属，请升级并重启 Server/Client 后重试",
        });
        return;
      }
      this.terminals = mergeTerminals(this.terminals, [terminal]);
      this.ensureActiveTerminal();
      this._emitEvent("created", { terminal, terminalKey: terminalKey(terminal), requestId });
    },

    /** 转发实时输出，并携带复合归属供终端视图精确过滤。 */
    onTerminalOutput(clientId: string, workspaceId: string, terminalId: string, data: string): void {
      const key = terminalKey({ clientId, workspaceId, id: terminalId });
      this.scrollbackByTerminalKey[key] = trimScrollback(`${this.scrollbackByTerminalKey[key] ?? ""}${data}`);
      this._emitEvent("output", { clientId, workspaceId, terminalId, terminalKey: key, data });
    },

    /** 更新指定复合终端的退出状态。 */
    onTerminalExited(clientId: string, workspaceId: string, terminalId: string, exitCode: number | null): void {
      const terminal = this.findTerminal(clientId, workspaceId, terminalId);
      if (terminal) {
        terminal.status = "exited";
        terminal.exitCode = exitCode;
      }
    },

    /** 删除指定复合终端，并选择相邻终端。 */
    onTerminalClosed(clientId: string, workspaceId: string, terminalId: string): void {
      const key = terminalKey({ clientId, workspaceId, id: terminalId });
      const index = this.terminals.findIndex((terminal) => terminalKey(terminal) === key);
      if (index < 0) return;
      this.terminals.splice(index, 1);
      delete this.scrollbackByTerminalKey[key];
      if (this.activeTerminalKey === key || (!this.activeTerminalKey && this.activeTerminalId === terminalId)) {
        const next = this.terminals[index] ?? this.terminals[index - 1] ?? null;
        if (next) this.selectTerminal(next);
        else this.clearActiveTerminal();
      }
      this.pruneActiveTerminalMemory();
    },

    /** 兼容单工作区列表响应，按目标局部替换而非覆盖账号级集合。 */
    onTerminalListed(clientId: string, workspaceId: string, requestId: string | undefined, terminals: ListedTerminal[]): void {
      const targetKey = workspaceMemoryKey(clientId, workspaceId);
      const expectedRequestId = this.workspaceListRequestIds[targetKey];
      if (!expectedRequestId) return;
      if (requestId && requestId !== expectedRequestId) return;
      delete this.workspaceListRequestIds[targetKey];
      const retained = this.terminals.filter((terminal) => !terminalMatchesTarget(terminal, { clientId, workspaceId }));
      this.terminals = mergeTerminals(retained, terminals);
      this.cacheListedScrollback(terminals);
      this.pruneScrollbackCache();
      this.ensureActiveTerminal();
      this._emitEvent("listed", { clientId, workspaceId, terminals, accountWide: false });
    },

    /** 更新指定复合终端名称。 */
    onTerminalRenamed(clientId: string, workspaceId: string, terminalId: string, label: string): void {
      const terminal = this.findTerminal(clientId, workspaceId, terminalId);
      if (terminal) terminal.label = label;
    },

    /** 更新指定复合终端前台进程。 */
    onTerminalForegroundChanged(clientId: string, workspaceId: string, terminalId: string, foregroundProcess: string | null): void {
      const terminal = this.findTerminal(clientId, workspaceId, terminalId);
      if (terminal) terminal.foregroundProcess = foregroundProcess;
    },

    /** 分发带归属上下文的终端错误。 */
    onTerminalError(clientId: string | undefined, workspaceId: string | undefined, terminalId: string | undefined, requestId: string | undefined, msg: string): void {
      this._emitEvent("error", { clientId, workspaceId, terminalId, requestId, message: msg });
    },

    /** 选中复合终端并记录其工作区上次活动项。 */
    selectTerminal(terminal: AccountTerminalInfo): void {
      const key = terminalKey(terminal);
      this.activeTerminalKey = key;
      this.activeTerminalId = terminal.id;
      this.activeTerminalByWorkspace[workspaceMemoryKey(terminal.clientId, terminal.workspaceId)] = key;
    },

    /** 按权威工作区目标清理已不属于当前账号的终端缓存。 */
    reconcileKnownTargets(targets: Array<{ clientId: string; workspaceId: string }>): void {
      const known = new Set(targets.map((target) => workspaceMemoryKey(target.clientId, target.workspaceId)));
      this.terminals = this.terminals.filter((terminal) => known.has(workspaceMemoryKey(terminal.clientId, terminal.workspaceId)));
      this.pruneScrollbackCache();
      this.ensureActiveTerminal();
      this.pruneActiveTerminalMemory();
    },

    /** 尝试恢复指定工作区上次活动终端。 */
    restoreWorkspaceActiveTerminal(workspaceId: string, clientId?: string): boolean {
      const key = this.activeTerminalByWorkspace[workspaceMemoryKey(clientId, workspaceId)]
        ?? this.activeTerminalByWorkspace[workspaceMemoryKey(undefined, workspaceId)];
      const terminal = key ? this.terminals.find((item) => terminalKey(item) === key) : null;
      if (!terminal) return false;
      this.selectTerminal(terminal);
      return true;
    },

    /** 切换“全部终端/当前工作区”过滤模式。 */
    setFilterMode(mode: TerminalFilterMode): void {
      this.filterMode = mode;
    },

    /** 保存当前工作区终端操作配置。 */
    setActions(actions: TerminalAction[]): void {
      this.actions = actions;
    },

    /** 保存列表返回的有限 scrollback，供所属 Client 离线时只读查看。 */
    cacheListedScrollback(terminals: ListedTerminal[]): void {
      for (const terminal of terminals) {
        if (typeof terminal.scrollback === "string") {
          this.scrollbackByTerminalKey[terminalKey(terminal)] = trimScrollback(terminal.scrollback);
        }
      }
    },

    findTerminal(clientId: string, workspaceId: string, terminalId: string): AccountTerminalInfo | null {
      const key = terminalKey({ clientId, workspaceId, id: terminalId });
      return this.terminals.find((terminal) => terminalKey(terminal) === key) ?? null;
    },

    /** 确保活动终端仍存在，否则优先选择在线运行终端。 */
    ensureActiveTerminal(): void {
      if (this.activeTerminal) return;
      const online = new Set(this.onlineClientIds);
      const next = this.terminals.find((terminal) => online.has(terminal.clientId) && terminal.status === "running")
        ?? this.terminals[0]
        ?? null;
      if (next) this.selectTerminal(next);
      else this.clearActiveTerminal();
    },

    clearActiveTerminal(): void {
      this.activeTerminalKey = null;
      this.activeTerminalId = null;
    },

    /** 清理已失效的工作区活动终端记忆。 */
    pruneActiveTerminalMemory(): void {
      const existing = new Set(this.terminals.map((terminal) => terminalKey(terminal)));
      for (const [key, value] of Object.entries(this.activeTerminalByWorkspace)) {
        if (!existing.has(value)) delete this.activeTerminalByWorkspace[key];
      }
    },

    /** 删除已不存在终端的 scrollback 缓存。 */
    pruneScrollbackCache(): void {
      const existing = new Set(this.terminals.map((terminal) => terminalKey(terminal)));
      for (const key of Object.keys(this.scrollbackByTerminalKey)) {
        if (!existing.has(key)) delete this.scrollbackByTerminalKey[key];
      }
    },

    _emitEvent(type: string, detail: unknown): void {
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(`terminal:${type}`, { detail }));
    },
  },
});

/** 合并终端快照并去除复合键重复项。 */
function mergeTerminals(
  current: AccountTerminalInfo[],
  incoming: Array<AccountTerminalInfo & { scrollback?: string }>,
): AccountTerminalInfo[] {
  const merged = new Map(current.map((terminal) => [terminalKey(terminal), terminal]));
  for (const { scrollback: _scrollback, ...terminal } of incoming) merged.set(terminalKey(terminal), terminal);
  return Array.from(merged.values()).sort((left, right) => left.createdAt - right.createdAt);
}

function workspaceMemoryKey(clientId: string | undefined, workspaceId: string): string {
  return `${String(clientId ?? "")}\u0000${workspaceId}`;
}

/** 对齐 Client 的单终端 50 KiB 边界，限制浏览器内存占用。 */
function trimScrollback(value: string): string {
  return value.length > TERMINAL_SCROLLBACK_MAX_CHARS
    ? value.slice(value.length - TERMINAL_SCROLLBACK_MAX_CHARS)
    : value;
}
