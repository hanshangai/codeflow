import {
  CODEX_KEY_SWITCH_CONFLICT_REASONS,
  getEngineProviderLabel,
  normalizeEngineKeyProviderId,
  type EngineModelProviderId,
} from "@codeflowai/shared";

import { writeEngineConfig } from "../../enginesConfig.js";
import {
  buildProviderKeyTestRequest,
  describeProviderTestError,
  PROVIDER_KEY_TEST_TIMEOUT_MS,
  readProviderTestResponseText,
  summarizeProviderTestFailure,
} from "../../engines/providerKeyTest.js";
import { assertEngineKeySourceVerified, type PersistedEngineKey } from "../../db/repos/engineKeyRepo.js";
import type { ThreadTurnRecord } from "../../db/repos/threadTurnRepo.js";
import { logger } from "../../logger.js";
import type { ApiHandlerContext, ApiRequestMessage } from "../handleApiRequest.js";
import { interruptTurnBestEffort } from "../turnInterrupt.js";

type EngineKeyEngine = "claude" | "codex";
const engineKeyMutationTailByEngine = new Map<EngineKeyEngine, Promise<void>>();
const CODEX_KEY_SWITCH_CONFLICT_CODE = "CONFLICT";
const CODEX_KEY_SWITCH_PREVIEW_LIMIT = 10;

/** Key操作只为同步仓储段持许可，停止与配置文件写入在许可外等待。 */
async function database<T>(ctx: ApiHandlerContext, operation: () => T): Promise<T> {
  return ctx.withDatabase ? ctx.withDatabase("engine-key-mutation", operation) : operation();
}

/** 处理 `engineKeys.list`：列出所有 Key。 */
export function handleEngineKeysList(ctx: ApiHandlerContext, req: ApiRequestMessage): void {
  try {
    const keys = ctx.db.engineKeys.list().map(key => projectEngineKey(ctx, key));
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, keys } });
  } catch (e) {
    sendEngineKeyMutationError(ctx, req, e);
  }
}

/** 处理 `engineKeys.test`：用未保存配置发起最小模型请求，只返回脱敏后的结果。 */
export async function handleEngineKeysTest(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const body = req.body as any;
  const engineInput = String(body?.engine ?? "").trim();
  if (engineInput !== "claude" && engineInput !== "codex") {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：engine 必须为 claude 或 codex" } });
    return;
  }
  const providerId = normalizeEngineKeyProviderId(engineInput, typeof body?.providerId === "string" ? body.providerId : null);
  if (!providerId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：供应商不支持当前引擎" } });
    return;
  }
  const apiKey = String(body?.apiKey ?? "").trim();
  if (!apiKey) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：apiKey 不能为空" } });
    return;
  }
  const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() || null : null;
  if (requiresClaudeCompatibleBaseUrl(engineInput, providerId) && !baseUrl) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: `参数错误：${getEngineProviderLabel(providerId)} 供应商必须配置 Base URL` } });
    return;
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_KEY_TEST_TIMEOUT_MS);
  try {
    const request = buildProviderKeyTestRequest({ engine: engineInput, providerId, apiKey, baseUrl });
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    const responseText = await readProviderTestResponseText(response);
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      const message = summarizeProviderTestFailure(response.status, responseText, apiKey);
      logger.warn("[engine-key-test.failed]", "供应商 Key 测试失败", {
        requestId: req.id, engine: engineInput, providerId, status: response.status, latencyMs, rootCause: message,
      });
      ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: false, message, latencyMs, model: request.model } });
      return;
    }
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, latencyMs, model: request.model } });
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const timedOut = (error as { name?: string } | null)?.name === "AbortError";
    const rawMessage = timedOut
      ? `测试超时（${PROVIDER_KEY_TEST_TIMEOUT_MS / 1000} 秒）`
      : `连接失败：${describeProviderTestError(error)}`;
    const message = rawMessage.split(apiKey).join("***");
    logger.warn("[engine-key-test.error]", "供应商 Key 测试未完成", {
      requestId: req.id, engine: engineInput, providerId, latencyMs,
      code: timedOut ? "TEST_TIMEOUT" : "TEST_REQUEST_FAILED", rootCause: message,
    });
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: false, message, latencyMs } });
  } finally {
    clearTimeout(timer);
  }
}

