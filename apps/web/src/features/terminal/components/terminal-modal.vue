<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Modal, message } from "ant-design-vue";
import {
  PlusOutlined,
  CloseOutlined,
  EditOutlined,
  SettingOutlined,
  LeftOutlined,
  PlayCircleOutlined,
  StopOutlined,
  ReloadOutlined,
  DeleteOutlined,
  RocketOutlined,
  BugOutlined,
  BuildOutlined,
  CloudUploadOutlined,
  CodeOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  ToolOutlined,
  MoreOutlined,
} from "@ant-design/icons-vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { AccountTerminalInfo, TerminalAction, TerminalShellOption } from "@codeflowai/shared";

import { terminalKey, useTerminalStore } from "../../../store/terminal";
import { useConfigStore } from "../../../store/config";
import { useUiStore } from "../../../store/ui";
import { useWorkspacesStore } from "../../../store/workspaces";
import { useApiContext } from "../../../composables/useApiContext";
import { WS_CLIENT_KEY } from "../../../services/ws";
import { listTerminalActions, listTerminalShells } from "../../../api/terminal";
import { isSharedWorkspaceSelectionId } from "../../../utils/workspaceId";
import { isLocalDesktopTerminalMode } from "../../../services/desktop";
import TerminalActionsEditor from "./terminal-actions-editor.vue";
import {
  calculateTerminalTabCapacity,
  formatTerminalListFailures,
  selectDisplayedTerminalKeys,
  shouldClearPendingCreate,
} from "../terminal-workbench-logic";

import "@xterm/xterm/css/xterm.css";

const props = defineProps<{ open: boolean; embedded?: boolean; workbench?: boolean }>();
const emit = defineEmits<{ (e: "update:open", v: boolean): void }>();

const terminal = useTerminalStore();
const config = useConfigStore();
const ui = useUiStore();
const workspaces = useWorkspacesStore();
const { ctx } = useApiContext();
const ws = inject(WS_CLIENT_KEY)!;

const xtermRef = ref<HTMLDivElement | null>(null);
const terminalBarRef = ref<HTMLDivElement | null>(null);
const terminalToolsRef = ref<HTMLDivElement | null>(null);
const terminalTabsCapacity = ref(Number.POSITIVE_INFINITY);
const editorOpen = ref(false);
let terminalTabsResizeObserver: ResizeObserver | null = null;

/** 移动端视图模式：list=终端列表, terminal=终端面板。 */
const mobileView = ref<"list" | "terminal">("list");
const isMobile = computed(() => typeof window !== "undefined" && window.innerWidth <= 767);
const terminalDisabledForSharedWorkspace = computed(() => {
  const workspaceId = String(config.workspaceId ?? "").trim();
  if (!workspaceId) return false;
  const workspace = workspaces.byId.get(workspaceId as any) ?? null;
  return workspace?.kind === "shared" || Boolean(workspace?.shared) || isSharedWorkspaceSelectionId(workspaceId);
});
const terminalDisabledForMissingWorkspace = computed(() => !String(config.workspaceId ?? "").trim() && terminal.terminals.length === 0);
const terminalDisabledMessage = "共享工作区可操作已有本地终端，但不能新建终端或配置快捷操作";
const terminalMissingWorkspaceMessage = "请先创建或选择工作区后再使用终端";

// --- create dialog state ---
const createDialogOpen = ref(false);
const newTerminalName = ref("");
const newTerminalShell = ref<string | undefined>(undefined);
const availableShellOptions = ref<TerminalShellOption[]>([]);
const shellOptionsLoading = ref(false);
const shellOptionsError = ref("");

const shellSelectOptions = computed<TerminalShellOption[]>(() => [
  { value: "", label: "自动检测（默认）" },
  ...availableShellOptions.value,
]);
const currentWorkspaceOwnerClientId = computed(() => String(
  workspaces.byId.get(config.workspaceId as any)?.ownerClientId ?? "",
).trim());
const visibleTerminals = computed(() => terminal.visibleTerminals(config.workspaceId, currentWorkspaceOwnerClientId.value));
const terminalTabsOverflow = computed(() => visibleTerminals.value.length > terminalTabsCapacity.value);
const displayedTerminals = computed(() => {
  const itemsByKey = new Map(visibleTerminals.value.map((item) => [terminalKey(item), item]));
  return selectDisplayedTerminalKeys(
    Array.from(itemsByKey.keys()),
    terminal.activeTerminalKey,
    terminalTabsCapacity.value,
  ).map((key) => itemsByKey.get(key)!);
});
const terminalListFailureTitle = computed(() => formatTerminalListFailures(terminal.listFailures));

/** 生成桌面 Tab 的工作区/终端标签。 */
function terminalTabLabel(item: AccountTerminalInfo): string {
  const workspace = workspaces.byId.get(item.workspaceId as any) ?? null;
  const workspaceLabel = String(workspace?.title ?? item.workspaceId).trim();
  return `${workspaceLabel}/${item.label}`;
}

/** 生成终端归属 Tooltip，省略文本仍可查看完整上下文。 */
function terminalTabTitle(item: AccountTerminalInfo): string {
  return `${terminalTabLabel(item)}\nClient: ${item.clientId}\ncwd: ${item.cwd ?? "-"}\n${terminal.isTerminalOnline(item) ? "在线" : "Client 离线，仅可查看缓存"}`;
}

/** 支持方向键在桌面终端 Tab 间切换，并同步焦点。 */
function onTerminalTabKeydown(event: KeyboardEvent, item: AccountTerminalInfo): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const index = visibleTerminals.value.findIndex((candidate) => terminalKey(candidate) === terminalKey(item));
  if (index < 0) return;
  event.preventDefault();
  const delta = event.key === "ArrowRight" ? 1 : -1;
  const nextIndex = (index + delta + visibleTerminals.value.length) % visibleTerminals.value.length;
  const next = visibleTerminals.value[nextIndex];
  if (!next) return;
  switchToTerminal(next);
  nextTick(() => {
    document.querySelector<HTMLElement>(".tm-workbench__tab--active")?.focus();
  });
}

