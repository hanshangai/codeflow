export type UpdateNetworkEvidence = { kind: "device-registration" | "shell-manifest" | "shell-installer" | "shell-switch-authorization"; sha256: string };
export type UpdateNetworkIdentity = { actionKey: string; requestSha256: string };
export type UpdateNetworkSlot = UpdateNetworkIdentity & (
  | { status: "dispatching" }
  | { status: "waiting"; delayMs: number; notBefore: number }
  | { status: "succeeded"; evidence: UpdateNetworkEvidence }
  | { status: "failed"; errorCode: string }
);
export type UpdateNetworkDurableState = { revision: number; retriesUsed: number; network: UpdateNetworkSlot | null };
export type UpdateNetworkDurableAdapter = {
  /** 读取唯一 attempt 的实际网络投影，禁止补造初始状态。 */
  read(): Promise<UpdateNetworkDurableState>;
  /** expected 替换并读回；保存或后验失败必须抛出。 */
  replace(expected: UpdateNetworkDurableState, next: Pick<UpdateNetworkDurableState, "retriesUsed" | "network">): Promise<UpdateNetworkDurableState>;
};
export type UpdateNetworkRecovery<T> = { status: "verified"; value: T; evidence: UpdateNetworkEvidence } | { status: "unknown" };
export type UpdateNetworkAction<T> = UpdateNetworkIdentity & {
  /** 不联网；必要的验证、sync/rename/close 完成后才交还证据。 */
  persistResult(value: T): Promise<UpdateNetworkEvidence>;
  /** 只复验真实本地工件并重建值，无可信工件时返回 unknown。 */
  recoverResult(evidence: UpdateNetworkEvidence | null): Promise<UpdateNetworkRecovery<T>>;
};
export type UpdateNetworkRetry = { run<T>(operation: () => Promise<T>, action?: UpdateNetworkAction<T>): Promise<T> };

const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const NETWORK_WRAPPERS = new Set(["DESKTOP_UPDATE_TRANSPORT_FAILED", "DESKTOP_UPDATE_RESPONSE_INVALID", "DESKTOP_UPDATE_HTTP_FAILED"]);
const HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);

/** 仅把原生取消映射回本轮 reason，其他根因和聚合清理失败原样保留。 */
export function preserveUpdateNetworkCancellation(cause: unknown, signal: AbortSignal | undefined): unknown {
  return signal?.aborted && cause instanceof DOMException && cause.name === "AbortError" ? signal.reason : cause;
}

