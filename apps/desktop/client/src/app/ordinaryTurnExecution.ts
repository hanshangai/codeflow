import { MANUAL_TURN_INTERRUPT_CODE, type ThreadId, type TurnId, type WorkspaceId } from "@codeflowai/shared";

export type OrdinaryTurnExecutionScope = { workspaceId: WorkspaceId; threadId: ThreadId; turnId: TurnId };
export type OrdinaryTurnExecutionControl = { assertNotCancelled(): void; isCancellation(error: unknown): boolean; markProviderDispatch(): void };
type ExecutionOwner = { scope: OrdinaryTurnExecutionScope; promise: Promise<PromiseSettledResult<void>>;
  localWorkspaceOnly: boolean; providerDispatched: boolean; cancellation: Error | null; result?: PromiseSettledResult<void> };
const executions = new WeakMap<object, Map<string, ExecutionOwner>>();

/** 精确身份不能为空；使用数组编码避免标识分隔符产生别名。 */
function scopeKey(scope: OrdinaryTurnExecutionScope): string {
  if (!scope || [scope.workspaceId, scope.threadId, scope.turnId].some(value => typeof value !== "string" || !value.trim())) {
    throw Object.assign(new Error("普通回合执行身份无效"), { code: "ORDINARY_TURN_EXECUTION_SCOPE_INVALID" });
  }
  return JSON.stringify([scope.workspaceId, scope.threadId, scope.turnId]);
}

/** 登记完整尾链、已校验本机归属和provider派发事实；取消只属于此精确owner。 */
export function trackOrdinaryTurnExecution(sessions: object, scope: OrdinaryTurnExecutionScope & { localWorkspaceOnly?: boolean }, run: (control: OrdinaryTurnExecutionControl) => Promise<void>): void {
  const key = scopeKey(scope);
  let owned = executions.get(sessions);
  if (!owned) { owned = new Map(); executions.set(sessions, owned); }
  if (owned.has(key)) throw Object.assign(new Error("普通回合已有执行 owner"), { code: "ORDINARY_TURN_EXECUTION_ALREADY_OWNED", ...scope });
  const owners = owned;
  const owner: ExecutionOwner = { scope: { workspaceId: scope.workspaceId, threadId: scope.threadId, turnId: scope.turnId },
    localWorkspaceOnly: scope.localWorkspaceOnly === true, promise: undefined!, providerDispatched: false, cancellation: null };
  owners.set(key, owner);
  const control: OrdinaryTurnExecutionControl = {
    /** 准备完成后与等待围栏中复核，禁止取消后继续副作用。 */
    assertNotCancelled() { if (owner.cancellation) throw owner.cancellation; },
    /** 只认同一 owner 的取消原因，清理或 provider 原错误不能冒充预期取消。 */
    isCancellation(error) { return owner.cancellation !== null && error === owner.cancellation; },
    /** 与调用 provider 同步登记，交接后只能沿原 provider 入口确认停止。 */
    markProviderDispatch() { control.assertNotCancelled(); owner.providerDispatched = true; },
  };
  owner.promise = Promise.resolve().then(() => run(control)).then(() => {
    const result: PromiseFulfilledResult<void> = { status: "fulfilled", value: undefined };
    owner.result = result;
    if (owners.get(key) === owner) owners.delete(key);
    return result;
  }, reason => {
    owner.result = { status: "rejected", reason };
    return owner.result;
  });
}

/** 只复用原执行owner准入时已核的本机归属；失败尾链仍保留证明，不猜测共享线程权限。 */
export function isLocalOrdinaryTurnExecution(sessions: object, scope: OrdinaryTurnExecutionScope): boolean {
  return executions.get(sessions)?.get(scopeKey(scope))?.localWorkspaceOnly === true;
}

/** 仅取消能够证明尚未派发的在途回合；已派发、未知或不存在的 owner 不提供本地停止证明。 */
export function cancelOrdinaryTurnBeforeDispatch(sessions: object, scope: OrdinaryTurnExecutionScope): boolean {
  const owner = executions.get(sessions)?.get(scopeKey(scope));
  if (!owner || owner.result || owner.providerDispatched) return false;
  owner.cancellation ??= Object.assign(new Error("普通回合已中断"), { code: MANUAL_TURN_INTERRUPT_CODE,
    terminationKind: "manual_interrupt", ...owner.scope });
  return true;
}

/** 只返回仍在执行的原 owner；历史失败仅供精确等待，不持续触发更新确认。 */
export function listOrdinaryTurnExecutions(sessions: object): ReadonlyArray<OrdinaryTurnExecutionScope> {
  return [...(executions.get(sessions)?.values() ?? [])].filter(owner => !owner.result).map(owner => ({ ...owner.scope }));
}

/** 读取真实在途尾链，不根据数据库终态推断准备或清理已经完成。 */
export function hasOrdinaryTurnExecutions(sessions: object): boolean {
  return listOrdinaryTurnExecutions(sessions).length > 0;
}

/** 精确等待同一 owner；超时不移除资源，原拒绝值可由后续等待者重复观察。 */
export async function waitForOrdinaryTurnExecution(
  sessions: object, scope: OrdinaryTurnExecutionScope, options: { timeoutMs?: number } = {},
): Promise<void> {
  const key = scopeKey(scope), timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw Object.assign(new Error("普通回合等待超时无效"), { code: "ORDINARY_TURN_EXECUTION_TIMEOUT_INVALID", ...scope });
  }
  const owner = executions.get(sessions)?.get(key);
  if (!owner) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = timeoutMs === undefined ? await owner.promise : await Promise.race([owner.promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("普通回合执行尚未收口"),
        { code: "ORDINARY_TURN_EXECUTION_TIMEOUT", ...scope })), timeoutMs); }),
    ]);
    if (result.status === "rejected") throw result.reason;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** 只排空关闭时仍在执行的尾链；历史失败留给精确等待，不重复阻断退出。 */
export async function drainOrdinaryTurnExecutions(sessions: object): Promise<void> {
  const observed = new Set<ExecutionOwner>(), failures: unknown[] = [];
  while (true) {
    const pending = [...(executions.get(sessions)?.values() ?? [])].filter(owner => !owner.result && !observed.has(owner));
    if (!pending.length) break;
    for (const owner of pending) {
      observed.add(owner);
      cancelOrdinaryTurnBeforeDispatch(sessions, owner.scope);
    }
    const results = await Promise.all(pending.map(owner => owner.promise));
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "ORDINARY_TURN_DRAIN_FAILED", { cause: failures[0] });
}
