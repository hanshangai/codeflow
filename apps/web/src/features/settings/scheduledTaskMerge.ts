import type { LocalScheduledTaskConfig, ScheduledTask } from "@codeflowai/shared";

import { createApiResultError, type ApiRequestContext } from "../../api/request";
import {
  createScheduledTask, deleteLocalScheduledTask, listLocalScheduledTasks, listScheduledTasks,
  setLocalScheduledTaskEnabled, syncDesktopAccountScheduledTasks,
} from "../../api/scheduled-tasks";
import { useConfigStore } from "../../store/config";

const PAGE_SIZE = 200;
const OWNER_STORAGE_KEY = "codeflowai.scheduled-tasks.owner";
let pending: { scope: string; promise: Promise<ScheduledTaskMergeResult> } | null = null;

export type ScheduledTaskMergeResult = { merged: number; skipped: number };

/** 读取本机全部定时任务，按真实总数翻页。 */
async function listAllLocalTasks(): Promise<LocalScheduledTaskConfig[]> {
  const items: LocalScheduledTaskConfig[] = [];
  for (let offset = 0; ;) {
    const result = await listLocalScheduledTasks({ offset, limit: PAGE_SIZE });
    if (!result.ok) throw createApiResultError(result);
    items.push(...result.items);
    offset += result.items.length;
    if (!result.items.length || items.length >= result.total) return items;
  }
}

/** 读取当前设备在账号下的全部定时任务，用于按名称去重。 */
async function listAllAccountTasks(ctx: ApiRequestContext, clientId: string, deviceId: string): Promise<ScheduledTask[]> {
  const items: ScheduledTask[] = [];
  for (let offset = 0; ;) {
    const result = await listScheduledTasks(ctx, { limit: PAGE_SIZE, offset, clientId, deviceId });
    if (!result.ok) throw createApiResultError(result);
    items.push(...result.items);
    offset += result.items.length;
    if (!result.items.length || items.length >= result.total) return items;
  }
}

/** 删除已迁移的本机任务；删除失败先停用，避免与账号任务重复执行。 */
async function removeMergedLocalTask(task: LocalScheduledTaskConfig): Promise<void> {
  try {
    const result = await deleteLocalScheduledTask({ taskId: task.id, expectedRevision: task.revision });
    if (!result.ok) throw createApiResultError(result);
  } catch (deleteError) {
    try {
      const disabled = await setLocalScheduledTaskEnabled({ taskId: task.id, expectedRevision: task.revision, enabled: false });
      if (!disabled.ok) throw createApiResultError(disabled);
    } catch (disableError) {
      throw new AggregateError([deleteError, disableError], "SCHEDULED_TASK_LOCAL_SUPPRESS_FAILED", { cause: deleteError });
    }
  }
}

/**
 * 登录后把本机定时任务合并到账号的当前设备：账号已有同名任务时以账号为准。
 * 每条任务先确认账号侧存在，再删除本机任务；失败保留本机任务，下次进入页面重试。
 */
export async function mergeLocalScheduledTasks(ctx: ApiRequestContext): Promise<ScheduledTaskMergeResult> {
  const config = useConfigStore();
  const userId = config.userSummary?.userId ?? "";
  const origin = config.serverWsOrigin.trim().replace(/\/+$/u, "");
  if (!config.isDesktop || !config.localRuntimeReady || config.authMode !== "account" || !config.hasActiveSession || !userId || !origin) {
    return { merged: 0, skipped: 0 };
  }
  const clientId = config.desktopClient?.clientId ?? "";
  const deviceId = config.desktopClient?.deviceId ?? "";
  if (!clientId || !deviceId) throw new Error("无法获取本机设备标识，暂时不能合并定时任务");
  const scope = `${origin}::${userId}::${clientId}::${deviceId}`;
  if (pending?.scope === scope) return pending.promise;
  if (pending) {
    // 另一个账号的合并尚未落定时先等待，避免同一批本机任务并发迁移到两个账号。
    try { await pending.promise; } catch { /* 失败不阻断新账号的归属判定 */ }
  }
  const promise = (async (): Promise<ScheduledTaskMergeResult> => {
    // 本机任务已归属其他账号时不再合并，避免跨账号上传。
    const owner = localStorage.getItem(OWNER_STORAGE_KEY) ?? "";
    if (owner && owner !== scope) return { merged: 0, skipped: 0 };
    const localItems = await listAllLocalTasks();
    if (!localItems.length) return { merged: 0, skipped: 0 };
    const accountItems = await listAllAccountTasks(ctx, clientId, deviceId);
    // 账号已有同名任务时以账号为准，只清理本机副本。
    const names = new Set(accountItems.map((item) => item.name.trim()));
    let merged = 0, skipped = 0, touched = false;
    try {
      for (const item of localItems) {
        const name = item.name.trim();
        if (names.has(name)) skipped += 1;
        else {
          const result = await createScheduledTask(ctx, {
            clientId, deviceId, name: item.name, description: item.description ?? null, taskType: item.taskType,
            cronExpr: item.cronExpr, timezone: item.timezone, enabled: item.enabled, payload: item.payload,
            concurrencyPolicy: item.concurrencyPolicy, missedPolicy: item.missedPolicy, timeoutMs: item.timeoutMs,
          });
          if (!result.ok) throw createApiResultError(result);
          names.add(name);
          merged += 1;
        }
        // 账号侧已存在或已创建，本机副本可安全清理。
        touched = true;
        await removeMergedLocalTask(item);
      }
    } finally {
      // 已开始迁移即认领归属；账号查询失败且未改动任何任务时不写归属，允许其他账号合并。
      if (touched) localStorage.setItem(OWNER_STORAGE_KEY, scope);
    }
    // 已关联账号时立即让 Client 拉取新配置；未关联或失败由调度器后续同步兜底。
    if (merged && config.desktopCloudAccountLinked) {
      try {
        const synced = await syncDesktopAccountScheduledTasks();
        if (!synced.ok) throw createApiResultError(synced);
      } catch (error) {
        console.warn("[scheduled-tasks.merge_sync_failed]", {
          code: "SCHEDULED_TASK_MERGE_SYNC_FAILED", requestId: `scheduled-task-merge-${Date.now()}`,
          userId, serverOrigin: origin, clientId, deviceId,
          rootCause: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { merged, skipped };
  })();
  pending = { scope, promise };
  const clearPending = () => { if (pending?.promise === promise) pending = null; };
  void promise.then(clearPending, clearPending);
  return promise;
}