/** 新增或更新 Key；影响激活 Codex 配置时必须先收口运行回合。 */
export async function handleEngineKeysUpsert(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const body = req.body as any;
  const id = typeof body?.id === "string" ? body.id.trim() : null;
  const label = String(body?.label ?? "").trim();
  const engine = String(body?.engine ?? "").trim();
  const providerIdInput = typeof body?.providerId === "string" ? body.providerId.trim() : null;
  const apiKey = String(body?.apiKey ?? "").trim();
  const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() || null : null;
  const stopRunningTurns = body?.stopRunningTurns === true;

  if (!label) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：label" } });
    return;
  }
  if (engine !== "claude" && engine !== "codex") {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：engine 必须为 claude 或 codex" } });
    return;
  }
  const providerId = normalizeEngineKeyProviderId(engine, providerIdInput);
  if (!providerId) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：供应商不支持当前引擎" } });
    return;
  }
  if (!apiKey) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：apiKey 不能为空" } });
    return;
  }
  if (requiresClaudeCompatibleBaseUrl(engine, providerId) && !baseUrl) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: `参数错误：${getEngineProviderLabel(providerId)} 供应商必须配置 Base URL` } });
    return;
  }

  try {
    if (id) {
      const existing = await database(ctx, () => ctx.db.engineKeys.get(id));
      if (!existing) throw new Error(`engine_key 不存在：${id}`);
      const targetEngine = existing.engine as EngineKeyEngine;
      const updated = await runEngineKeyMutationExclusive(targetEngine, async () => {
        const current = await database(ctx, () => requireEngineKeyInScope(ctx, id, targetEngine));
        if (
          targetEngine === "codex"
          && await database(ctx, () => shouldSyncCodexNativeConfigAfterUpsert(ctx, current, providerId))
        ) {
          await prepareCodexKeySwitch(ctx, stopRunningTurns);
        }
        return await mutateEngineKeysWithNativeSync(
          ctx,
          targetEngine,
          () => {
            ctx.db.engineKeys.update(current.id, { label, providerId, apiKey, baseUrl });
            return requireEngineKeyInScope(ctx, current.id, targetEngine);
          },
          (value) => value.isActive,
        );
      });
      ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, key: updated } });
    } else {
      const created = await runEngineKeyMutationExclusive(engine, async () => {
        if (engine === "codex" && !await database(ctx, () => ctx.db.engineKeys.getActive(engine, providerId))) {
          await prepareCodexKeySwitch(ctx, stopRunningTurns);
        }
        return await mutateEngineKeysWithNativeSync(
          ctx,
          engine,
          () => ctx.db.engineKeys.insert({ label, engine, providerId, apiKey, baseUrl }),
          (value) => value.isActive,
        );
      });
      ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, key: created } });
    }
  } catch (e) {
    sendEngineKeyMutationError(ctx, req, e);
  }
}

/** 判断更新是否会改变当前 Codex native 配置，避免备用 Key 编辑中断运行回合。 */
function shouldSyncCodexNativeConfigAfterUpsert(
  ctx: ApiHandlerContext,
  current: PersistedEngineKey,
  nextProviderId: EngineModelProviderId,
): boolean {
  if (current.isActive) return true;
  if (current.providerId === nextProviderId) return false;
  return !ctx.db.engineKeys.getActive("codex", nextProviderId);
}