/** 为一轮更新提供共享网络重试边界，最终失败原样交给调用者。 */
export function createUpdateNetworkRetry(input: { signal: AbortSignal; onRetry: (context: { retry: number; delayMs: number; error: unknown }) => void | Promise<void>;
  onExhausted?: (error: unknown) => void; durable?: UpdateNetworkDurableAdapter }): UpdateNetworkRetry {
  let retries = 0;
  let running = false;

  /** 原瞬时调用保持既有预算和错误边界。 */
  async function runTransient<T>(operation: () => Promise<T>): Promise<T> {
    while (true) {
      input.signal.throwIfAborted();
      try {
        const result = await operation();
        input.signal.throwIfAborted();
        return result;
      } catch (error) {
        if (retries === 3 || !isTransientNetworkError(error)) {
          if (retries === 3 && !input.signal.aborted && isTransientNetworkError(error)) reportExhausted(error);
          throw error;
        }
        input.signal.throwIfAborted();
        const retry = ++retries;
        const delayMs = retryDelay(error, 1000 * 2 ** (retry - 1));
        await input.onRetry({ retry, delayMs, error });
        await waitForRetry(delayMs, input.signal);
      }
    }
  }

  /** 每次采用实际读回事实；任何保存或后验失败均不得发送。 */
  async function save(state: UpdateNetworkDurableState, network: UpdateNetworkSlot): Promise<UpdateNetworkDurableState> {
    const retriesUsed = state.retriesUsed + (network.status === "waiting" ? 1 : 0);
    const observed = snapshotUpdateNetworkDurableState(await input.durable!.replace(state, { retriesUsed, network }));
    if (observed.revision !== state.revision + 1 || observed.retriesUsed !== retriesUsed || JSON.stringify(observed.network) !== JSON.stringify(network)) {
      throw networkError("DESKTOP_SHELL_NETWORK_STATE_CONFLICT", network);
    }
    return observed;
  }

  /** 恢复与结果钩子不参与重试；纯取消可透过已知单层网络包装，独立故障仍须结算失败。 */
  async function runDurable<T>(operation: () => Promise<T>, action: UpdateNetworkAction<T>): Promise<T> {
    input.signal.throwIfAborted();
    let state = snapshotUpdateNetworkDurableState(await input.durable!.read());
    input.signal.throwIfAborted();
    const identity = { actionKey: action.actionKey, requestSha256: action.requestSha256 };
    let slot = state.network;
    if (slot !== null && slot.actionKey === identity.actionKey && slot.requestSha256 !== identity.requestSha256) {
      throw networkError("DESKTOP_SHELL_NETWORK_STATE_CONFLICT", identity);
    }
    if (slot === null || slot.actionKey !== identity.actionKey) {
      if (slot !== null && slot.status !== "succeeded") throw networkError("DESKTOP_SHELL_NETWORK_STATE_CONFLICT", identity);
      state = await save(state, { ...identity, status: "dispatching" });
    } else if (slot.status === "dispatching" || slot.status === "succeeded") {
      input.signal.throwIfAborted();
      const expectedEvidence = slot.status === "succeeded" ? { ...slot.evidence } : null;
      const recovery = readRecovery<T>(await action.recoverResult(expectedEvidence === null ? null : { ...expectedEvidence }));
      input.signal.throwIfAborted();
      if (recovery.status === "unknown") throw networkError("DESKTOP_SHELL_NETWORK_RESULT_UNKNOWN", identity);
      if (slot.status === "succeeded") {
        if (JSON.stringify(recovery.evidence) !== JSON.stringify(expectedEvidence)) throw networkError("DESKTOP_SHELL_NETWORK_STATE_CONFLICT", identity);
      } else state = await save(state, { ...identity, status: "succeeded", evidence: recovery.evidence });
      input.signal.throwIfAborted();
      return recovery.value;
    } else if (slot.status === "failed") {
      throw networkError("DESKTOP_SHELL_NETWORK_ACTION_FAILED", identity, { errorCode: slot.errorCode });
    }
    while (true) {
      slot = state.network!;
      if (slot.status === "waiting") {
        await waitForRetry(slot.delayMs, input.signal);
        while (Date.now() < slot.notBefore) await waitForRetry(slot.notBefore - Date.now(), input.signal);
        state = await save(state, { ...identity, status: "dispatching" });
      }
      input.signal.throwIfAborted();
      let value: T;
      try { value = await operation(); }
      catch (error) {
        if (input.signal.aborted) {
          const wrappedCancellation = error instanceof Error && !(error instanceof AggregateError) && "code" in error
            && typeof error.code === "string" && NETWORK_WRAPPERS.has(error.code) && error.cause === input.signal.reason;
          if (error === input.signal.reason || error instanceof DOMException && error.name === "AbortError"
            || wrappedCancellation || isTransientNetworkError(error)) throw input.signal.reason;
        }
        if (isTransientNetworkError(error) && !input.signal.aborted && state.retriesUsed < 3) {
          let delayMs: number;
          try {
            delayMs = retryDelay(error, 1000 * 2 ** state.retriesUsed);
            const notBefore = safeInteger(Date.now() + delayMs);
            state = await save(state, { ...identity, status: "waiting", delayMs, notBefore });
          }
          catch (additional) { throw new AggregateError([error, additional], "DESKTOP_SHELL_NETWORK_RETRY_SAVE_FAILED"); }
          await input.onRetry({ retry: state.retriesUsed, delayMs, error });
          continue;
        }
        try { await save(state, { ...identity, status: "failed", errorCode: failureCode(error) }); }
        catch (additional) { throw new AggregateError([error, additional], "DESKTOP_SHELL_NETWORK_FAILURE_SAVE_FAILED"); }
        if (state.retriesUsed === 3 && !input.signal.aborted && isTransientNetworkError(error)) reportExhausted(error);
        throw error;
      }
      input.signal.throwIfAborted();
      const evidence = readEvidence(await action.persistResult(value));
      input.signal.throwIfAborted();
      state = await save(state, { ...identity, status: "succeeded", evidence });
      input.signal.throwIfAborted();
      return value;
    }
  }
  /** 原预算明确耗尽才报告；观察失败仍保留网络原因并拒绝。 */
  function reportExhausted(error: unknown): void {
    try { input.onExhausted?.(error); }
    catch (additional) { throw new AggregateError([error, additional], "DESKTOP_UPDATE_OBSERVATION_FAILED"); }
  }
  return {
    /** operation 须包含单次发送、正文验证和清理；耐久模式先复制动作并拒绝重入。 */
    async run<T>(operation: () => Promise<T>, actionInput?: UpdateNetworkAction<T>): Promise<T> {
      if (!input.durable) return runTransient(operation);
      const action = readAction<T>(actionInput);
      if (running) throw networkError("DESKTOP_SHELL_NETWORK_BUSY", action);
      running = true;
      try { return await runDurable(operation, action); }
      finally { running = false; }
    },
  };
}

