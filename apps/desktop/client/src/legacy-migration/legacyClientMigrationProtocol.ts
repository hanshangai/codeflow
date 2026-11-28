export type LegacyClientMigrationRequest = {
  action: 'discover' | 'migrate' | 'defer';
  dataDir: string;
  targetClientId: string;
  targetDeviceId: string;
  candidateId?: string;
  migrationId?: string;
};

export type LegacyClientMigrationProgress = {
  stage: string; completed: number; total: number | null; workspaceCount?: number;
  phase?: string; table?: string; workspaceIndex?: number; threadIndex?: number; threadCount?: number;
  processed?: number; elapsedMs?: number;
};
export type LegacyClientMigrationContext = {
  requestId?: string; phase?: string; method?: string; endpoint?: string; status?: number; retryAfter?: string;
  remoteCode?: string; transportCode?: string; serverRequestId?: string;
  workspaceId?: string; threadId?: string; table?: string; recordId?: string; blobId?: string; expectedSize?: number; actualSize?: number;
  storedSize?: number; reason?: string; workspaceCount?: number;
};
/** 目标库已被正常使用时，只返回可脱敏的判定证据，不回显路径或业务正文。 */
export type LegacyClientMigrationTargetInUse = {
  reason: string;
  table?: string;
  workspaceCount?: number;
};
export type LegacyClientMigrationResult = {
  candidateId: string | null;
  workspaceCount: number;
  migrationId?: string;
  completed?: boolean;
  resume?: boolean;
  canDefer?: boolean;
  deferred?: boolean;
  targetInUse?: LegacyClientMigrationTargetInUse;
  accountSource?: { sourceClientId: string; apiKey: string; serverWs: string };
};
export type LegacyClientMigrationMessage =
  | { type: 'progress'; progress: LegacyClientMigrationProgress }
  | { type: 'result'; result: LegacyClientMigrationResult }
  | { type: 'error'; error: { code: string; message: string; context?: LegacyClientMigrationContext } };

/** 错误只跨 IPC 传固定字段；拒绝正文、密钥和任意服务端扩展。 */
export function legacyClientMigrationErrorContext(error: unknown): LegacyClientMigrationContext {
  const source = (error as { context?: unknown } | null)?.context as Record<string, unknown> | undefined;
  const result: Record<string, string | number> = {};
  for (const key of ['requestId', 'phase', 'method', 'endpoint', 'retryAfter', 'remoteCode', 'transportCode', 'serverRequestId', 'workspaceId', 'threadId',
    'table', 'recordId', 'blobId', 'reason'] as const) {
    const value = source?.[key];
    if (typeof value === 'string' && /^[A-Za-z0-9_:.\/-]{1,256}$/.test(value)) result[key] = value;
  }
  for (const key of ['status', 'expectedSize', 'actualSize', 'storedSize', 'workspaceCount'] as const) {
    const value = source?.[key];
    if (Number.isSafeInteger(value)) result[key] = value as number;
  }
  return result;
}

/** 只接受宿主固定参数；页面不能通过 Worker 协议指定任意来源路径。 */
export function parseLegacyClientMigrationRequest(value: unknown): LegacyClientMigrationRequest {
  const input = value as Partial<LegacyClientMigrationRequest> | null;
  if (!input || !['discover', 'migrate', 'defer'].includes(String(input.action))
    || typeof input.dataDir !== 'string' || !input.dataDir.trim()
    || typeof input.targetClientId !== 'string' || !input.targetClientId.startsWith('local_') || !uuid(input.targetClientId.slice(6))
    || typeof input.targetDeviceId !== 'string' || !uuid(input.targetDeviceId)
    || input.candidateId !== undefined && (typeof input.candidateId !== 'string' || !/^[0-9a-f]{64}$/.test(input.candidateId))
    || input.migrationId !== undefined && (typeof input.migrationId !== 'string' || !uuid(input.migrationId))
    || input.action === 'migrate' && (!input.candidateId || !input.migrationId)
    || input.action === 'defer' && !input.migrationId) {
    throw Object.assign(new Error('迁移参数无效'), { code: 'MIGRATION_REQUEST_INVALID' });
  }
  return input as LegacyClientMigrationRequest;
}

/** 迁移与设备身份仅采用规范 UUIDv4。 */
function uuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