/** 处理 `engineKeys.delete`：删除 Key。 */
export async function handleEngineKeysDelete(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const id = String((req.body as any)?.id ?? "").trim();
  if (!id) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：id" } });
    return;
  }

  try {
    const existing = await database(ctx, () => ctx.db.engineKeys.get(id));
    if (existing) {
      if (existing.source === 'builtin') {
        if (!ctx.builtInRelayCredentials) throw new Error('内置凭据服务尚未就绪');
        await ctx.builtInRelayCredentials.delete(id, req.id);
        ctx.send({ t: 'api.res', id: req.id, status: 200, body: { ok: true } });
        return;
      }
      const targetEngine = existing.engine as EngineKeyEngine;
      await runEngineKeyMutationExclusive(targetEngine, async () => {
        const current = await database(ctx, () => ctx.db.engineKeys.get(id));
        if (!current) return;
        assertEngineKeyScope(current, targetEngine);
        await mutateEngineKeysWithNativeSync(
          ctx,
          targetEngine,
          () => ctx.db.engineKeys.delete(id),
          () => current.isActive,
        );
      });
    }
    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true } });
  } catch (e) {
    sendEngineKeyMutationError(ctx, req, e);
  }
}

/** 处理 `engineKeys.activate`：按 engine/provider 激活默认 Key，并同步需要 native 配置的引擎。 */
export async function handleEngineKeysActivate(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const body = req.body as Record<string, unknown> | null;
  const id = String(body?.id ?? "").trim();
  const stopRunningTurns = body?.stopRunningTurns === true;
  if (!id) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：id" } });
    return;
  }

  try {
    const target = await database(ctx, () => ctx.db.engineKeys.get(id));
    if (!target) {
      ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "Key 不存在" } });
      return;
    }
    const engine = target.engine as EngineKeyEngine;
    if (target.source === 'builtin') {
      if (!ctx.builtInRelayCredentials) throw new Error('内置凭据服务尚未就绪');
      const activated = await ctx.builtInRelayCredentials.activate(id, req.id, engine === 'codex' ? async () => { await prepareCodexKeySwitch(ctx, stopRunningTurns); await ctx.sessions.restartCodexProcesses(); } : undefined);
      ctx.send({ t: 'api.res', id: req.id, status: 200, body: { ok: true, key: projectEngineKey(ctx, activated) } });
      return;
    }
    const activated = await runEngineKeyMutationExclusive(engine, async () => {
      await database(ctx, () => requireEngineKeyInScope(ctx, id, engine));
      if (engine === "codex") await prepareCodexKeySwitch(ctx, stopRunningTurns);
      return await mutateEngineKeysWithNativeSync(
        ctx,
        engine,
        () => ctx.db.engineKeys.activate(id),
        () => true,
      );
    });

    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, key: activated } });
  } catch (e) {
    sendEngineKeyMutationError(ctx, req, e);
  }
}

/** 检查实验与普通回合；确认后复用正式 interrupt 链，全部收口才允许变更 Codex 配置。 */
export async function prepareCodexKeySwitch(ctx: ApiHandlerContext, stopRunningTurns: boolean): Promise<void> {
  const runningTurns = await database(ctx, () => { assertNoRunningCodexExperiments(ctx); return listRunningCodexTurns(ctx); });
  if (runningTurns.length > 0 && !stopRunningTurns) {
    throw createCodexKeySwitchConflict(
      `当前 Client 有 ${runningTurns.length} 个 Codex 回合运行中，确认停止后才能切换 Key。`,
      {
        reason: CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsConfirmRequired,
        runningCount: runningTurns.length,
        runningTurns: previewRunningTurns(runningTurns),
      },
    );
  }
  if (runningTurns.length === 0) return;

  await stopRunningCodexTurns(ctx, runningTurns);
  await database(ctx, () => assertNoRunningCodexExperiments(ctx));
}

/** Key 响应不暴露 OS 引用；内置材料只投影当前可用状态。 */
function projectEngineKey(ctx: ApiHandlerContext, key: PersistedEngineKey) {
  const { secretRef: _secretRef, ...entry } = key;
  return { ...entry, ...(key.source !== 'user_configured' ? { apiKey: '', runtimeAvailable: key.source === 'builtin' && ctx.builtInRelayCredentials?.isAvailable(key) === true } : {}) };
}