/** 供唯一 attempt adapter 和调度器共同复制严格网络事实，不调用访问器。 */
export function snapshotUpdateNetworkDurableState(input: unknown): UpdateNetworkDurableState {
  const value = dataFields(input, ["revision", "retriesUsed", "network"]);
  const revision = safeInteger(value.revision), retriesUsed = safeInteger(value.retriesUsed);
  if (retriesUsed > 3 || revision < retriesUsed) throw networkError("DESKTOP_SHELL_NETWORK_STATE_INVALID");
  let network: UpdateNetworkSlot | null = null;
  if (value.network !== null) {
    const status = dataFields(value.network).status;
    const extra = status === "waiting" ? ["delayMs", "notBefore"] : status === "succeeded" ? ["evidence"] : status === "failed" ? ["errorCode"] : [];
    const slot = dataFields(value.network, ["actionKey", "requestSha256", "status", ...extra]);
    const identity = readIdentity(slot);
    if (status === "dispatching") network = { ...identity, status };
    else if (status === "waiting") network = { ...identity, status, delayMs: safeInteger(slot.delayMs), notBefore: safeInteger(slot.notBefore) };
    else if (status === "succeeded") network = { ...identity, status, evidence: readEvidence(slot.evidence) };
    else if (status === "failed" && typeof slot.errorCode === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(slot.errorCode)) network = { ...identity, status, errorCode: slot.errorCode };
    else throw networkError("DESKTOP_SHELL_NETWORK_STATE_INVALID", identity);
  }
  return { revision, retriesUsed, network };
}

/** 动作材料不可含未知字段、继承值或 getter，钩子只在明确阶段调用。 */
function readAction<T>(input: unknown): UpdateNetworkAction<T> {
  const value = dataFields(input, ["actionKey", "requestSha256", "persistResult", "recoverResult"], "DESKTOP_SHELL_NETWORK_ACTION_INVALID");
  const identity = readIdentity(value, "DESKTOP_SHELL_NETWORK_ACTION_INVALID");
  if (typeof value.persistResult !== "function" || typeof value.recoverResult !== "function") throw networkError("DESKTOP_SHELL_NETWORK_ACTION_INVALID", identity);
  return { ...identity, persistResult: value.persistResult as UpdateNetworkAction<T>["persistResult"], recoverResult: value.recoverResult as UpdateNetworkAction<T>["recoverResult"] };
}

/** 可信恢复必须显式携带完整本地值和证据，unknown 不等同于允许重发。 */
function readRecovery<T>(input: unknown): UpdateNetworkRecovery<T> {
  const status = dataFields(input).status;
  const value = dataFields(input, status === "verified" ? ["status", "value", "evidence"] : ["status"]);
  if (status === "unknown") return { status };
  if (status !== "verified") throw networkError("DESKTOP_SHELL_NETWORK_STATE_INVALID");
  return { status, value: value.value as T, evidence: readEvidence(value.evidence) };
}