/** 根据工具栏完整宽度计算可见 Tab 数量，测量基准不受更多按钮影响。 */
function updateTerminalTabsCapacity(): void {
  const bar = terminalBarRef.value;
  const tools = terminalToolsRef.value;
  if (!bar || !tools) return;
  terminalTabsCapacity.value = calculateTerminalTabCapacity(
    bar.clientWidth,
    tools.offsetWidth,
    visibleTerminals.value.length,
  );
}

/** 从更多菜单切换到指定复合归属终端。 */
function selectOverflowTerminal({ key }: { key: string | number }): void {
  const item = visibleTerminals.value.find((candidate) => terminalKey(candidate) === String(key));
  if (item) switchToTerminal(item);
}

// --- rename state ---
const renamingTerminalKey = ref<string | null>(null);
const renameLabel = ref("");

// --- batch select state ---
const selectedIds = ref<Set<string>>(new Set());
const pendingCreateRequestId = ref<string | null>(null);
const pendingSnapshotRequestId = ref<string | null>(null);
let snapshotTimeout: ReturnType<typeof setTimeout> | null = null;

let xterm: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;

/** 等待 scrollback 期间屏蔽实时 output，防止内容重复 */
const scrollbackPending = ref(false);

const isDark = computed(() => {
  if (ui.themeMode === "dark") return true;
  if (ui.themeMode === "light") return false;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  return false;
});

const xtermTheme = computed(() => {
  if (isDark.value) {
    return {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      cursor: "#d4d4d4",
      selectionBackground: "#264f78",
    };
  }
  return {
    background: "#f7f8fa",
    foreground: "#1e1e1e",
    cursor: "#1e1e1e",
    selectionBackground: "#add6ff",
  };
});

const iconMap: Record<string, any> = {
  play: PlayCircleOutlined,
  stop: StopOutlined,
  reload: ReloadOutlined,
  rocket: RocketOutlined,
  bug: BugOutlined,
  build: BuildOutlined,
  upload: CloudUploadOutlined,
  code: CodeOutlined,
  database: DatabaseOutlined,
  experiment: ExperimentOutlined,
  tool: ToolOutlined,
};

const iconColorMap: Record<string, string> = {
  play: "#52c41a",
  stop: "#ff4d4f",
  reload: "#1677ff",
  rocket: "#722ed1",
  bug: "#eb2f96",
  build: "#fa8c16",
  upload: "#13c2c2",
  code: "#2f54eb",
  database: "#faad14",
  experiment: "#a0d911",
  tool: "#8c8c8c",
};

const actionIcon = (icon: string | null) => icon ? (iconMap[icon] ?? null) : null;

const actionButtonType = (color: string | null) => {
  if (color === "primary" || color === "danger" || color === "success") return "primary";
  return "default";
};

const actionButtonDanger = (color: string | null) => color === "danger";

// --- xterm lifecycle ---

function createXterm() {
  if (xterm) return;
  xterm = new Terminal({
    scrollback: 5000,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 13,
    theme: xtermTheme.value,
    cursorBlink: true,
    // 终端默认 ANSI 亮色在浅色面板上对比度不足，强制最低对比度保证输出可读。
    minimumContrastRatio: 4.5,
  });
  fitAddon = new FitAddon();
  xterm.loadAddon(fitAddon);
  xterm.loadAddon(new WebLinksAddon());
}

/** 同一实例只挂载一次，避免打开弹窗与列表更新同时重复初始化。 */
function mountXterm() {
  if (!xterm || !xtermRef.value || xterm.element) return;
  xterm.open(xtermRef.value);
  fitAddon?.fit();

  resizeObserver = new ResizeObserver(() => {
    fitAddon?.fit();
    const active = terminal.activeTerminal;
    if (active && xterm && terminal.isTerminalOnline(active)) {
      ws.sendTerminal({ t: "terminal.resize", clientId: active.clientId, workspaceId: active.workspaceId, terminalId: active.id, cols: xterm.cols, rows: xterm.rows } as any);
    }
  });
  resizeObserver.observe(xtermRef.value);
}

function disposeXterm() {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (xterm) {
    xterm.dispose();
    xterm = null;
    fitAddon = null;
  }
}

let xtermDataDisposable: { dispose(): void } | null = null;

function bindXtermToTerminal(item: AccountTerminalInfo) {
  if (!xterm) return;
  xtermDataDisposable?.dispose();
  xtermDataDisposable = xterm.onData((data) => {
    if (!ensureTerminalOnline(item)) return;
    if (!ws.sendTerminal({ t: "terminal.input", clientId: item.clientId, workspaceId: item.workspaceId, terminalId: item.id, data } as any)) {
      xtermDataDisposable?.dispose();
      xtermDataDisposable = null;
      message.error("终端输入发送失败：WebSocket 未连接，已暂停输入");
    }
  });
}

// --- output event handler ---

function onTerminalOutput(e: Event) {
  if (scrollbackPending.value) return;
  const detail = (e as CustomEvent).detail as { terminalKey: string; data: string };
  if (detail.terminalKey !== terminal.activeTerminalKey) return;
  xterm?.write(detail.data);
}

function onTerminalCreated(e: Event) {
  const detail = (e as CustomEvent).detail as { terminal: AccountTerminalInfo; requestId?: string };
  if (!detail.requestId || pendingCreateRequestId.value !== detail.requestId) return;
  pendingCreateRequestId.value = null;
  switchToTerminal(detail.terminal);
}

function onTerminalError(e: Event) {
  const detail = (e as CustomEvent).detail as { requestId?: string; message: string };
  if (detail.requestId && detail.requestId === pendingSnapshotRequestId.value) {
    const active = terminal.activeTerminal;
    finishSnapshotRequest();
    if (active) renderCachedScrollback(active);
  }
  if (shouldClearPendingCreate(pendingCreateRequestId.value, detail.requestId)) {
    pendingCreateRequestId.value = null;
  }
  message.error(detail.message);
}

