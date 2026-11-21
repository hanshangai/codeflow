type CleanupDiagnostic = (phase: "start" | "success" | "fail", error?: unknown) => void;

/** 用户批准诊断降级：普通日志失败走 stderr 告警，不阻止资源释放；业务失败仍原样抛出。 */
export function runClientCleanupStep(action: () => void, diagnostic: CleanupDiagnostic): void {
  reportCleanupDiagnostic(diagnostic, "start");
  let failure: { error: unknown } | null = null;
  try { action(); } catch (error) { failure = { error }; }
  reportCleanupDiagnostic(diagnostic, failure ? "fail" : "success", failure?.error);
  if (failure) throw failure.error;
}

/** 等待真实释放；诊断故障只告警，保存及清理故障仍交回关闭入口。 */
export async function runClientAsyncCleanupStep(action: () => Promise<void>, diagnostic: CleanupDiagnostic): Promise<void> {
  reportCleanupDiagnostic(diagnostic, "start");
  let failure: { error: unknown } | null = null;
  try { await action(); } catch (error) { failure = { error }; }
  reportCleanupDiagnostic(diagnostic, failure ? "fail" : "success", failure?.error);
  if (failure) throw failure.error;
}

/** 诊断路径不可影响清理结论；保留关闭关联，持久日志恢复后仍可检索 stderr。 */
function reportCleanupDiagnostic(diagnostic: CleanupDiagnostic, phase: "start" | "success" | "fail", failure?: unknown): void {
  try { diagnostic(phase, failure); }
  catch (error) { console.warn("[CLIENT_CLEANUP_DIAGNOSTIC_FAILED]", { requestId: `shutdown:${process.pid}`, phase,
    rootCause: error instanceof Error ? error.message : String(error) }); }
}
