import crypto from 'node:crypto';
import { discoverLegacyClientMigration, migrateLegacyClientMigration, deferLegacyClientMigration } from './legacyClientMigration.js';
import { legacyClientMigrationErrorContext, parseLegacyClientMigrationRequest, type LegacyClientMigrationMessage,
  type LegacyClientMigrationProgress } from './legacyClientMigrationProtocol.js';

/** IPC 写入必须确认，父进程断开不能被当作结果已交付。 */
function send(message: LegacyClientMigrationMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) { reject(new Error('MIGRATION_PARENT_DISCONNECTED')); return; }
    process.send(message, error => error ? reject(error) : resolve());
  });
}

/** Worker 一次仅处理宿主的一条请求，清理完成并正常退出后结果才生效。 */
export function startLegacyClientMigrationWorker(): void {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort(new Error('MIGRATION_CANCELLED')));
  process.once('SIGINT', () => controller.abort(new Error('MIGRATION_CANCELLED')));
  process.once('disconnect', () => controller.abort(new Error('MIGRATION_PARENT_DISCONNECTED')));
  process.once('message', async value => {
    const requestId = crypto.randomUUID();
    let stage = 'request', migrationId: string | undefined, targetClientId: string | undefined;
    try {
      const request = parseLegacyClientMigrationRequest(value); migrationId = request.migrationId; targetClientId = request.targetClientId; stage = request.action;
      const dependencies = { signal: controller.signal,
        onProgress(progress: LegacyClientMigrationProgress) {
          stage = progress.stage;
          if (!process.send || !process.connected) throw new Error('MIGRATION_PARENT_DISCONNECTED');
          process.send({ type: 'progress', progress }, error => { if (error) controller.abort(error); });
        } };
      const result = request.action === 'discover' ? await discoverLegacyClientMigration(request, dependencies)
        : request.action === 'defer' ? deferLegacyClientMigration(request) : await migrateLegacyClientMigration(request, dependencies);
      if (request.action === 'defer') process.stderr.write(`${JSON.stringify({ event: 'LEGACY_MIGRATION_DEFERRED', requestId,
        migrationId, targetClientId, stage: 'defer', outcome: 'success' })}\n`);
      controller.signal.throwIfAborted(); await send({ type: 'result', result });
      process.exitCode = 0;
    } catch (error) {
      const rawCode = (error as { code?: unknown })?.code;
      const code = typeof rawCode === 'string' && /^[A-Z0-9_]+$/.test(rawCode) ? rawCode : 'LEGACY_MIGRATION_FAILED';
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      const causeCode = (cause as { code?: unknown })?.code, context = legacyClientMigrationErrorContext(error);
      // 只记录错误类型与摘要，JSON/HTTP/SQLite 异常可能含凭据或正文。
      process.stderr.write(`${JSON.stringify({ errorCode: code, requestId, migrationId, targetClientId, stage,
        context,
        event: { category: 'desktop', action: 'legacy_client_migration', outcome: 'failure' },
        rootCause: { type: cause instanceof Error ? cause.name : typeof cause,
          ...(typeof causeCode === 'string' && /^[A-Z0-9_]+$/.test(causeCode) ? { code: causeCode } : {}),
          fingerprint: crypto.createHash('sha256').update(cause instanceof Error ? cause.message : String(cause)).digest('hex') } })}\n`);
      process.exitCode = 1;
      if (process.connected) await send({ type: 'error', error: { code, message: '旧 Client 数据迁移失败，原数据保留。', context } });
    } finally { if (process.connected) process.disconnect?.(); }
  });
}

if (process.send) startLegacyClientMigrationWorker();