/** 账号在线时保留聚合，本机列表断开云连接后仍可重试。 */
function retryAccountTerminalList(): void {
  if (!config.connected && !isLocalDesktopTerminalMode(config, String(config.workspaceId ?? ""))) {
    message.error("终端列表重试失败：WebSocket 未连接");
    return;
  }
  const requestId = `terminal-list-all-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  terminal.beginListAll(requestId);
  if (!ws.sendTerminal({ t: "terminal.listAll", requestId } as any)) {
    terminal.failListAll(requestId, "终端列表请求发送失败：WebSocket 未连接");
    return;
  }
  setTimeout(() => terminal.failListAll(requestId, "终端列表请求超时"), 10_000);
}

/** terminal.listed 到达：写入 scrollback、绑定输入、解除 pending */
function onTerminalListedEvent(e: Event) {
  const detail = (e as CustomEvent).detail as {
    clientId?: string;
    workspaceId?: string;
    terminals: Array<AccountTerminalInfo & { scrollback?: string }>;
  };
  const active = terminal.activeTerminal;
  if (!active || detail.clientId !== active.clientId || detail.workspaceId !== active.workspaceId) return;
  finishSnapshotRequest();

  xterm?.clear();
  xterm?.reset();

  if (xterm) {
    const listed = detail.terminals.find((item) => terminalKey(item) === terminalKey(active));
    if (listed?.scrollback) {
      xterm.write(listed.scrollback);
    }
    bindXtermToTerminal(active);
    fitAddon?.fit();
    xterm.focus();
    ws.sendTerminal({ t: "terminal.resize", clientId: active.clientId, workspaceId: active.workspaceId, terminalId: active.id, cols: xterm.cols, rows: xterm.rows } as any);
  }

  scrollbackPending.value = false;
}

// --- actions ---

function switchToTerminal(item: AccountTerminalInfo) {
  if (!ensureTerminalCenterAvailable()) return;
  terminal.selectTerminal(item);
  renderCachedScrollback(item);
  if (terminal.isTerminalOnline(item)) requestTerminalSnapshot(item);
  if (isMobile.value) {
    mobileView.value = "terminal";
    // xterm 需要在 DOM 可见后重新 mount
    nextTick(() => {
      if (!xterm) { createXterm(); }
      if (xtermRef.value && xterm) {
        // xterm 可能已经 mount 过，先 dispose 再重建
        if (xterm.element) {
          // 已经 mount，直接 fit
          fitAddon?.fit();
        } else {
          mountXterm();
        }
      }
    });
  }
}

function mobileBackToList() {
  mobileView.value = "list";
}

function openCreateDialog() {
  if (!ensureCurrentWorkspaceCanCreate()) return;
  newTerminalName.value = "";
  newTerminalShell.value = undefined;
  createDialogOpen.value = true;
  void loadShellOptions();
}

function confirmCreateTerminal() {
  if (!ensureCurrentWorkspaceCanCreate()) return;
  if (shellOptionsLoading.value) {
    message.warning("终端类型仍在加载，请稍后再创建");
    return;
  }
  if (shellOptionsError.value) {
    message.error(shellOptionsError.value);
    return;
  }
  const label = newTerminalName.value.trim() || undefined;
  const shell = newTerminalShell.value?.trim() || undefined;
  const requestId = `terminal-create-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  pendingCreateRequestId.value = requestId;
  if (!ws.sendTerminal({ t: "terminal.create", workspaceId: config.workspaceId, requestId, label, shell } as any)) {
    pendingCreateRequestId.value = null;
    message.error("终端创建请求发送失败：WebSocket 未连接");
    return;
  }
  createDialogOpen.value = false;
}

function startRename(t: AccountTerminalInfo) {
  if (!ensureTerminalOnline(t)) return;
  renamingTerminalKey.value = terminalKey(t);
  renameLabel.value = t.label;
  nextTick(() => {
    const el = document.querySelector(".tm__rename-input") as HTMLInputElement | null;
    el?.focus();
    el?.select();
  });
}

function confirmRename() {
  const key = renamingTerminalKey.value;
  const item = key ? terminal.terminals.find((candidate) => terminalKey(candidate) === key) : null;
  const label = renameLabel.value.trim();
  if (!item || !label || !ensureTerminalOnline(item)) return;
  if (!ws.sendTerminal({ t: "terminal.rename", clientId: item.clientId, workspaceId: item.workspaceId, terminalId: item.id, label } as any)) {
    message.error("终端重命名请求发送失败：WebSocket 未连接");
    return;
  }
  renamingTerminalKey.value = null;
}

function cancelRename() {
  renamingTerminalKey.value = null;
}

function toggleSelect(item: AccountTerminalInfo) {
  if (!ensureTerminalOnline(item)) return;
  const key = terminalKey(item);
  const s = new Set(selectedIds.value);
  if (s.has(key)) s.delete(key); else s.add(key);
  selectedIds.value = s;
}

function batchCloseTerminals() {
  const ids = [...selectedIds.value];
  if (!ids.length) return;
  const selectedTerminals = ids
    .map((key) => terminal.terminals.find((candidate) => terminalKey(candidate) === key) ?? null)
    .filter((item): item is AccountTerminalInfo => Boolean(item));
  if (selectedTerminals.some((item) => !terminal.isTerminalOnline(item))) {
    message.warning("选中的终端包含离线 Client，请取消离线项后重试");
    return;
  }
  Modal.confirm({
    title: "批量关闭终端",
    content: `确认关闭选中的 ${ids.length} 个终端？进程将被终止。`,
    okText: "关闭",
    cancelText: "取消",
    okButtonProps: { danger: true },
    onOk: () => {
      const failedKeys: string[] = [];
      for (const item of selectedTerminals) {
        if (!ws.sendTerminal({ t: "terminal.close", clientId: item.clientId, workspaceId: item.workspaceId, terminalId: item.id } as any)) {
          failedKeys.push(terminalKey(item));
        }
      }
      selectedIds.value = new Set(failedKeys);
      if (failedKeys.length) {
        message.error("部分终端关闭请求发送失败，已保留选择项");
      }
    },
  });
}

