import fs from "node:fs/promises";

import type { DesktopUpdateNotice, DesktopUpdateNoticeDismissAction } from "@codeflowai/shared";

import { writeDurableJson } from "./durableFile.js";

/** 提醒节流状态；下载事实仍由 pendingRelease/preparedUpdate 持有，这里只记已提醒版本与时间。 */
export type UpdateNoticeState = {
  schemaVersion: 1;
  releaseId: string;
  version: string;
  lastNotifiedAt: number;
};

/** 已下载且可提醒的候选；壳更新只用于 macOS 手动安装提示。 */
export type PreparedUpdateNotice = {
  releaseId: string;
  version: string;
  currentVersion: string | null;
  shellOnly: boolean;
};

export const UPDATE_NOTICE_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 读取提醒状态；缺失按未提醒处理，损坏显式标记供调用方记录。 */
export async function readUpdateNoticeState(file: string): Promise<{ state: UpdateNoticeState | null; invalid: boolean }> {
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: null, invalid: false };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return { state: null, invalid: true }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { state: null, invalid: true };
  const state = value as Partial<UpdateNoticeState>;
  if (state.schemaVersion !== 1 || typeof state.releaseId !== "string" || !state.releaseId.trim()
    || typeof state.version !== "string" || !state.version.trim()
    || !Number.isSafeInteger(state.lastNotifiedAt) || (state.lastNotifiedAt as number) < 0) {
    return { state: null, invalid: true };
  }
  return { state: { schemaVersion: 1, releaseId: state.releaseId, version: state.version, lastNotifiedAt: state.lastNotifiedAt as number }, invalid: false };
}

/** 首次下载立即提醒；同一版本未更新时每 24 小时最多一次；本次运行抑制优先。 */
export function shouldNotifyUpdateNotice(input: {
  prepared: PreparedUpdateNotice | null;
  state: UpdateNoticeState | null;
  sessionDismissedReleaseId: string | null;
  now: number;
}): boolean {
  const prepared = input.prepared;
  if (!prepared) return false;
  if (prepared.releaseId === input.sessionDismissedReleaseId) return false;
  const state = input.state;
  if (!state || state.releaseId !== prepared.releaseId) return true;
  return input.now - state.lastNotifiedAt >= UPDATE_NOTICE_DAILY_INTERVAL_MS;
}

/** 维护提醒节流与待展示提醒；所有时间可注入，便于验证 24 小时边界。 */
export function createUpdateNoticeController(input: {
  noticeFile: string;
  now?: () => number;
  onStateError?: (error: unknown, context: { operation: "read" | "write"; state?: UpdateNoticeState }) => void;
}) {
  const now = input.now ?? Date.now;
  let state: UpdateNoticeState | null = null;
  let loaded = false;
  let sessionDismissedReleaseId: string | null = null;
  let pending: DesktopUpdateNotice | null = null;

  async function loadState(): Promise<void> {
    if (loaded) return;
    loaded = true;
    try {
      const result = await readUpdateNoticeState(input.noticeFile);
      state = result.state;
      if (result.invalid) input.onStateError?.(new Error("UPDATE_NOTICE_STATE_INVALID"), { operation: "read" });
    } catch (error) {
      state = null;
      input.onStateError?.(error, { operation: "read" });
    }
  }

  async function persist(next: UpdateNoticeState): Promise<void> {
    state = next;
    try { await writeDurableJson(input.noticeFile, next); }
    catch (error) { input.onStateError?.(error, { operation: "write", state: next }); }
  }

  /** 按当前候选判定是否提醒；仅新建提醒时返回，待关闭提醒由 peek 补查，避免重复推送。 */
  async function evaluate(prepared: PreparedUpdateNotice | null): Promise<DesktopUpdateNotice | null> {
    await loadState();
    if (!prepared) { pending = null; return null; }
    if (pending?.releaseId === prepared.releaseId) return null;
    if (!shouldNotifyUpdateNotice({ prepared, state, sessionDismissedReleaseId, now: now() })) return null;
    pending = { releaseId: prepared.releaseId, version: prepared.version,
      currentVersion: prepared.currentVersion, shellOnly: prepared.shellOnly };
    await persist({ schemaVersion: 1, releaseId: prepared.releaseId, version: prepared.version, lastNotifiedAt: now() });
    return pending;
  }

  /** 用户已通过检查更新弹窗看到候选；刷新提醒时间但不改变本次抑制。 */
  async function markSeen(prepared: PreparedUpdateNotice): Promise<void> {
    await loadState();
    if (pending?.releaseId === prepared.releaseId) pending = null;
    await persist({ schemaVersion: 1, releaseId: prepared.releaseId, version: prepared.version, lastNotifiedAt: now() });
  }

  /** 关闭当前提醒；later 从关闭时刻重新计算 24 小时，session 仅本次运行有效。 */
  async function dismiss(action: DesktopUpdateNoticeDismissAction): Promise<void> {
    await loadState();
    const releaseId = pending?.releaseId ?? state?.releaseId ?? null;
    if (action === "session" && releaseId) sessionDismissedReleaseId = releaseId;
    pending = null;
    if (action === "later" && releaseId && state?.releaseId === releaseId) {
      await persist({ ...state, lastNotifiedAt: now() });
    }
  }

  /** 页面启动或刷新后补查待展示提醒。 */
  async function peek(): Promise<DesktopUpdateNotice | null> {
    await loadState();
    return pending;
  }

  return { evaluate, markSeen, dismiss, peek };
}

export type UpdateNoticeController = ReturnType<typeof createUpdateNoticeController>;
