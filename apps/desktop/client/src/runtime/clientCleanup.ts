type CleanupDiagnostic = (phase: "start" | "success" | "fail", error?: unknown) => void;

/** 必要清理不被诊断失败跳过；按发生顺序保留原值，由统一退出 owner 消费。 */
export function runClientCleanupStep(action: () => void, diagnostic: CleanupDiagnostic): void {
  const errors: unknown[] = [];
  try { diagnostic("start"); } catch (error) { errors.push(error); }
  let failure: { error: unknown } | null = null;
  try { action(); } catch (error) { failure = { error }; errors.push(error); }
  try { diagnostic(failure ? "fail" : "success", failure?.error); } catch (error) { errors.push(error); }
  throwCleanupFailures(errors);
}

/** 原异步 owner 等待真正释放；日志、描述和清理任一失败均返回失败。 */
export async function runClientAsyncCleanupStep(action: () => Promise<void>, diagnostic: CleanupDiagnostic): Promise<void> {
  const errors: unknown[] = [];
  try { diagnostic("start"); } catch (error) { errors.push(error); }
  let failure: { error: unknown } | null = null;
  try { await action(); } catch (error) { failure = { error }; errors.push(error); }
  try { diagnostic(failure ? "fail" : "success", failure?.error); } catch (error) { errors.push(error); }
  throwCleanupFailures(errors);
}

/** 单错保持身份，多错的 cause 为实际发生的第一项，包括 falsy 值。 */
function throwCleanupFailures(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "CLIENT_CLEANUP_STEP_FAILED", { cause: errors[0] });
}