function closeTerminal(item: AccountTerminalInfo) {
  if (!ensureTerminalOnline(item)) return;
  Modal.confirm({
    title: "关闭终端",
    content: "确认关闭此终端？进程将被终止。",
    okText: "关闭",
    cancelText: "取消",
    okButtonProps: { danger: true },
    onOk: () => {
      if (!ws.sendTerminal({ t: "terminal.close", clientId: item.clientId, workspaceId: item.workspaceId, terminalId: item.id } as any)) {
        message.error("终端关闭请求发送失败：WebSocket 未连接");
      }
    },
  });
}

/** 从现有终端入口执行工作区模板，运行及错误仍由统一终端通道处理。 */
function runAction(action: TerminalAction) {
  if (!ensureCurrentWorkspaceCanCreate()) return;
  const requestId = `terminal-action-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  pendingCreateRequestId.value = requestId;
  if (!ws.sendTerminal({ t: "terminal.runAction", workspaceId: config.workspaceId, actionId: action.id, requestId } as any)) {
    pendingCreateRequestId.value = null;
    message.error("快捷操作请求发送失败：WebSocket 未连接");
  }
}

async function loadActions() {
  if (!ensureCurrentWorkspaceCanCreate()) return;
  try {
    const actions = await listTerminalActions(ctx.value, config.workspaceId);
    terminal.setActions(actions);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "终端快捷动作加载失败";
    throw new Error(errorMessage, { cause: error });
  }
}

/** 从目标 Client 读取实际可用的终端 Shell 选项。 */
async function loadShellOptions(): Promise<void> {
  if (!ensureCurrentWorkspaceCanCreate()) return;
  shellOptionsLoading.value = true;
  shellOptionsError.value = "";
  try {
    availableShellOptions.value = await listTerminalShells(ctx.value, config.workspaceId);
  } catch (error) {
    availableShellOptions.value = [];
    shellOptionsError.value = error instanceof Error ? error.message : "终端类型加载失败";
    message.error(shellOptionsError.value);
  } finally {
    shellOptionsLoading.value = false;
  }
}

/** 校验终端中心入口可用；共享工作区仍可操作已有本地终端。 */
function ensureTerminalCenterAvailable(): boolean {
  if (terminalDisabledForMissingWorkspace.value) {
    message.warning(terminalMissingWorkspaceMessage);
    return false;
  }
  return true;
}

/** 校验当前工作区允许创建终端和维护快捷操作。 */
function ensureCurrentWorkspaceCanCreate(): boolean {
  if (!String(config.workspaceId ?? "").trim()) {
    message.warning(terminalMissingWorkspaceMessage);
    return false;
  }
  if (!terminalDisabledForSharedWorkspace.value) return true;
  message.warning(terminalDisabledMessage);
  return false;
}

/** 本机就绪可直接控制；其他 Client 必须保持云端在线。 */
function ensureTerminalOnline(item: AccountTerminalInfo): boolean {
  if (item.clientId === config.desktopClient?.clientId && isLocalDesktopTerminalMode(config, item.workspaceId)) return true;
  if (terminal.isTerminalOnline(item)) return true;
  message.warning("终端所属 Client 已离线，暂不可操作");
  return false;
}

/** 请求指定终端所属目标的列表和 scrollback。 */
function requestTerminalSnapshot(item: AccountTerminalInfo): void {
  const requestId = `terminal-list-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  finishSnapshotRequest();
  scrollbackPending.value = true;
  terminal.beginWorkspaceList(item.clientId, item.workspaceId, requestId);
  pendingSnapshotRequestId.value = requestId;
  if (!ws.sendTerminal({ t: "terminal.list", clientId: item.clientId, workspaceId: item.workspaceId, requestId } as any)) {
    finishSnapshotRequest();
    message.error("终端内容请求发送失败：WebSocket 未连接");
    return;
  }
  snapshotTimeout = setTimeout(() => {
    if (pendingSnapshotRequestId.value !== requestId) return;
    finishSnapshotRequest();
    if (terminal.activeTerminalKey === terminalKey(item)) renderCachedScrollback(item);
    message.error("终端内容请求超时");
  }, 10_000);
}

/** 使用 Store 中的有限缓存恢复终端内容，离线时仍可只读查看。 */
function renderCachedScrollback(item: AccountTerminalInfo): void {
  finishSnapshotRequest();
  xterm?.clear();
  xterm?.reset();
  const cached = terminal.terminalScrollback(item);
  if (cached) xterm?.write(cached);
  if (terminal.isTerminalOnline(item)) bindXtermToTerminal(item);
  else {
    xtermDataDisposable?.dispose();
    xtermDataDisposable = null;
  }
  fitAddon?.fit();
}

/** 收口单工作区快照等待状态和计时器。 */
function finishSnapshotRequest(): void {
  if (pendingSnapshotRequestId.value) terminal.cancelWorkspaceList(pendingSnapshotRequestId.value);
  scrollbackPending.value = false;
  pendingSnapshotRequestId.value = null;
  if (snapshotTimeout) clearTimeout(snapshotTimeout);
  snapshotTimeout = null;
}

/** 清理终端弹窗运行态，避免共享工作区显示上一个本地工作区的终端。 */
function resetTerminalModalState(): void {
  selectedIds.value = new Set();
  renamingTerminalKey.value = null;
  createDialogOpen.value = false;
  editorOpen.value = false;
  scrollbackPending.value = false;
  pendingCreateRequestId.value = null;
  finishSnapshotRequest();
  xtermDataDisposable?.dispose();
  xtermDataDisposable = null;
  disposeXterm();
}