/** 证据只记录允许的工件类别和完整摘要，真实工件仍由恢复钩子核实。 */
function readEvidence(input: unknown): UpdateNetworkEvidence {
  const value = dataFields(input, ["kind", "sha256"]);
  if (!["device-registration", "shell-manifest", "shell-installer", "shell-switch-authorization"].includes(value.kind as string)) throw networkError("DESKTOP_SHELL_NETWORK_STATE_INVALID");
  return { kind: value.kind as UpdateNetworkEvidence["kind"], sha256: digest(value.sha256) };
}

/** 稳定动作键与规范请求摘要共同绑定本次网络副作用。 */
function readIdentity(value: Record<string, unknown>, code = "DESKTOP_SHELL_NETWORK_STATE_INVALID"): UpdateNetworkIdentity {
  if (typeof value.actionKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/.test(value.actionKey)) throw networkError(code);
  return { actionKey: value.actionKey, requestSha256: digest(value.requestSha256, code) };
}

/** 严格复制自有 data descriptor，避免输入执行代码或在等待中漂移。 */
function dataFields(input: unknown, expected?: readonly string[], code = "DESKTOP_SHELL_NETWORK_STATE_INVALID"): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw networkError(code);
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key !== "string") || expected && (keys.length !== expected.length || keys.some(key => !expected.includes(key as string)))) throw networkError(code);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw networkError(code);
    result[key as string] = descriptor.value;
  }
  return result;
}

/** 持久时间和版本必须能无损写入 JSON。 */
function safeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw networkError("DESKTOP_SHELL_NETWORK_STATE_INVALID");
  return value;
}

/** 不归一化摘要，拒绝调用方身份材料漂移。 */
function digest(value: unknown, code = "DESKTOP_SHELL_NETWORK_STATE_INVALID"): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw networkError(code);
  return value;
}

/** 无错误码根因仍显式失败，槽只保存可检索分类而不伪造原异常。 */
function failureCode(error: unknown): string {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(code) ? code : "DESKTOP_SHELL_NETWORK_OPERATION_FAILED";
}

/** 新网络错误携带稳定动作上下文，原操作错误由调用方原样接收。 */
function networkError(code: string, identity?: UpdateNetworkIdentity, extra?: object): Error {
  return Object.assign(new Error(code), { code, ...identity, ...extra });
}

/** 按本地 HTTP 类型或明确网络包装识别故障，远端业务码不能改变重试分类。 */
function isTransientNetworkError(error: unknown): boolean {
  const chain: Error[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error) {
    if (current instanceof AggregateError || seen.has(current)) return false;
    seen.add(current); chain.push(current); current = current.cause;
  }
  const root = chain[0] as Error & { code?: unknown; transportCode?: unknown; status?: unknown } | undefined;
  if (root?.transportCode === "DESKTOP_UPDATE_HTTP_FAILED") return typeof root.status === "number" && HTTP_STATUSES.has(root.status);
  if (!root || typeof root.code !== "string" || !NETWORK_WRAPPERS.has(root.code)) return false;
  if (root.code === "DESKTOP_UPDATE_HTTP_FAILED") return typeof root.status === "number" && HTTP_STATUSES.has(root.status);
  for (const cause of chain.slice(1)) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;
    if (cause instanceof DOMException && cause.name === "TimeoutError") return true;
    if (!(cause instanceof TypeError) && !(typeof code === "string" && NETWORK_WRAPPERS.has(code))) return false;
  }
  return false;
}

/** 合法秒数或 HTTP 日期优先；无效头保持当前共享次数的指数退避。 */
function retryDelay(error: unknown, fallback: number): number {
  const value = (error as { retryAfter?: unknown }).retryAfter;
  if (typeof value !== "string") return fallback;
  if (/^\d+$/u.test(value)) return Math.min(Number(value) * 1000, Number.MAX_SAFE_INTEGER);
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(value)) return fallback;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toUTCString() !== value) return fallback;
  return Math.max(0, timestamp - Date.now());
}

/** 分段等待避免 Node 定时器溢出；退出取消保留同一个 reason 并释放监听器。 */
async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  let remaining = delayMs;
  signal.throwIfAborted();
  while (remaining > 0) {
    const duration = Math.min(remaining, 2147483647);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, duration);
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    remaining -= duration;
    signal.throwIfAborted();
  }
}