/** 配置变更时读取普通 Codex 运行态，不轮询也不维护第二套状态。 */
function listRunningCodexTurns(ctx: ApiHandlerContext): ThreadTurnRecord[] {
  return ctx.db.turns.listRunning().filter((turn) => turn.engine === "codex");
}

/** 受控实验只能由其 owner 取消；发现 Codex 实验时直接阻止切换。 */
function assertNoRunningCodexExperiments(ctx: ApiHandlerContext): void {
  const experiments = ctx.db.controlledExperiments
    .listRunningForSessionGate()
    .filter((run) => run.engine === "codex");
  if (experiments.length === 0) return;
  throw createCodexKeySwitchConflict(
    `当前 Client 有 ${experiments.length} 个 Codex 受控实验运行中。请等待实验结束或手动取消后再切换 Key。`,
    {
      reason: CODEX_KEY_SWITCH_CONFLICT_REASONS.controlledExperimentRunning,
      runningCount: experiments.length,
      runningExperiments: experiments.slice(0, CODEX_KEY_SWITCH_PREVIEW_LIMIT).map((run) => ({
        workspaceId: run.workspaceId,
        runId: run.threadId,
        turnId: run.turnId,
        startedAt: run.startedAt,
      })),
    },
  );
}

/** 并行调用正式停止链；任一失败或最终仍有 running 时，禁止进入 Key/native 副作用。 */
async function stopRunningCodexTurns(ctx: ApiHandlerContext, turns: ThreadTurnRecord[]): Promise<void> {
  const results = await Promise.allSettled(
    turns.map(async (turn) => await interruptTurnBestEffort(ctx, turn, { ensureTerminalEvent: true })),
  );
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? [{ turn: turns[index]!, cause: result.reason }]
    : []);
  const pending = await database(ctx, () => listRunningCodexTurns(ctx));
  if (failures.length === 0 && pending.length === 0) return;

  const causes = failures.map(({ cause }) => toEngineKeyError(cause, "Codex 回合停止失败"));
  throw createCodexKeySwitchConflict(
    `Codex 回合未全部安全停止（失败 ${failures.length}，仍运行 ${pending.length}）；Key、native 配置和 app-server 均未切换。`,
    {
      reason: CODEX_KEY_SWITCH_CONFLICT_REASONS.runningTurnsStopFailed,
      requestedCount: turns.length,
      failedCount: failures.length,
      pendingCount: pending.length,
      failedTurns: failures.slice(0, CODEX_KEY_SWITCH_PREVIEW_LIMIT).map(({ turn, cause }) => ({
        ...previewRunningTurn(turn),
        code: String((cause as { code?: unknown })?.code ?? "").trim() || null,
        message: cause instanceof Error ? cause.message : String(cause),
      })),
      pendingTurns: previewRunningTurns(pending),
    },
    causes.length > 0 ? new AggregateError(causes, "Codex 回合停止失败", { cause: causes[0] }) : undefined,
  );
}

/** 构造带稳定 reason 的 409 冲突，统一交给 Key mutation 错误边界响应。 */
function createCodexKeySwitchConflict(
  message: string,
  details: Record<string, unknown>,
  cause?: unknown,
): Error {
  return Object.assign(cause ? new Error(message, { cause }) : new Error(message), {
    code: CODEX_KEY_SWITCH_CONFLICT_CODE,
    details,
  });
}

/** 对 API 明细设上限，只返回停止所需的标识与时间。 */
function previewRunningTurns(turns: ThreadTurnRecord[]) {
  return turns.slice(0, CODEX_KEY_SWITCH_PREVIEW_LIMIT).map(previewRunningTurn);
}