async function onActionsSaved(actions: TerminalAction[]) {
  terminal.setActions(actions);
  editorOpen.value = false;
}

const statusColor = (status: string) => {
  if (status === "running") return "var(--app-success)";
  if (status === "exited") return "var(--app-danger)";
  return "var(--app-muted)";
};

const statusLabel = (status: string) => {
  if (status === "running") return "运行中";
  if (status === "exited") return "已退出";
  if (status === "stopped") return "已停止";
  return status;
};

/** 将 shell 路径转为友好的短标签。 */
const shellDisplayName = (shell: string | null): string => {
  if (!shell) return "Shell";
  const lower = shell.toLowerCase();
  if (lower.includes("powershell")) return "PS";
  if (lower.endsWith("cmd.exe") || lower.endsWith("cmd")) return "CMD";
  if (lower.includes("git") && lower.includes("bash")) return "Git Bash";
  if (lower.includes("fish")) return "Fish";
  if (lower.includes("zsh")) return "Zsh";
  if (lower.endsWith("/bash") || lower.endsWith("bash.exe")) return "Bash";
  if (lower.endsWith("/sh")) return "sh";
  // 取最后一段文件名
  const name = shell.replace(/\\/g, "/").split("/").pop() ?? shell;
  return name.replace(/\.exe$/i, "");
};

// --- watchers ---

watch(
  () => props.open,
  async (open) => {
    if (open) {
      if (!ensureTerminalCenterAvailable()) {
        resetTerminalModalState();
        return;
      }
      mobileView.value = "list";
      scrollbackPending.value = true;
      createXterm();
      await nextTick();
      mountXterm();

      window.addEventListener("terminal:output", onTerminalOutput);
      window.addEventListener("terminal:created", onTerminalCreated);
      window.addEventListener("terminal:error", onTerminalError);
      window.addEventListener("terminal:listed", onTerminalListedEvent);

      const active = terminal.activeTerminal;
      if (active) {
        renderCachedScrollback(active);
        if (terminal.isTerminalOnline(active)) requestTerminalSnapshot(active);
      }
      else scrollbackPending.value = false;
      if (!terminalDisabledForSharedWorkspace.value) {
        try {
          await Promise.all([loadActions(), loadShellOptions()]);
        } catch (error) {
          message.error(error instanceof Error ? error.message : "终端初始化失败");
          resetTerminalModalState();
        }
      }
    } else {
      window.removeEventListener("terminal:output", onTerminalOutput);
      window.removeEventListener("terminal:created", onTerminalCreated);
      window.removeEventListener("terminal:error", onTerminalError);
      window.removeEventListener("terminal:listed", onTerminalListedEvent);
      xtermDataDisposable?.dispose();
      xtermDataDisposable = null;
      disposeXterm();
      finishSnapshotRequest();
    }
  },
  { immediate: true },
);

watch(
  () => visibleTerminals.value.map((item) => terminalKey(item)).join("|"),
  async () => {
    if (!props.workbench || !props.open) return;
    const activeVisible = visibleTerminals.value.some((item) => terminalKey(item) === terminal.activeTerminalKey);
    const next = activeVisible ? null : visibleTerminals.value[0] ?? null;
    if (!visibleTerminals.value.length) {
      xtermDataDisposable?.dispose();
      xtermDataDisposable = null;
      disposeXterm();
      return;
    }
    await nextTick();
    if (!props.open || !props.workbench || !visibleTerminals.value.length) return;
    updateTerminalTabsCapacity();
    // xterm.element 是容器内的子元素；复用同一容器，避免反复销毁带待执行布局回调的实例。
    const needsMount = !xterm?.element || xterm.element.parentElement !== xtermRef.value;
    if (needsMount && xterm?.element) disposeXterm();
    createXterm();
    if (needsMount) mountXterm();
    else fitAddon?.fit();
    if (next) {
      switchToTerminal(next);
      return;
    }
    if (!needsMount) return;
    const active = terminal.activeTerminal;
    if (active) {
      renderCachedScrollback(active);
      if (terminal.isTerminalOnline(active)) requestTerminalSnapshot(active);
    }
  },
);

watch([terminalBarRef, terminalToolsRef], ([bar, tools]) => {
  terminalTabsResizeObserver?.disconnect();
  terminalTabsResizeObserver = null;
  if (!bar || !tools) {
    terminalTabsCapacity.value = Number.POSITIVE_INFINITY;
    return;
  }
  terminalTabsResizeObserver = new ResizeObserver(updateTerminalTabsCapacity);
  terminalTabsResizeObserver.observe(bar);
  terminalTabsResizeObserver.observe(tools);
  nextTick(updateTerminalTabsCapacity);
});

watch(
  () => terminal.activeTerminalKey,
  () => {
    // 仅处理外部触发的切换（如终端关闭后自动选中下一个）
    // switchToTerminal / modal open 已经自行设置了 scrollbackPending
    const active = terminal.activeTerminal;
    if (!active || !props.open || scrollbackPending.value || !ensureTerminalCenterAvailable()) return;
    renderCachedScrollback(active);
    if (terminal.isTerminalOnline(active)) requestTerminalSnapshot(active);
  },
);

watch(
  () => terminal.terminals.length,
  (len) => {
    if (!props.open) return;
    if (len !== 0) return;
    scrollbackPending.value = false;
    xtermDataDisposable?.dispose();
    xtermDataDisposable = null;
    // 空列表只清屏；workbench 监听器会销毁实例，reset 的异步布局回调会访问已释放的渲染器。
    xterm?.clear();
  },
);

watch(xtermTheme, (theme) => {
  if (xterm) xterm.options.theme = theme;
});

watch(() => terminalDisabledForMissingWorkspace.value, (missing) => {
  if (missing) resetTerminalModalState();
});

onBeforeUnmount(() => {
  window.removeEventListener("terminal:output", onTerminalOutput);
  window.removeEventListener("terminal:created", onTerminalCreated);
  window.removeEventListener("terminal:error", onTerminalError);
  window.removeEventListener("terminal:listed", onTerminalListedEvent);
  xtermDataDisposable?.dispose();
  terminalTabsResizeObserver?.disconnect();
  disposeXterm();
});
</script>

