export type LegacyClientMigrationRequest = {
  action: 'discover' | 'migrate' | 'defer';
  dataDir: string;
  targetClientId: string;
  targetDeviceId: string;
  candidateId?: string;
  migrationId?: string;
};

export type LegacyClientMigrationProgress = { stage: string; completed: number; total: number | null; workspaceCount?: number };
export type LegacyClientMigrationResult = {
  candidateId: string | null;
  workspaceCount: number;
  migrationId?: string;
  completed?: boolean;
  resume?: boolean;
  canDefer?: boolean;
  deferred?: boolean;
  accountSource?: { sourceClientId: string; apiKey: string; serverWs: string };
};
export type LegacyClientMigrationMessage =
  | { type: 'progress'; progress: LegacyClientMigrationProgress }
  | { type: 'result'; result: LegacyClientMigrationResult }
  | { type: 'error'; error: { code: string; message: string } };

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