/** 投影单个 running turn，避免把用户正文或 checkpoint 放入错误响应。 */
function previewRunningTurn(turn: ThreadTurnRecord) {
  return {
    workspaceId: turn.workspaceId,
    threadId: turn.threadId,
    turnId: turn.turnId,
    startedAt: turn.startedAt,
  };
}

/** Claude 兼容第三方 provider 需要显式 Base URL，避免误用 Anthropic 官方地址。 */
function requiresClaudeCompatibleBaseUrl(engine: EngineKeyEngine | string, providerId: EngineModelProviderId): boolean {
  return engine === "claude" && providerId !== "anthropic";
}

/** 处理 `engineKeys.deactivate`：停用 provider 默认 Key，允许该 provider 暂无默认 Key。 */
export async function handleEngineKeysDeactivate(ctx: ApiHandlerContext, req: ApiRequestMessage): Promise<void> {
  const id = String((req.body as any)?.id ?? "").trim();
  if (!id) {
    ctx.send({ t: "api.res", id: req.id, status: 400, body: { ok: false, message: "参数错误：id" } });
    return;
  }

  try {
    const target = await database(ctx, () => ctx.db.engineKeys.get(id));
    if (!target) {
      ctx.send({ t: "api.res", id: req.id, status: 404, body: { ok: false, message: "Key 不存在" } });
      return;
    }
    const engine = target.engine as EngineKeyEngine;
    if (target.source === 'builtin') {
      if (!ctx.builtInRelayCredentials) throw new Error('内置凭据服务尚未就绪');
      const deactivated = await ctx.builtInRelayCredentials.deactivate(id, req.id);
      ctx.send({ t: 'api.res', id: req.id, status: 200, body: { ok: true, key: projectEngineKey(ctx, deactivated) } });
      return;
    }
    const deactivated = await runEngineKeyMutationExclusive(engine, async () => {
      const current = await database(ctx, () => requireEngineKeyInScope(ctx, id, engine));
      return await mutateEngineKeysWithNativeSync(
        ctx,
        engine,
        () => ctx.db.engineKeys.deactivate(id),
        () => current.isActive,
      );
    });

    ctx.send({ t: "api.res", id: req.id, status: 200, body: { ok: true, key: projectEngineKey(ctx, deactivated) } });
  } catch (e) {
    sendEngineKeyMutationError(ctx, req, e);
  }
}

/** 同步活动配置；Claude 仅释放配置变化 provider 的旧内置会话。 */
async function syncEngineNativeConfigAfterActiveChange(ctx: ApiHandlerContext, engine: EngineKeyEngine, snapshot: PersistedEngineKey[]): Promise<boolean> {
  if (engine === "claude") {
    if (ctx.builtInRelayCredentials) {
      const current = await database(ctx, () => ctx.db.engineKeys.list().filter(key => key.engine === engine));
      const providers = new Set([...snapshot, ...current].map(key => key.providerId));
      const changedProviders = [...providers].filter(providerId => {
        const before = snapshot.find(key => key.providerId === providerId && key.isActive);
        const after = current.find(key => key.providerId === providerId && key.isActive);
        return before?.id !== after?.id || before?.apiKey !== after?.apiKey || before?.baseUrl !== after?.baseUrl;
      });
      const keyIds = new Set([...snapshot, ...current].filter(key => key.source === 'builtin' && changedProviders.includes(key.providerId)).map(key => key.id));
      await ctx.sessions.releaseCompletedBuiltInClaudeSessions(keyIds);
    }
    return false;
  }

  const active = await database(ctx, () => ctx.db.engineKeys.getFirstActiveForEngine(engine));
  if (active) assertEngineKeySourceVerified(active);
  if (active?.source === 'builtin') return false;
  let nativeConfigWriteAttempted = false;
  try {
    await ctx.sessions.restartCodexProcesses({
      beforeKill: async () => {
        nativeConfigWriteAttempted = true;
        await writeEngineConfig(engine, active
          ? { apiKey: active.apiKey, baseUrl: active.baseUrl }
          : { apiKey: null, baseUrl: null }, {
          backupCodexNativeFiles: true,
        });
      },
    });
    return nativeConfigWriteAttempted;
  } catch (cause) {
    const code = readErrorCode(cause);
    const details = (cause as any)?.details;
    throw Object.assign(new Error("Codex native 配置同步或 app-server 重启失败", { cause }), {
      nativeConfigWriteAttempted,
      ...(code ? { code } : {}),
      ...(details ? { details } : {}),
    });
  }
}