<template>
  <component
    :is="embedded ? 'div' : Modal"
    v-bind="!embedded ? { open: props.open, title: '终端管理', footer: null, closable: true, width: '85%', bodyStyle: { padding: 0, maxHeight: '80vh', overflow: 'hidden' }, destroyOnClose: false, wrapClassName: 'terminal-modal', centered: true } : { class: 'terminal-embedded-host' }"
    v-on="!embedded ? { cancel: () => emit('update:open', false) } : {}"
  >
    <template v-if="!embedded" #closeIcon><CloseOutlined /></template>
    <div v-if="workbench" class="tm-workbench" :class="{ 'tm-workbench--with-failures': terminal.listFailures.length > 0 }">
      <div ref="terminalBarRef" class="tm-workbench__bar">
        <div class="tm-workbench__tabs" role="tablist" aria-label="终端列表">
          <div
            v-for="t in displayedTerminals"
            :key="terminalKey(t)"
            role="tab"
            tabindex="0"
            class="tm-workbench__tab"
            :class="{ 'tm-workbench__tab--active': terminalKey(t) === terminal.activeTerminalKey }"
            :aria-selected="terminalKey(t) === terminal.activeTerminalKey"
            :title="terminalTabTitle(t)"
            @click="switchToTerminal(t)"
            @keydown.enter.prevent="switchToTerminal(t)"
            @keydown.space.prevent="switchToTerminal(t)"
            @keydown="onTerminalTabKeydown($event, t)"
          >
            <span class="tm-workbench__status" :class="{ 'tm-workbench__status--offline': !terminal.isTerminalOnline(t) }" :style="terminal.isTerminalOnline(t) ? { backgroundColor: statusColor(t.status) } : {}" />
            <span class="tm-workbench__tab-label">{{ terminalTabLabel(t) }}</span>
            <CloseOutlined
              class="tm-workbench__tab-close"
              :class="{ 'tm-workbench__tab-close--disabled': !terminal.isTerminalOnline(t) }"
              role="button"
              :tabindex="terminal.isTerminalOnline(t) ? 0 : -1"
              aria-label="关闭终端"
              @click.stop="closeTerminal(t)"
              @keydown.enter.stop.prevent="closeTerminal(t)"
              @keydown.space.stop.prevent="closeTerminal(t)"
            />
          </div>
        </div>
        <a-dropdown v-if="terminalTabsOverflow" placement="bottomRight" :trigger="['click']">
          <a-button class="tm-workbench__more" type="text" size="small" title="更多终端" aria-label="更多终端">
            <MoreOutlined />
          </a-button>
          <template #overlay>
            <a-menu :selected-keys="terminal.activeTerminalKey ? [terminal.activeTerminalKey] : []" @click="selectOverflowTerminal">
              <a-menu-item v-for="item in visibleTerminals" :key="terminalKey(item)" :title="terminalTabTitle(item)">
                <span class="tm-workbench__menu-item">
                  <span class="tm-workbench__status" :class="{ 'tm-workbench__status--offline': !terminal.isTerminalOnline(item) }" :style="terminal.isTerminalOnline(item) ? { backgroundColor: statusColor(item.status) } : {}" />
                  <span>{{ terminalTabLabel(item) }}</span>
                </span>
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
        <div ref="terminalToolsRef" class="tm-workbench__tools">
          <a-segmented
            :value="terminal.filterMode"
            :options="[{ label: '全部', value: 'all' }, { label: '当前', value: 'currentWorkspace' }]"
            size="small"
            @change="terminal.setFilterMode($event as any)"
          />
          <a-dropdown v-if="terminal.actions.some(action => action.enabled)" :trigger="['click']" placement="bottomRight">
            <a-button type="text" size="small" :disabled="terminalDisabledForSharedWorkspace || !config.workspaceId" title="终端快捷操作" aria-label="终端快捷操作">
              <PlayCircleOutlined />
            </a-button>
            <template #overlay>
              <a-menu>
                <a-menu-item v-for="action in terminal.actions.filter(item => item.enabled)" :key="action.id" @click="runAction(action)">
                  {{ action.label }}
                </a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
          <a-button
            type="text"
            size="small"
            :disabled="terminalDisabledForSharedWorkspace || !config.workspaceId"
            title="新建终端"
            aria-label="新建终端"
            @click="openCreateDialog"
          >
            <PlusOutlined />
          </a-button>
          <a-button
            type="text"
            size="small"
            :disabled="terminalDisabledForSharedWorkspace || !config.workspaceId"
            title="终端快捷操作设置"
            aria-label="终端快捷操作设置"
            @click="editorOpen = true"
          >
            <SettingOutlined />
          </a-button>
        </div>
      </div>
      <div v-if="terminal.listFailures.length" class="tm-workbench__failure" role="alert" :title="terminalListFailureTitle">
        <span>有 {{ terminal.listFailures.length }} 个终端工作区加载失败</span>
        <a-button type="link" size="small" :loading="terminal.listLoading" @click="retryAccountTerminalList">重试</a-button>
      </div>
      <div
        v-if="visibleTerminals.length"
        class="tm-workbench__body"
        :class="{ 'tm-workbench__body--dark': isDark }"
      >
        <div ref="xtermRef" class="tm__xterm-container" />
      </div>
      <div v-else class="tm-workbench__empty">
        <CodeOutlined />
        <span>{{ terminal.filterMode === 'currentWorkspace' ? '当前工作区暂无终端' : '暂无终端' }}</span>
        <a-button
          v-if="config.workspaceId && !terminalDisabledForSharedWorkspace"
          type="primary"
          size="small"
          @click="openCreateDialog"
        >
          <PlusOutlined /> 新建终端
        </a-button>
      </div>
    </div>
    <div v-else-if="terminalDisabledForMissingWorkspace" class="tm__blocked">
      <strong>请先创建或选择工作区</strong>
      <span>{{ terminalMissingWorkspaceMessage }}</span>
    </div>
    <div v-else class="tm" :class="{ 'tm--mobile-list': isMobile && mobileView === 'list', 'tm--mobile-terminal': isMobile && mobileView === 'terminal' }">
      <!-- 左侧 - 终端列表 -->
      <div class="tm__left">
        <div class="tm__left-toolbar">
          <a-button v-if="!terminalDisabledForSharedWorkspace" type="primary" @click="openCreateDialog" style="flex: 1">
            <PlusOutlined /> 新建终端
          </a-button>
          <a-button v-if="!terminalDisabledForSharedWorkspace" type="text" @click="editorOpen = true" title="自定义操作配置">
            <SettingOutlined />
          </a-button>
        </div>

        <div class="tm__list">
          <div
            v-for="t in terminal.terminals"
            :key="terminalKey(t)"
            class="tm__item"
            :class="{ 'tm__item--active': terminalKey(t) === terminal.activeTerminalKey }"
            @click="switchToTerminal(t)"
          >
            <a-checkbox
              :checked="selectedIds.has(terminalKey(t))"
              :disabled="!terminal.isTerminalOnline(t)"
              class="tm__item-checkbox"
              @click.stop
              @change="toggleSelect(t)"
            />
            <span class="tm__item-dot" :style="{ backgroundColor: statusColor(t.status) }" />
            <div class="tm__item-info">
              <template v-if="renamingTerminalKey === terminalKey(t)">
                <input
                  class="tm__rename-input"
                  v-model="renameLabel"
                  name="codeflow-terminal-rename"
                  autocomplete="new-password"
                  @click.stop
                  @keydown.enter="confirmRename"
                  @keydown.escape="cancelRename"
                  @blur="confirmRename"
                />
              </template>
              <template v-else>
                <span class="tm__item-label" @dblclick.stop="startRename(t)">{{ t.label }}</span>
              </template>
              <span class="tm__item-meta">
                <span class="tm__item-shell">{{ shellDisplayName(t.shell) }}</span>
                <template v-if="t.status === 'running'">
                  <span v-if="t.foregroundProcess && t.foregroundProcess !== '\u2026'" class="tm__item-fg">{{ t.foregroundProcess }}</span>
                  <span v-else class="tm__item-idle">待机</span>
                </template>
                <span v-else class="tm__item-status">{{ statusLabel(t.status) }}</span>
              </span>
            </div>
            <a-button type="text" size="small" class="tm__item-close" @click.stop="startRename(t)" title="重命名">
              <EditOutlined style="font-size: 10px" />
            </a-button>
            <a-button type="text" size="small" class="tm__item-close" @click.stop="closeTerminal(t)" title="关闭">
              <CloseOutlined style="font-size: 10px" />
            </a-button>
          </div>
          <div v-if="!terminal.terminals.length" class="tm__empty">无终端</div>
        </div>

        <a-button
          v-if="selectedIds.size > 0"
          danger
          block
          size="small"
          style="margin-top: 8px"
          @click="batchCloseTerminals"
        >
          <DeleteOutlined /> 批量关闭 ({{ selectedIds.size }})
        </a-button>
      </div>

      <!-- 右侧 - 终端显示 -->
      <div class="tm__right">
        <div class="tm__right-header">
          <button v-if="isMobile" class="tm__mobile-back" @click="mobileBackToList">
            <LeftOutlined /> 返回
          </button>
          <span class="tm__right-title">{{ terminal.activeTerminal?.label ?? "未选择" }}</span>
          <div v-if="!terminalDisabledForSharedWorkspace" class="tm__actions">
            <a-button
              v-for="action in terminal.actions.filter(a => a.enabled)"
              :key="action.id"
              size="small"
              :type="actionButtonType(action.color)"
              :danger="actionButtonDanger(action.color)"
              @click="runAction(action)"
            >
              <component v-if="actionIcon(action.icon)" :is="actionIcon(action.icon)" />
              {{ action.label }}
            </a-button>
          </div>
        </div>
        <div ref="xtermRef" class="tm__xterm-container" />
      </div>
    </div>
  </component>

  <!-- 新建终端弹窗（含自定义操作编辑） -->
  <a-modal
    v-if="!terminalDisabledForMissingWorkspace && !terminalDisabledForSharedWorkspace"
    :open="createDialogOpen"
    title="新建终端"
    :width="640"
    ok-text="创建"
    cancel-text="取消"
    @ok="confirmCreateTerminal"
    @cancel="createDialogOpen = false"
    :body-style="{ maxHeight: '70vh', overflowY: 'auto' }"
  >
    <div class="tc">
      <a-form layout="vertical" :colon="false" autocomplete="off">
        <a-form-item label="终端名称">
          <a-input
            v-model:value="newTerminalName"
            name="codeflow-terminal-name"
            autocomplete="new-password"
            placeholder="留空使用默认名称"
            @pressEnter="confirmCreateTerminal"
            allow-clear
          />
        </a-form-item>
        <a-form-item label="Shell 类型">
          <a-select
            v-model:value="newTerminalShell"
            placeholder="自动检测（默认）"
            allow-clear
            :options="shellSelectOptions"
            :loading="shellOptionsLoading"
          />
        </a-form-item>
      </a-form>
    </div>
  </a-modal>

  <TerminalActionsEditor
    v-if="!terminalDisabledForMissingWorkspace && !terminalDisabledForSharedWorkspace"
    :open="editorOpen"
    :actions="terminal.actions"
    :shell-options="shellSelectOptions"
    @update:open="editorOpen = $event"
    @saved="onActionsSaved"
  />
</template>

<style scoped>
.terminal-embedded-host {
  width: 100%;
  height: 100%;
  min-height: 0;
}

.tm-workbench {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  background: var(--app-panel-bg);
}

.tm-workbench--with-failures {
  grid-template-rows: auto auto minmax(0, 1fr);
}

.tm-workbench__failure {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 34px;
  padding: 0 10px;
  color: var(--app-warning-text, #ad6800);
  background: var(--app-warning-bg, #fffbe6);
  border-bottom: 1px solid var(--app-divider);
  font-size: 12px;
}

.tm-workbench__bar {
  display: flex;
  align-items: stretch;
  min-width: 0;
  height: 42px;
  border-bottom: 1px solid var(--app-divider);
}

.tm-workbench__tabs {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: hidden;
}

.tm-workbench__more {
  align-self: center;
  flex: 0 0 32px;
  width: 32px;
  border-left: 1px solid var(--app-divider);
  border-radius: 0;
}

.tm-workbench__menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 320px;
}

.tm-workbench__menu-item > :last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tm-workbench__tab {
  display: inline-flex;
  align-items: center;
  flex: 0 0 138px;
  gap: 7px;
  width: 138px;
  min-width: 138px;
  height: 42px;
  padding: 0 8px 0 11px;
  border: 0;
  border-right: 1px solid var(--app-divider);
  border-bottom: 2px solid transparent;
  color: var(--app-muted);
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  text-align: left;
}

.tm-workbench__tab:hover {
  color: var(--app-text);
  background: color-mix(in srgb, var(--app-panel-bg) 92%, var(--app-text) 8%);
}

.tm-workbench__tab--active {
  color: var(--app-text);
  border-bottom-color: var(--app-accent);
  background: color-mix(in srgb, var(--app-panel-bg) 94%, var(--app-accent) 6%);
}

.tm-workbench__status {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.tm-workbench__status--offline {
  background: var(--app-muted) !important;
}

.tm-workbench__tab-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tm-workbench__tab-close {
  flex: 0 0 auto;
  padding: 3px;
  border-radius: 3px;
  font-size: 10px;
}

.tm-workbench__tab-close:hover {
  background: color-mix(in srgb, var(--app-panel-bg) 84%, var(--app-text) 16%);
}

.tm-workbench__tab-close--disabled {
  opacity: 0.35;
}

.tm-workbench__tools {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 2px;
  padding: 0 6px;
  border-left: 1px solid var(--app-divider);
  background: var(--app-panel-bg);
}

.tm-workbench__body {
  display: flex;
  min-height: 0;
  padding: 0;
  background: #f7f8fa;
}

.tm-workbench__body--dark {
  background: #1e1e1e;
}

.tm-workbench__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 0;
  color: var(--app-muted);
  font-size: 13px;
}

.tm-workbench__empty > :first-child {
  font-size: 24px;
}

.tm {
  display: flex;
  height: 70vh;
  min-height: 400px;
}

.tm__blocked {
  min-height: 260px;
  padding: 32px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
  color: var(--app-muted);
  text-align: center;
}

.tm__blocked strong {
  color: var(--app-text);
  font-size: 16px;
}

.tm__left {
  width: 300px;
  min-width: 260px;
  min-height: 0;
  border-right: 1px solid var(--app-divider);
  padding: 12px;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.tm__left-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
}

.tm__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.tm__item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s;
}