/** 同一引擎的 Key 变更严格串行，不同引擎保留并行能力。 */
export async function runEngineKeyMutationExclusive<T>(engine: EngineKeyEngine, action: () => T | Promise<T>): Promise<T> {
  const previous = engineKeyMutationTailByEngine.get(engine) ?? Promise.resolve();
  const operation = previous.then(action);
  const tail = operation.then(() => undefined, () => undefined);
  engineKeyMutationTailByEngine.set(engine, tail);
  try {
    return await operation;
  } finally {
    if (engineKeyMutationTailByEngine.get(engine) === tail) {
      engineKeyMutationTailByEngine.delete(engine);
    }
  }
}

/** 执行 Key 变更；native 同步失败时恢复完整 DB 快照与已触碰的原生配置。 */
async function mutateEngineKeysWithNativeSync<T>(
  ctx: ApiHandlerContext,
  engine: EngineKeyEngine,
  mutate: () => T,
  requiresNativeSync: (value: T) => boolean,
): Promise<T> {
  const { snapshot, value } = await database(ctx, () => ({ snapshot: ctx.db.engineKeys.list().filter((entry) => entry.engine === engine), value: mutate() }));
  if (!requiresNativeSync(value)) return value;

  let nativeConfigWriteAttempted = false;
  try {
    nativeConfigWriteAttempted = await syncEngineNativeConfigAfterActiveChange(ctx, engine, snapshot);
    const selected = value as PersistedEngineKey | undefined;
    if (selected?.isActive && selected.source === 'user_configured') {
      await database(ctx, () => {
        if (ctx.builtInRelayCredentials) ctx.builtInRelayCredentials.confirmUserConfigured(selected);
        else ctx.db.engineKeys.clearNativeFallbackBlock(engine, selected.providerId);
      });
    }
    return value;
  } catch (cause) {
    const failures = [toEngineKeyError(cause, "native 配置同步失败")];
    try {
      await database(ctx, () => ctx.db.engineKeys.restoreEngineSnapshot(engine, snapshot));
    } catch (restoreCause) {
      failures.push(toEngineKeyError(restoreCause, "恢复 Key 数据失败"));
    }
    if (engine === "codex" && (nativeConfigWriteAttempted || Boolean((cause as any)?.nativeConfigWriteAttempted))) {
      try {
        const active = resolveSnapshotActiveKey(snapshot);
        await writeEngineConfig(engine, active?.source === 'user_configured'
          ? { apiKey: active.apiKey, baseUrl: active.baseUrl }
          : { apiKey: null, baseUrl: null });
      } catch (restoreCause) {
        failures.push(toEngineKeyError(restoreCause, "恢复 Codex 原生配置失败"));
      }
    }
    const detail = failures.map((failure) => failure.message).join("；"), label = engine === 'codex' ? 'Codex' : 'Claude';
    const aggregate = new AggregateError(
      failures,
      `${failures.length === 1
        ? `${label} 配置同步失败，Key 数据已恢复`
        : `${label} 配置同步失败，且补偿未完整完成`}：${detail}`,
      { cause: failures[0] },
    );
    const code = readErrorCode(cause);
    const details = (cause as any)?.details;
    throw Object.assign(aggregate, {
      ...(code ? { code } : {}),
      ...(details ? { details } : {}),
    });
  }
}