.tm__item:hover {
  background: var(--app-sidebar-hover-bg);
}

.tm__item--active {
  background: var(--app-sidebar-active-bg);
}

.tm__item-checkbox {
  flex-shrink: 0;
}

.tm__item-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.tm__item-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tm__item-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
}

.tm__rename-input {
  min-width: 0;
  border: 1px solid var(--app-accent, #1677ff);
  border-radius: 4px;
  padding: 1px 4px;
  font-size: 13px;
  outline: none;
  background: var(--app-bg, #fff);
  color: var(--app-text, #1e1e1e);
}

.tm__item-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
  font-size: 11px;
  line-height: 1;
}

.tm__item-shell {
  color: var(--app-accent, #1677ff);
  font-weight: 500;
}

.tm__item-fg {
  color: var(--app-warning, #faad14);
  font-weight: 500;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tm__item-idle {
  color: var(--app-success, #52c41a);
}

.tm__item-status {
  color: var(--app-muted);
}

.tm__item-close {
  opacity: 0;
  transition: opacity 0.15s;
  flex-shrink: 0;
}

.tm__item:hover .tm__item-close {
  opacity: 1;
}

.tm__empty {
  text-align: center;
  color: var(--app-muted);
  padding: 24px 0;
  font-size: 13px;
}

.tm__right {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.tm__right-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--app-divider);
  gap: 8px;
}

.tm__right-title {
  font-weight: 500;
  font-size: 14px;
  flex-shrink: 0;
}

.tm__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  overflow-x: hidden;
  flex: 1;
  justify-content: flex-end;
}

.tm__xterm-container {
  flex: 1;
  min-height: 0;
  padding: 4px;
  overflow: hidden;
}

/* --- 新建终端弹窗 --- */

.tc {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ── 移动端返回按钮 ── */
.tm__mobile-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: none;
  background: none;
  color: var(--app-accent, #1677ff);
  font-size: 13px;
  cursor: pointer;
  flex-shrink: 0;
  -webkit-tap-highlight-color: transparent;
}

/* ── 移动端适配：列表+弹框模式 ── */
@media (max-width: 767px) {
  .tm {
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  /* 列表模式：显示列表，隐藏终端 */
  .tm--mobile-list .tm__left {
    width: 100%;
    min-width: unset;
    min-height: 0;
    border-right: none;
    flex: 1;
    max-height: none;
    overflow-y: auto;
  }
  .tm--mobile-list .tm__right {
    display: none;
  }
  /* 终端模式：隐藏列表，显示终端 */
  .tm--mobile-terminal .tm__left {
    display: none;
  }
  .tm--mobile-terminal .tm__right {
    flex: 1;
    min-height: 0;
  }
  .tm__item-close {
    opacity: 1;
  }
  .tm__item {
    min-height: 44px;
  }
}

</style>