/** 锁内重新读取目标，避免使用排队前的 active/provider 状态。 */
function requireEngineKeyInScope(ctx: ApiHandlerContext, id: string, engine: EngineKeyEngine): PersistedEngineKey {
  const entry = ctx.db.engineKeys.get(id);
  if (!entry) throw new Error(`engine_key 不存在：${id}`);
  assertEngineKeyScope(entry, engine);
  return entry;
}

/** Key 的 engine 不可变；检测到范围漂移时拒绝继续补偿。 */
function assertEngineKeyScope(entry: PersistedEngineKey, engine: EngineKeyEngine): void {
  if (entry.engine !== engine) {
    throw new Error(`engine_key 引擎范围已变化：${entry.id}`);
  }
}

/** Key mutation 统一映射冲突码，避免配置门禁被通用 500 吞掉。 */
function sendEngineKeyMutationError(ctx: ApiHandlerContext, req: ApiRequestMessage, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = readErrorCode(cause);
  const details = (cause as any)?.details;
  const body = req.body as { id?: unknown; apiKey?: unknown } | null;
  const keyId = String(body?.id ?? "").trim() || null;
  const logContext = {
    requestId: req.id,
    method: req.method,
    keyId,
    errorCode: code ?? "INTERNAL_ERROR",
    reason: String((details as Record<string, unknown> | null)?.reason ?? "UNKNOWN"),
    rootCause: summarizeEngineKeyError(cause, typeof body?.apiKey === "string" ? body.apiKey : ""),
  };
  if (code === CODEX_KEY_SWITCH_CONFLICT_CODE) {
    logger.warn("engine-key", "engine key mutation blocked", logContext);
  } else {
    logger.error("engine-key", "engine key mutation failed", logContext);
  }
  ctx.onApiFailureLogged?.();
  ctx.send({
    t: "api.res",
    id: req.id,
    status: code === CODEX_KEY_SWITCH_CONFLICT_CODE ? 409 : 500,
    body: {
      ok: false,
      message,
      ...(code ? { code } : {}),
      ...(details ? { details } : {}),
    },
  });
}

/** 从补偿包装错误中读取稳定业务码。 */
function readErrorCode(cause: unknown): string | null {
  const code = String((cause as any)?.code ?? "").trim();
  return code === CODEX_KEY_SWITCH_CONFLICT_CODE || code.startsWith('BUILT_IN_RELAY_') ? code : null;
}

/** 提取最深层错误摘要，并从日志文本中移除当前请求携带的 Key。 */
function summarizeEngineKeyError(cause: unknown, apiKey: string): { name: string; code: string | null; message: string } {
  let current = cause;
  for (let depth = 0; depth < 6; depth += 1) {
    const next = current instanceof AggregateError && current.errors.length > 0
      ? current.errors[0]
      : (current as { cause?: unknown } | null)?.cause;
    if (!next || next === current) break;
    current = next;
  }
  const message = current instanceof Error ? current.message : String(current ?? "unknown error");
  return {
    name: current instanceof Error ? current.name : typeof current,
    code: String((current as { code?: unknown } | null)?.code ?? "").trim() || null,
    message: apiKey ? message.replaceAll(apiKey, "[REDACTED]") : message,
  };
}

/** 按仓储同一排序口径选择快照中的引擎 active Key。 */
function resolveSnapshotActiveKey(snapshot: PersistedEngineKey[]): PersistedEngineKey | null {
  return [...snapshot]
    .filter((entry) => entry.isActive)
    .sort((left, right) => (
      right.updatedAt - left.updatedAt
      || right.createdAt - left.createdAt
      || right.id.localeCompare(left.id)
    ))[0] ?? null;
}

/** 将未知异常规范化为可聚合错误。 */
function toEngineKeyError(cause: unknown, fallback: string): Error {
  if (cause instanceof Error) return cause;
  const message = String(cause ?? "").trim();
  return new Error(message || fallback, { cause });
}
