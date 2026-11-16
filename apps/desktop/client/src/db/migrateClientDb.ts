import type { SqliteDb } from "./sqliteTypes.js";
import { createChatWorkflowTables } from "./chatWorkflowSchema.js";
import {
  ENGINE_MODEL_PROVIDERS,
  createDefaultRoleExecutionCustomConfig,
  normalizeRoleExecutionConfig,
  resolveThreadPrefsWithCatalogDefaults,
} from "@codeflowai/shared";
import {
  ORCH_INSTANCE_SUMMARY_PROJECTION_VERSION,
  OrchInstanceSummaryProjectionReader,
  parseOrchInstanceSummarySourceRow,
  upsertOrchInstanceSummaryProjection,
} from "./orchInstanceSummaryProjection.js";
import { validateOrchIntakeListProjectionIntegrity } from "./orchIntakeListSnapshot.js";
import { OrchIntakeListStateRepo } from "./repos/orchIntakeListStateRepo.js";
import { CLIENT_DB_SCHEMA_VERSION } from "./clientDbSchemaVersion.js";
import { createConversationPresentationTables } from "./conversationPresentation.js";

export { CLIENT_DB_SCHEMA_VERSION };
const WORKSPACE_DB_APPLICATION_ID = 0x43465753;
const ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME = "idx_orch_instances_workspace_intake_display";
const NON_TRANSACTIONAL_CLIENT_DB_MIGRATIONS = new Set([16, 18, 20, 21, 23, 28]);
const ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_SQL = `CREATE INDEX ${ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME}
  ON orch_instances(
    workspace_id,
    json_extract(intake_snapshot_json, '$.id'),
    CASE
      WHEN status IN ('pending', 'running', 'paused', 'waiting-start', 'waiting-approval', 'waiting-feedback') THEN 0
      ELSE 1
    END,
    updated_at DESC,
    id DESC,
    status
  )`;

/**
 * 迁移 Client SQLite：
 * - 使用 `PRAGMA user_version` 记录 schema 版本
 * - 应用库高于支持版本时，在持久 pragma 和结构修复前拒绝
 * - 所有表均为本地使用（不与服务端数据库规范绑定）
 */
export function migrateClientDb(db: SqliteDb, options?: { scope: "application" | "workspace" }): void {
  const kind = Number(db.pragma("application_id", { simple: true }));
  const current = Number(db.pragma("user_version", { simple: true }) ?? 0);
  if (options?.scope === "workspace") {
    migrateWorkspaceProfileDb(db, kind, current);
    return;
  }
  if (kind !== 0) throw new Error("CLIENT_DB_KIND_MISMATCH");
  if (!Number.isInteger(current) || current < 0) {
    throw new Error(`不支持的 schemaVersion：${current}（期望 0..${CLIENT_DB_SCHEMA_VERSION}）`);
  }
  if (current > CLIENT_DB_SCHEMA_VERSION) {
    throw Object.assign(new Error(`应用数据库版本 ${current} 高于当前支持版本 ${CLIENT_DB_SCHEMA_VERSION}，请升级 Client 后重试`), {
      code: "CLIENT_DB_SCHEMA_VERSION_UNSUPPORTED", actualVersion: current, supportedVersion: CLIENT_DB_SCHEMA_VERSION,
    });
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  if (current === CLIENT_DB_SCHEMA_VERSION) {
    repairKnownSchemaDrift(db);
    return;
  }

  const migrations: Array<readonly [number, (database: SqliteDb) => void]> = [
    [1, applyV1], [2, applyV2], [3, applyV3], [4, applyV4], [5, applyV5], [6, applyV6],
    [7, applyV7], [8, applyV8], [10, applyV10], [11, applyV11], [12, applyV12],
    [16, applyV16], [17, applyV17], [18, applyV18], [19, applyV19], [20, applyV20], [21, applyV21],
    [22, applyV22], [23, applyV23], [25, applyV25], [26, applyV26], [27, applyV27],
    [28, applyV28], [29, applyV29], [30, applyV30], [31, applyV31], [32, applyV32], [33, applyV33],
    [34, applyV34], [35, applyV35], [36, applyV36], [37, applyV37], [38, applyV38], [39, applyV39],
    [40, applyV40], [41, applyV41], [42, applyV42], [43, applyV43], [44, applyV44], [45, applyV45],
    [46, applyV46], [47, applyV47], [48, applyV48], [49, applyV49], [50, applyV50], [51, applyV51],
    [52, applyV52], [53, applyV53], [54, applyV54], [55, applyV55], [56, applyV56], [57, applyV57],
    [58, applyV58], [59, applyV59], [60, applyV60], [61, applyV61], [62, applyV62], [63, applyV63],
    [64, applyV64], [65, applyV65], [66, applyV66], [67, applyV67], [68, applyV68], [69, applyV69],
    [72, applyV72],
    [76, applyV76], [77, applyV77], [78, applyV78], [79, applyV79], [80, applyV80], [81, applyV81],
    [82, applyV82], [83, applyV83], [84, applyV84], [84, createChatWorkflowTables],
    [85, createWorkflowExecutionDefaultTables], [86, applyV86], [87, applyV87], [88, applyV88], [89, applyV89], [90, applyV90], [91, applyV91], [92, applyV92], [93, applyV93], [94, applyV94], [95, applyV95], [96, applyV96], [97, applyV97], [98, applyV98], [99, applyV99], [100, applyV100], [101, applyV101], [102, applyV102], [103, applyV103],
  ];
  applyClientDbMigrations(db, migrations.filter(([version]) => current < version));
  repairKnownSchemaDrift(db);
}

/** 在业务 writer 事务外固定 FULL，并拒绝未生效的连接配置。 */
function ensureWriterFullSynchronous(db: SqliteDb): void {
  db.pragma("synchronous = FULL");
  const actual = db.pragma("synchronous", { simple: true });
  if (actual !== 2) {
    throw Object.assign(new Error(`SQLite writer synchronous 未生效：${String(actual)}`), {
      code: "CLIENT_DB_SYNCHRONOUS_MODE_INVALID",
      actual,
    });
  }
}

/** 工作区先验结构后原子升级；新库仅建 Profile、偏好及三类本机定时事实。 */
function migrateWorkspaceProfileDb(db: SqliteDb, kind: number, current: number): void {
  const empty = db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get() === undefined;
  const initializing = kind === 0 && current === 0 && empty;
  if (!initializing) assertWorkspaceDbReadOnlySchema(db);
  ensureWriterFullSynchronous(db);
  if (String(db.pragma("journal_mode = DELETE", { simple: true })).toLowerCase() !== "delete") throw new Error("WORKSPACE_DB_JOURNAL_MODE_INVALID");
  if (String(db.pragma("journal_mode", { simple: true })).toLowerCase() !== "delete") throw new Error("WORKSPACE_DB_JOURNAL_MODE_INVALID");
  db.pragma("foreign_keys = ON");
  if (initializing || current < CLIENT_DB_SCHEMA_VERSION) db.transaction(() => {
    if (initializing) {
      createWorkspaceExecutionProfileTables(db);
      db.pragma(`application_id = ${WORKSPACE_DB_APPLICATION_ID}`);
    }
    if (initializing || current === 93) db.exec(`CREATE TABLE workspace_prefs (
      workspace_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      work_mode TEXT NOT NULL DEFAULT 'general',
      updated_at INTEGER NOT NULL,
      context_window INTEGER NULL,
      auto_compact_pct INTEGER NULL,
      PRIMARY KEY (workspace_id, engine)
    )`);
    if (initializing || current < 96) {
      applyV91(db); applyV92(db); ensureScheduledTaskMigrationQueueColumns(db); ensureScheduledTaskWorkflowInstanceColumn(db);
    }
    if (initializing || current < 97) applyV97(db);
    if (initializing || current < 98) applyV98(db);
    if (initializing || current < 99) applyV99(db);
    if (initializing || current < 100) applyV100(db);
    if (initializing || current < 101) applyV101(db);
    db.pragma(`user_version = ${CLIENT_DB_SCHEMA_VERSION}`);
  })();
}

const WORKSPACE_CORE_SCHEMA_VERSION = 1;
export const WORKSPACE_CORE_TABLES = `threads thread_turns turn_file_changes conversation_events raw_engine_events
  conversation_diff_snapshots conversation_message_deletions knowledge_conversations thread_drafts
  thread_draft_attachments thread_message_queue thread_message_queue_attachments thread_queue_states
  thread_reminder_states thread_rollbacks thread_state_bindings file_blobs thread_groups reminder_receipts
  reminder_ignores dingtalk_reminder_notifications wecom_reminder_notifications meta
  orch_requirement_analysis_sessions orch_requirement_analysis_messages orch_requirement_candidate_drafts
  orch_requirement_analysis_search_fts orch_list_status_count_cache chat_workflow_tasks chat_workflow_actions
  chat_workflow_settings orch_intakes orch_proposals orch_intake_list_states orch_intake_search_fts
  orch_instances orch_instance_summaries orch_artifacts orch_artifact_files orch_artifact_fields orch_events
  orch_feedback_records orch_gate_evaluation_runs orch_prompt_snapshots orch_node_context_resolutions
  orch_node_attempts orch_node_work_item_boards orch_node_work_items orch_node_work_item_events
  code_attribution_outbox code_attribution_retention_tasks orch_asset_generation_jobs orch_asset_job_events
  orch_asset_drafts orch_asset_versions orch_roles orch_workflows orch_knowledge_bundles orch_toolsets
  orch_skills orch_skill_files orch_asset_groups orch_asset_group_assignments`.trim().split(/\s+/);

export const WORKSPACE_ADDITIONAL_TABLES = ["terminal_configs", "orch_assignee_templates",
  "orch_workflow_execution_defaults", "controlled_experiment_snapshots", "controlled_experiment_runs"] as const;

/** 幂等补齐其他工作区运行数据；保持原表职责和本地 FK。 */
export function ensureWorkspaceAdditionalTables(db: SqliteDb): void {
  const marker = db.prepare("SELECT value FROM meta WHERE key = 'workspace_additional_schema_version'").get() as { value: string } | undefined;
  if (marker && marker.value !== "1") throw new Error("WORKSPACE_ADDITIONAL_SCHEMA_VERSION_UNSUPPORTED");
  if (!marker) db.transaction(() => {
    applyV6(db);
    createOrchestrationAssigneeTemplateTables(db);
    createWorkflowExecutionDefaultTables(db);
    createControlledExperimentTables(db);
    db.prepare("INSERT INTO meta(key, value) VALUES ('workspace_additional_schema_version', '1')").run();
  })();
  for (const table of WORKSPACE_ADDITIONAL_TABLES) {
    if (!tableExists(db, table)) throw new Error(`WORKSPACE_ADDITIONAL_SCHEMA_INVALID:${table}`);
  }
}

/** 原子初始化完整工作区执行闭包；无旧数据迁移，旧半套核心表写前拒绝。 */
export function ensureWorkspaceCoreQueueTables(db: SqliteDb): void {
  assertWorkspaceDbReadOnlySchema(db);
  const version = tableExists(db, "meta")
    ? (db.prepare("SELECT value FROM meta WHERE key = 'workspace_core_schema_version'").get() as { value: string } | undefined)?.value
    : undefined;
  if (version !== undefined) {
    if (version !== String(WORKSPACE_CORE_SCHEMA_VERSION)) throw new Error("WORKSPACE_CORE_SCHEMA_VERSION_UNSUPPORTED");
    assertWorkspaceCoreQueueSchema(db);
    createConversationPresentationTables(db);
    return;
  }
  const existing = WORKSPACE_CORE_TABLES.find(table => tableExists(db, table));
  if (existing) throw new Error(`WORKSPACE_CORE_SCHEMA_INVALID:${existing}`);
  db.transaction(() => {
    createWorkspaceCoreTables(db);
    createConversationPresentationTables(db);
    assertWorkspaceCoreQueueSchema(db);
    db.prepare("INSERT INTO meta(key, value) VALUES ('workspace_core_schema_version', ?)").run(String(WORKSPACE_CORE_SCHEMA_VERSION));
  })();
}

/** 复用当前建表和补列函数，不引入注册权威、应用配置或兼容废表。 */
function createWorkspaceCoreTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      title TEXT NOT NULL,
      session_id TEXT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_threads_workspace_updated
      ON threads(workspace_id, archived, updated_at DESC);
  `);
  applyV2(db);
  applyV3(db);
  applyV4(db);
  applyV5(db);
  applyV7(db);
  applyV10(db);
  createOrchestrationTables(db);
  createOrchestrationAssetTables(db);
  applyV25(db);
  applyV26(db);
  applyV27(db);
  applyV31(db);
  applyV32(db);
  applyV33(db);
  applyV35(db);
  applyV36(db);
  applyV37(db);
  applyV38(db);
  applyV39(db);
  applyV40(db);
  applyV42(db);
  applyV43(db);
  applyV45(db);
  applyV46(db);
  applyV49(db);
  applyV50(db);
  applyV52(db);
  applyV53(db);
  applyV55(db);
  applyV56(db);
  applyV58(db);
  applyV59(db);
  applyV60(db);
  applyV61(db);
  applyV62(db);
  applyV63(db);
  applyV64(db);
  applyV65(db);
  applyV66(db);
  applyV68(db);
  applyV69(db);
  applyV72(db);
  applyV76(db);
  applyV79(db);
  createOrchInstanceSummaryTable(db);
  applyV81(db);
  applyV82(db);
  applyV84(db);
  applyV86(db);
  applyV87(db);
  applyV88(db);
  applyV89(db);
  createChatWorkflowTables(db);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_orch_gate_evaluation_runs_idempotency
    ON orch_gate_evaluation_runs(node_attempt_id, artifact_id, criteria_hash, artifact_hash);`);
}

/** 保留每个本地父子 FK，工作区注册由应用库检查，不能创建跨库 FK。 */
function applicationWorkspaceForeignKey(db: SqliteDb): string {
  return Number(db.pragma("application_id", { simple: true })) === WORKSPACE_DB_APPLICATION_ID
    ? ""
    : ",\n      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE";
}

/** 已标版本的核心库必须具备完整表集，拒绝缺表和跨物理域父引用。 */
function assertWorkspaceCoreQueueSchema(db: SqliteDb): void {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map(row => row.name));
  for (const table of WORKSPACE_CORE_TABLES) {
    if (!tables.has(table)) throw new Error(`WORKSPACE_CORE_SCHEMA_INVALID:${table}`);
    const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>;
    if (keys.some(key => key.table === "workspaces" || !tables.has(key.table))) {
      throw new Error(`WORKSPACE_CORE_SCHEMA_INVALID:${table}`);
    }
  }
}

/** 只读核 v93 至当前版本及对应结构；旧版缺账号配置能力不触发升级或修复。 */
export function assertWorkspaceDbReadOnlySchema(db: SqliteDb): { applicationId: number; schemaVersion: number } {
  const kind = Number(db.pragma("application_id", { simple: true }));
  const current = Number(db.pragma("user_version", { simple: true }));
  if (kind !== WORKSPACE_DB_APPLICATION_ID || !Number.isInteger(current) || current < 93 || current > CLIENT_DB_SCHEMA_VERSION) {
    throw new Error("WORKSPACE_DB_KIND_OR_VERSION_UNSUPPORTED");
  }
  {
    // 当前版本的表、列及主键先验，避免把错库/损坏库变更 journal 后才失败。
    const table = db.prepare("SELECT type FROM sqlite_master WHERE name = 'workspace_execution_profiles'").get() as { type: string } | undefined;
    const columns = db.prepare("PRAGMA table_info(workspace_execution_profiles)").all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const names = ["scope_type", "scope_id", "user_id", "profile_text", "profile_hash", "created_at", "updated_at"];
    if (table?.type !== "table" || columns.length !== names.length || columns.some((column, index) =>
      column.name !== names[index] || column.type !== (index < 5 ? "TEXT" : "INTEGER")
      || column.notnull !== 1 || column.pk !== (index < 3 ? index + 1 : 0))) throw new Error("WORKSPACE_DB_SCHEMA_INVALID");
    if (current >= 94) {
      const prefsTable = db.prepare("SELECT type FROM sqlite_master WHERE name = 'workspace_prefs'").get() as { type: string } | undefined;
      const prefsColumns = db.prepare("PRAGMA table_info(workspace_prefs)").all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
      const prefsNames = ["workspace_id", "engine", "work_mode", "updated_at", "context_window", "auto_compact_pct"];
      if (prefsTable?.type !== "table" || prefsColumns.length !== prefsNames.length || prefsColumns.some((column, index) =>
        column.name !== prefsNames[index] || column.type !== (index < 3 ? "TEXT" : "INTEGER")
        || column.notnull !== (index < 4 ? 1 : 0) || column.pk !== (index < 2 ? index + 1 : 0))
        || db.prepare("PRAGMA foreign_key_list(workspace_prefs)").all().length !== 0) throw new Error("WORKSPACE_DB_SCHEMA_INVALID");
    } else if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'workspace_prefs'").get()) {
      throw new Error("WORKSPACE_DB_SCHEMA_INVALID");
    }
  }
  const taskTables = ["scheduled_task_configs", "scheduled_task_runs", "scheduled_task_runtime_states"];
  if (current >= 96) {
    const expectedColumns = [
      ["id", "source", "client_id", "device_id", "workspace_scope_type", "workspace_scope_id", "name", "description", "task_type", "cron_expr", "timezone", "enabled", "payload_json", "concurrency_policy", "missed_policy", "timeout_ms", "revision", "deleted_at", "created_at", "updated_at"],
      ["id", "task_id", "client_id", "device_id", "workspace_id", "workflow_instance_id", "workflow_name_snapshot", "workflow_version", "scheduled_at", "started_at", "finished_at", "status", "trigger_source", "attempt", "duration_ms", "summary", "error_message", "output_excerpt", "created_at", "source", "config_revision", "task_name_snapshot"],
      ["task_id", "client_id", "device_id", "last_scheduled_at", "last_started_at", "running_run_id", "last_workflow_instance_id", "last_config_sync_at", "updated_at", "queued_scheduled_at", "queued_reason", "queued_operation_id"],
    ];
    const integerColumns = [new Set(["enabled","timeout_ms","revision","deleted_at","created_at","updated_at"]),
      new Set(["workflow_version","scheduled_at","started_at","finished_at","attempt","duration_ms","created_at","config_revision"]),
      new Set(["last_scheduled_at","last_started_at","last_config_sync_at","updated_at","queued_scheduled_at"])];
    if (current >= 97) {
      expectedColumns[2]!.push("last_workflow_sequence");
      integerColumns[2]!.add("last_workflow_sequence");
    }
    if (current >= 98) {
      expectedColumns[1]!.push("server_origin", "owner_user_id", "report_settlement", "report_settled_at");
      integerColumns[1]!.add("report_settled_at");
    }
    const requiredColumns = [new Set(expectedColumns[0]!.filter(name=>!["id","workspace_scope_type","workspace_scope_id","description","deleted_at"].includes(name))),
      new Set(["task_id","client_id","device_id","scheduled_at","status","trigger_source","attempt","created_at","source","config_revision","task_name_snapshot"]),
      new Set(["client_id","device_id","updated_at"])];
    if (current >= 98) requiredColumns[1]!.delete("config_revision");
    for (const [index, table] of taskTables.entries()) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number; type: string; notnull: number }>;
      if (columns.length !== expectedColumns[index]!.length || columns.some((column, i) => column.name !== expectedColumns[index]![i]
        || column.pk !== (i === 0 ? 1 : 0) || column.type !== (integerColumns[index]!.has(column.name)?"INTEGER":"TEXT")
        || column.notnull !== (requiredColumns[index]!.has(column.name)?1:0))
        || (db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(table) as {type?:string}|undefined)?.type !== "table"
        || db.prepare(`PRAGMA foreign_key_list(${table})`).all().length !== 0) throw new Error("WORKSPACE_DB_SCHEMA_INVALID");
    }
    for (const [name, columns] of [
      ["idx_scheduled_task_configs_device", ["client_id", "device_id", "updated_at", "id"]],
      ["idx_scheduled_task_runs_history", ["task_id", "created_at", "id"]],
      ["idx_scheduled_task_runs_device", ["client_id", "device_id", "created_at", "id"]],
      ["idx_scheduled_task_runtime_states_device", ["client_id", "device_id", "updated_at"]],
    ] as const) {
      const actual = db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>;
      if (actual.length !== columns.length || actual.some((column, i) => column.name !== columns[i])) throw new Error("WORKSPACE_DB_SCHEMA_INVALID");
    }
  } else if (taskTables.some(table => db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table))) throw new Error("WORKSPACE_DB_SCHEMA_INVALID");
  if (current >= 99) {
    const names = ["server_origin", "owner_user_id", "client_id", "device_id", "task_id", "workspace_id", "snapshot_json", "local_revision"];
    if (current >= 100) names.push("pending_json", "stop_intent", "server_present");
    const columns = db.prepare("PRAGMA table_info(scheduled_task_account_configs)").all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    if ((db.prepare("SELECT type FROM sqlite_master WHERE name='scheduled_task_account_configs'").get() as { type?: string } | undefined)?.type !== "table"
      || columns.length !== names.length || columns.some((column, i) => column.name !== names[i]
        || column.type !== (i === 7 || i === 10 ? "INTEGER" : "TEXT") || column.notnull !== (i === 5 || i === 9 ? 0 : 1) || column.pk !== (i < 5 ? i + 1 : 0))
      || db.prepare("PRAGMA foreign_key_list(scheduled_task_account_configs)").all().length !== 0) throw new Error("WORKSPACE_DB_SCHEMA_INVALID");
    const indexes = db.prepare("PRAGMA index_list(scheduled_task_account_configs)").all() as Array<{ name: string; origin: string; unique: number; partial: number }>;
    const primary = indexes.find(index => index.origin === "pk");
    if (!primary || primary.unique !== 1 || primary.partial !== 0) throw new Error("WORKSPACE_DB_SCHEMA_INVALID");
    const indexed = db.prepare("SELECT name FROM pragma_index_info(?)").all(primary.name) as Array<{ name: string }>;
    if (indexed.length !== 5 || indexed.some((column, i) => column.name !== names[i])) throw new Error("WORKSPACE_DB_SCHEMA_INVALID");
  } else if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='scheduled_task_account_configs'").get()) throw new Error("WORKSPACE_DB_SCHEMA_INVALID");
  return { applicationId: kind, schemaVersion: current };
}

/** v101：物理删除已下线笔记功能遗留的工作区表与索引。 */
function applyV101(db: SqliteDb): void {
  db.exec("DROP INDEX IF EXISTS idx_notes_workspace; DROP TABLE IF EXISTS notes;");
}

/** v102：本机常用提示词和模型偏好只归应用库，不随账号及工作区变化。 */
function applyV102(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE local_model_context_preferences (
      engine TEXT NOT NULL,
      model_id TEXT NOT NULL,
      context_window INTEGER NOT NULL,
      max_context_window INTEGER,
      PRIMARY KEY(engine, model_id)
    );
    CREATE TABLE local_quick_phrase_collection (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
    );
    INSERT INTO local_quick_phrase_collection(id, revision) VALUES (1, 0);
    CREATE TABLE local_quick_phrases (
      id TEXT PRIMARY KEY,
      create_request_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
      version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_local_quick_phrases_order ON local_quick_phrases(sort_order, id);
  `);
}

/** v103：迁移后的纯本地自配 Key 补确认来源；服务端引用与历史内置中转仍保留未知并要求重新认证。 */
function applyV103(db: SqliteDb): void {
  db.prepare(`UPDATE engine_keys SET source = 'user_configured'
    WHERE source = 'unknown' AND secret_ref IS NULL AND server_origin IS NULL AND owner_user_id IS NULL
      AND server_key_id IS NULL AND trim(api_key) <> ''
      AND label NOT LIKE 'CodeFlow 内置中转%'`).run();
}

/** v99：账号快照按完整owner隔离，固定物理工作区且水位不借用配置CAS。 */
function applyV99(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scheduled_task_account_configs (
    server_origin TEXT NOT NULL CHECK(length(trim(server_origin)) > 0),
    owner_user_id TEXT NOT NULL CHECK(length(trim(owner_user_id)) > 0),
    client_id TEXT NOT NULL CHECK(length(trim(client_id)) > 0),
    device_id TEXT NOT NULL CHECK(length(trim(device_id)) > 0),
    task_id TEXT NOT NULL CHECK(length(trim(task_id)) > 0),
    workspace_id TEXT NULL CHECK(workspace_id IS NULL OR length(trim(workspace_id)) > 0),
    snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
    local_revision INTEGER NOT NULL CHECK(typeof(local_revision)='integer' AND local_revision BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(server_origin,owner_user_id,client_id,device_id,task_id)
  )`);
}

/** v100：在原账号行保存待同步修订、独立停删意图和完整同步的存在观察。 */
function applyV100(db: SqliteDb): void {
  ensureColumn(db, "scheduled_task_account_configs", "pending_json", "TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(pending_json))");
  ensureColumn(db, "scheduled_task_account_configs", "stop_intent", "TEXT NULL CHECK(stop_intent IN ('disabled','deleted'))");
  ensureColumn(db, "scheduled_task_account_configs", "server_present", "INTEGER NOT NULL DEFAULT 1 CHECK(server_present IN (0,1))");
}

/** v95：在原 operation 登记可空数据库交接证据，旧 null 保持完整静态清单。 */
function applyV95(db: SqliteDb): void {
  ensureColumn(db, "workspace_directory_migrations", "workspace_db_snapshot_json", "TEXT NULL CHECK (workspace_db_snapshot_json IS NULL OR json_valid(workspace_db_snapshot_json))");
}

/** v96：应用三表不变，工作区三表由原 scope 迁移创建，reader 同步推进。 */
function applyV96(_db: SqliteDb): void {}

/** v97：账号上一流程指针使用同表顺序元数据，工作区历史保持原本机列。 */
function applyV97(db: SqliteDb): void {
  ensureColumn(db, "scheduled_task_runtime_states", "last_workflow_sequence", `INTEGER NULL CHECK (
    last_workflow_sequence IS NULL OR (typeof(last_workflow_sequence) = 'integer'
      AND last_workflow_sequence BETWEEN 1 AND 9007199254740991
      AND task_id GLOB '__account_scheduled_task__:*' AND last_workflow_instance_id IS NOT NULL))`);
}

/** v98：仅扩工作区原运行表的账号列；应用已具备列，不重建或导入旧工作区行。 */
function applyV98(db: SqliteDb): void {
  const columns = db.prepare("PRAGMA table_info(scheduled_task_runs)").all() as Array<{ name: string }>;
  if (columns.some(column => column.name === "server_origin")) return;
  db.exec(`ALTER TABLE scheduled_task_runs RENAME TO scheduled_task_runs_v97;
    DROP INDEX idx_scheduled_task_runs_history; DROP INDEX idx_scheduled_task_runs_device;
    CREATE TABLE scheduled_task_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, client_id TEXT NOT NULL, device_id TEXT NOT NULL,
      workspace_id TEXT NULL, workflow_instance_id TEXT NULL, workflow_name_snapshot TEXT NULL, workflow_version INTEGER NULL,
      scheduled_at INTEGER NOT NULL, started_at INTEGER NULL, finished_at INTEGER NULL,
      status TEXT NOT NULL CHECK(status IN ('running','success','failed','skipped','timeout')),
      trigger_source TEXT NOT NULL CHECK(trigger_source IN ('schedule','manual')), attempt INTEGER NOT NULL CHECK(attempt > 0),
      duration_ms INTEGER NULL, summary TEXT NULL, error_message TEXT NULL, output_excerpt TEXT NULL, created_at INTEGER NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('local','account')), config_revision INTEGER NULL, task_name_snapshot TEXT NOT NULL,
      server_origin TEXT NULL, owner_user_id TEXT NULL, report_settlement TEXT NULL, report_settled_at INTEGER NULL,
      CHECK((source='local' AND config_revision > 0 AND config_revision IS NOT NULL AND server_origin IS NULL
        AND owner_user_id IS NULL AND report_settlement IS NULL AND report_settled_at IS NULL)
        OR (source='account' AND config_revision IS NULL AND workspace_id IS NOT NULL AND length(trim(workspace_id)) > 0
          AND workflow_instance_id IS NULL AND workflow_name_snapshot IS NULL AND workflow_version IS NULL
          AND server_origin IS NOT NULL AND length(trim(server_origin)) > 0 AND owner_user_id IS NOT NULL AND length(trim(owner_user_id)) > 0)),
      CHECK((report_settlement IS NULL AND report_settled_at IS NULL) OR
        (source='account' AND report_settlement IN ('acknowledged','task_deleted') AND report_settlement IS NOT NULL
          AND typeof(report_settled_at)='integer' AND report_settled_at BETWEEN 0 AND 9007199254740991
          AND (report_settlement='task_deleted' OR status <> 'running')))
    );
    INSERT INTO scheduled_task_runs SELECT *, NULL, NULL, NULL, NULL FROM scheduled_task_runs_v97;
    DROP TABLE scheduled_task_runs_v97;
    CREATE INDEX idx_scheduled_task_runs_history ON scheduled_task_runs(task_id, created_at DESC, id DESC);
    CREATE INDEX idx_scheduled_task_runs_device ON scheduled_task_runs(client_id, device_id, created_at DESC, id DESC);`);
}

/** v94：应用表保持原状，仅由原迁移批次推进 writer/reader 版本。 */
function applyV94(_db: SqliteDb): void {}

/** 按外键切换边界拆分原子迁移批次，并及时记录已完成的安全检查点。 */
function applyClientDbMigrations(
  db: SqliteDb,
  migrations: Array<readonly [number, (database: SqliteDb) => void]>,
): void {
  let transactionalBatch: Array<readonly [number, (database: SqliteDb) => void]> = [];
  const flushTransactionalBatch = () => {
    if (transactionalBatch.length === 0) return;
    applyClientDbMigrationBatch(db, transactionalBatch);
    transactionalBatch = [];
  };

  for (const migration of migrations) {
    const [version, apply] = migration;
    if (!NON_TRANSACTIONAL_CLIENT_DB_MIGRATIONS.has(version)) {
      transactionalBatch.push(migration);
      continue;
    }
    flushTransactionalBatch();
    apply(db);
    db.pragma(`user_version = ${version}`);
  }
  flushTransactionalBatch();
}

/** 原子执行连续迁移批次，任一步失败时恢复到批次前的版本与 schema。 */
function applyClientDbMigrationBatch(
  db: SqliteDb,
  migrations: Array<readonly [number, (database: SqliteDb) => void]>,
): void {
  db.transaction(() => {
    for (const [version, apply] of migrations) {
      apply(db);
      db.pragma(`user_version = ${version}`);
    }
  })();
}

/** 既有 schema owner 幂等补齐当前结构，含可重建会话展示索引。 */
function repairKnownSchemaDrift(db: SqliteDb): void {
  createConversationPresentationTables(db);
  applyV99(db);
  applyV100(db);
  applyV101(db);
  // v84 在两个分支分别引入了知识会话和聊天工作流；合并后必须对两种历史 v84 数据库都幂等补齐。
  applyV84(db);
  createChatWorkflowTables(db);
  createWorkflowExecutionDefaultTables(db);
  ensureWorkspaceSoftDeleteColumn(db);
  ensureColumn(db, "threads", "auto_compact_pct", "INTEGER NULL");
  ensureColumn(db, "threads", "context_window", "INTEGER NULL");
  ensureColumn(db, "threads", "service_tier", "TEXT NULL");
  ensureColumn(db, "threads", "role_id", "TEXT NULL");
  ensureColumn(db, "threads", "knowledge_enabled", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "threads", "session_capabilities_json", "TEXT NULL");
  ensureSharedThreadAclColumns(db);
  ensureThreadPinnedSchema(db);
  ensureThreadListActivitySortIndex(db);
  ensureThreadCleanupIndex(db);
  ensureColumn(db, "orch_asset_generation_jobs", "request_json", "TEXT NULL");
  ensureColumn(db, "orch_asset_generation_jobs", "interaction_json", "TEXT NULL");
  ensureOrchInstanceAssetRuntimeSnapshotColumn(db);
  ensureThreadTurnRunningIndex(db);
  createReminderIgnoreTable(db);
  createOrchestrationRuntimeExtensionTables(db);
  ensurePromptSnapshotEnvelopeColumn(db);
  ensurePromptSnapshotPurposeColumn(db);
  ensureColumn(db, "orch_gate_evaluation_runs", "criteria_hash", "TEXT NULL");
  ensureColumn(db, "orch_gate_evaluation_runs", "artifact_hash", "TEXT NULL");
  ensureColumn(db, "orch_gate_evaluation_runs", "retry_ordinal", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "orch_gate_evaluation_runs", "prompt_snapshot_id", "TEXT NULL");
  ensureColumn(db, "orch_gate_evaluation_runs", "results_json", "TEXT NULL");
  ensureColumn(db, "orch_gate_evaluation_runs", "started_at", "INTEGER NULL");
  ensureColumn(db, "orch_gate_evaluation_runs", "finished_at", "INTEGER NULL");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_orch_gate_evaluation_runs_idempotency
    ON orch_gate_evaluation_runs(node_attempt_id, artifact_id, criteria_hash, artifact_hash);`);
  createThreadDraftTables(db);
  createThreadMessageQueueTables(db);
  ensureFileBlobReferenceIndexes(db);
  ensureThreadDraftPathReferencesColumn(db);
  ensureThreadMessageQueuePathReferencesColumn(db);
  ensureThreadInputContractColumns(db);
  ensureThreadMessageQueueClientItemIdColumn(db);
  ensureEngineKeyProviderSchema(db);
  createDingTalkReminderNotificationTable(db);
  createWeComReminderNotificationTable(db);
  createOrchestrationAssigneeTemplateTables(db);
  createWorkspaceExecutionProfileTables(db);
  createEngineCustomModelTables(db);
  createScheduledTaskRuntimeStateTable(db);
  ensureScheduledTaskWorkflowInstanceColumn(db);
  ensureScheduledTaskMigrationQueueColumns(db);
  createWorkspaceDirectoryMigrationTable(db);
  createOrchSkillsTable(db);
  createOrchIntakeListStateTable(db);
  createOrchestrationListSearchTables(db);
  ensureOrchInstanceIntakeDisplayIndex(db);
  createOrchInstanceSummaryTable(db);
  validateOrchInstanceSummaryProjection(db);
  validateOrchIntakeListProjectionIntegrity(db);
  createThreadGroupTables(db);
  createOrchAssetGroupTables(db);
  createOrchNodeAttemptTables(db);
  createOrchNodeWorkItemTables(db);
  ensureOrchNodeWorkItemCompletionColumns(db);
  createControlledExperimentTables(db);
  createConversationDiffSnapshotTable(db);
  ensureThreadDeletionReferenceIndexes(db);
  createCodeAttributionOutboxTable(db);
  createCodeAttributionRetentionTaskTable(db);
  ensureRawEngineEventRuntimeIndexes(db);
  applyV89(db);
  const hadEngineKeySource = (db.prepare("PRAGMA table_info(engine_keys)").all() as Array<{ name?: string | null }>)
    .some(column => column.name === "source");
  applyV90(db);
  // 只有 source 列因漂移重建时才补确认，不能每次打开都覆盖运行期明确的 unknown。
  if (!hadEngineKeySource) applyV103(db);
  applyV91(db);
  createScheduledTaskRunV93Table(db);
}

/** 幂等修复：v40 加的 client_item_id 列与唯一索引（兼容降级再升级路径）。 */
function ensureThreadMessageQueueClientItemIdColumn(db: SqliteDb): void {
  ensureColumn(db, "thread_message_queue", "client_item_id", "TEXT NULL");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uk_thread_message_queue_thread_client_item_id_active
      ON thread_message_queue(thread_id, client_item_id)
      WHERE client_item_id IS NOT NULL AND status IN ('pending','sending');
  `);
}

function applyV1(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    INSERT OR IGNORE INTO meta(key, value) VALUES ('event_seq', '0');

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      path TEXT NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      title TEXT NOT NULL,
      session_id TEXT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_threads_workspace_updated
      ON threads(workspace_id, archived, updated_at DESC);

    CREATE TABLE IF NOT EXISTS conversation_items (
      item_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      data_json TEXT NOT NULL,
      sort_key INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_items_thread_sort
      ON conversation_items(thread_id, sort_key);

    CREATE TABLE IF NOT EXISTS engine_events (
      seq INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      ts INTEGER NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_engine_events_thread_seq
      ON engine_events(thread_id, seq);
  `);
}

function applyV2(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_turns (
      thread_id TEXT NOT NULL,
      turn_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      engine_session_id TEXT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NULL,
      start_event_seq INTEGER NULL,
      end_event_seq INTEGER NULL,
      user_item_id TEXT NULL,
      user_text TEXT NULL,
      engine_checkpoint_json TEXT NULL,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_thread_turns_thread_ended
      ON thread_turns(thread_id, ended_at);

    CREATE TABLE IF NOT EXISTS file_blobs (
      blob_id TEXT PRIMARY KEY,
      byte_len INTEGER NOT NULL,
      encoding TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turn_file_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      path TEXT NOT NULL,
      op TEXT NOT NULL,
      before_blob_id TEXT NULL,
      after_blob_id TEXT NULL,
      before_exists INTEGER NOT NULL,
      after_exists INTEGER NOT NULL,
      diff_text TEXT NULL,
      captured_at INTEGER NOT NULL,
      UNIQUE(thread_id, turn_id, path),
      FOREIGN KEY(turn_id) REFERENCES thread_turns(turn_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_turn_file_changes_thread_turn
      ON turn_file_changes(thread_id, turn_id);

    CREATE INDEX IF NOT EXISTS idx_turn_file_changes_thread_path
      ON turn_file_changes(thread_id, path);

    CREATE TABLE IF NOT EXISTS thread_rollbacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      to_turn_id TEXT NOT NULL,
      dropped_turn_count INTEGER NOT NULL,
      dropped_event_seq_gt INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      result TEXT NOT NULL,
      error TEXT NULL,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_thread_rollbacks_thread_created
      ON thread_rollbacks(thread_id, created_at DESC);
  `);
}

/** v4：幂等补齐步骤键，兼容旧版本中断后从 user_version=0 重放。 */
function applyV4(db: SqliteDb): void {
  ensureColumn(db, "turn_file_changes", "step_key", "TEXT NULL");
}

/** v5：幂等补齐已接受 blob，兼容旧版本中断后的半迁移库。 */
function applyV5(db: SqliteDb): void {
  ensureColumn(db, "turn_file_changes", "accepted_blob_id", "TEXT NULL");
}

function applyV6(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS terminal_configs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      label TEXT NOT NULL,
      shell TEXT NULL,
      cwd TEXT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
      ${applicationWorkspaceForeignKey(db)}
    );

    CREATE INDEX IF NOT EXISTS idx_terminal_configs_workspace
      ON terminal_configs(workspace_id, sort_order);
  `);
}

/** 创建会话状态绑定；应用保注册 FK，工作区只保本地 thread FK。 */
function applyV3(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_state_bindings (
      thread_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      state_rel_path TEXT NOT NULL,
      state_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE${applicationWorkspaceForeignKey(db)}
    );

    CREATE INDEX IF NOT EXISTS idx_tsb_workspace
      ON thread_state_bindings(workspace_id);

    CREATE INDEX IF NOT EXISTS idx_tsb_state_id
      ON thread_state_bindings(workspace_id, state_id);
  `);
}

/** v7：幂等补齐线程执行偏好，并创建工作区偏好表。 */
function applyV7(db: SqliteDb): void {
  ensureColumn(db, "threads", "model", "TEXT NULL");
  ensureColumn(db, "threads", "effort", "TEXT NULL");
  ensureColumn(db, "threads", "access_mode", "TEXT NULL");
  ensureColumn(db, "threads", "plan_mode", "INTEGER NULL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_prefs (
      workspace_id TEXT NOT NULL,
      engine       TEXT NOT NULL,
      work_mode    TEXT NOT NULL DEFAULT 'general',
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, engine),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
  `);
}

function applyV8(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_keys (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      engine TEXT NOT NULL,
      provider_id TEXT NULL,
      api_key TEXT NOT NULL,
      base_url TEXT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_engine_keys_engine_active
      ON engine_keys(engine, is_active DESC);
  `);
}

function applyV41(db: SqliteDb): void {
  ensureEngineKeyProviderSchema(db);
}

function applyV42(db: SqliteDb): void {
  ensureThreadPinnedSchema(db);
}

/** v43：线程级 Codex Fast mode 服务档位。 */
function applyV43(db: SqliteDb): void {
  ensureColumn(db, "threads", "service_tier", "TEXT NULL");
}

/** v44：workspace 默认软删除，避免误删级联清理本地历史数据。 */
function applyV44(db: SqliteDb): void {
  ensureWorkspaceSoftDeleteColumn(db);
}

/** v45：节点结果字段索引、上下文解析快照和文件交付契约列。 */
function applyV45(db: SqliteDb): void {
  createOrchestrationRuntimeExtensionTables(db);
}

/** v46：草稿和运行中队列保存 @ 工作区路径引用。 */
function applyV46(db: SqliteDb): void {
  createThreadDraftTables(db);
  createThreadMessageQueueTables(db);
  ensureThreadDraftPathReferencesColumn(db);
  ensureThreadMessageQueuePathReferencesColumn(db);
}

/** v47：流程模板处理人模板。 */
function applyV47(db: SqliteDb): void {
  createOrchestrationAssigneeTemplateTables(db);
}

/** v48：工作区粒度执行 Profile。 */
function applyV48(db: SqliteDb): void {
  createWorkspaceExecutionProfileTables(db);
}

/** v49：钉钉待办通知发送记录，用于完成通知的幂等与失败排查。 */
function applyV49(db: SqliteDb): void {
  createDingTalkReminderNotificationTable(db);
}

/** v50：企业微信待办通知发送记录，用于完成通知的幂等与失败排查。 */
function applyV50(db: SqliteDb): void {
  createWeComReminderNotificationTable(db);
}

/** v51：Client 级自定义模型目录，用于非标准模型 ID 的元数据维护。 */
function applyV51(db: SqliteDb): void {
  createEngineCustomModelTables(db);
}

/** v52：普通聊天角色选择持久化，只记录角色 ID，不复制角色资产。 */
function applyV52(db: SqliteDb): void {
  ensureColumn(db, "threads", "role_id", "TEXT NULL");
}

/** v53：会话列表最近活动排序索引，支撑 updated_at 游标分页。 */
function applyV53(db: SqliteDb): void {
  ensureThreadListActivitySortIndex(db);
}

/** v54：定时任务本地运行状态，用于去重和运行中保护。 */
function applyV54(db: SqliteDb): void {
  createScheduledTaskRuntimeStateTable(db);
}

/** v55：平台自定义 Skills 作为编排规格资产入库。 */
function applyV55(db: SqliteDb): void {
  createOrchSkillsTable(db);
}

/** v56：Skill 包文件树，支持 SKILL.md、scripts、references 和 assets。 */
function applyV56(db: SqliteDb): void {
  createOrchSkillFilesTable(db);
}

/** v57：定时工作流记录上一轮流程实例，用于自动调度防重叠策略。 */
function applyV57(db: SqliteDb): void {
  ensureScheduledTaskWorkflowInstanceColumn(db);
}

/** v58：共享工作区普通会话 ACL 下沉到 Host 本地 threads 元数据。 */
function applyV58(db: SqliteDb): void {
  ensureSharedThreadAclColumns(db);
}

/** v59：编排入口列表状态缓存，支撑状态筛选、计数和分页。 */
function applyV59(db: SqliteDb): void {
  createOrchIntakeListStateTable(db);
}

/** v60：列表搜索 FTS 与状态计数短缓存，支撑大数据量列表搜索和切换性能。 */
function applyV60(db: SqliteDb): void {
  createOrchestrationListSearchTables(db);
}

/** v61：自建会话分组，支持本地工作区和共享工作区隔离。 */
function applyV61(db: SqliteDb): void {
  createThreadGroupTables(db);
}

/** v62：五类编排资产按类型维护独立分组。 */
function applyV62(db: SqliteDb): void {
  createOrchAssetGroupTables(db);
}

/** v63：节点 Attempt 持久化提交、幂等收尾和同节点执行隔离。 */
function applyV63(db: SqliteDb): void {
  createOrchNodeAttemptTables(db);
}

/** v64：为 file_blobs 的全部引用检查补齐索引，避免 GC 全表扫描。 */
function applyV64(db: SqliteDb): void {
  ensureFileBlobReferenceIndexes(db);
}

/** v65：节点级可恢复工作项看板、工作项和追加审计事件。 */
function applyV65(db: SqliteDb): void {
  createOrchNodeWorkItemTables(db);
}

/** v66：按全 Client 最近活动时间筛选历史清理目标。 */
function applyV66(db: SqliteDb): void {
  ensureThreadCleanupIndex(db);
}

/** 幂等创建历史清理目标索引，不在大事件表或 Prompt 表上启动建索引。 */
function ensureThreadCleanupIndex(db: SqliteDb): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_threads_cleanup_updated_id
      ON threads(updated_at ASC, id ASC);
  `);
}

/** v67：受控实验冻结快照与隔离 Run 本地证据。 */
function applyV67(db: SqliteDb): void {
  createControlledExperimentTables(db);
}

/** v68：aggregate diff 正文按会话项覆盖保存，避免完整快照随事件数线性增长。 */
function applyV68(db: SqliteDb): void {
  createConversationDiffSnapshotTable(db);
}

/** v69：工作项保存逐项验收合同、完成检查和已验证输出哈希。 */
function applyV69(db: SqliteDb): void {
  ensureOrchNodeWorkItemCompletionColumns(db);
}

/** v72：为编排实例保存启动时冻结的完整资产图。 */
function applyV72(db: SqliteDb): void {
  ensureOrchInstanceAssetRuntimeSnapshotColumn(db);
}

/** v76：为会话删除涉及的编排引用查询补齐索引，避免同步全表扫描。 */
function applyV76(db: SqliteDb): void {
  ensureThreadDeletionReferenceIndexes(db);
}

/** 幂等补齐实例启动资产图列，旧实例保持 NULL。 */
function ensureOrchInstanceAssetRuntimeSnapshotColumn(db: SqliteDb): void {
  ensureColumn(db, "orch_instances", "asset_runtime_snapshot_json", "TEXT NULL");
}


/** v77：工作区目录迁移事实源、start fencing 与定时任务延期归属（主干 v71 重编号）。 */
function applyV77(db: SqliteDb): void {
  createWorkspaceDirectoryMigrationTable(db);
  ensureScheduledTaskMigrationQueueColumns(db);
}

/** v78：持久化迁移时排除的 node_modules 目录事实（主干 v72 重编号）。 */
function applyV78(db: SqliteDb): void {
  ensureWorkspaceDirectoryMigrationDependencyExclusionColumns(db);
}

/** v79：按需求定位编排实例时直接命中索引，避免列表投影深检反复扫描整个工作区。 */
function applyV79(db: SqliteDb): void {
  ensureOrchInstanceIntakeDisplayIndex(db);
}

/** v80：将实例列表摘要迁入独立窄表，并一次性重建事务性列表投影。 */
function applyV80(db: SqliteDb): void {
  db.transaction(() => {
    createOrchInstanceSummaryTable(db);
    backfillOrchInstanceSummaries(db);
    rebuildOrchIntakeListProjections(db);
    validateOrchInstanceSummaryProjection(db);
    validateOrchIntakeListProjectionIntegrity(db);
  })();
}

/** v81：持久化脱敏代码归因待同步批次及其租约状态。 */
function applyV81(db: SqliteDb): void {
  createCodeAttributionOutboxTable(db);
}

/** v82：持久化仅在 Client 使用的 7/30 天代码留存观察任务。 */
function applyV82(db: SqliteDb): void {
  createCodeAttributionRetentionTaskTable(db);
}

/** 独立知识会话只保存本机执行归属，知识正文与资产树仍以项目文件为准。 */
function applyV84(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_conversations (
    thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
    node_id TEXT NULL,
    created_by_user_id TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    activation_version INTEGER NOT NULL DEFAULT 1
  );`);
}

/** v86：持久化普通会话的知识库开关，默认关闭。 */
function applyV86(db: SqliteDb): void {
  ensureColumn(db, "threads", "knowledge_enabled", "INTEGER NOT NULL DEFAULT 0");
}

/** v87：为运行证据的轻量时间线和工具事件读取补齐覆盖/部分索引。 */
function applyV87(db: SqliteDb): void {
  ensureRawEngineEventRuntimeIndexes(db);
}

/** v88：消息删除事实独立于分页和回合裁剪，阻止运行中消息被迟到事件重新写回。 */
function applyV88(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_message_deletions (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      deleted_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, item_id)
    );
  `);
}

/** v89：复用原表的幂等修复后追加可空归属列，不回填旧会话。 */
function applyV89(db: SqliteDb): void {
  applyV27(db);
  ensureColumn(db, "orch_requirement_analysis_sessions", "workspace_scope_json", "TEXT NULL");
}

/** v90：仅补凭据来源元数据，历史秘密与可编辑标签均不参与归属推断。 */
function applyV90(db: SqliteDb): void {
  ensureColumn(db, 'engine_keys', 'source', "TEXT NOT NULL DEFAULT 'unknown'");
  ensureColumn(db, 'engine_keys', 'server_origin', 'TEXT NULL');
  ensureColumn(db, 'engine_keys', 'owner_user_id', 'TEXT NULL');
  ensureColumn(db, 'engine_keys', 'server_key_id', 'TEXT NULL');
  ensureColumn(db, 'engine_keys', 'secret_ref', 'TEXT NULL');
}

/** v91：新增独立本机配置，不导入旧账号任务或运行态。 */
function applyV91(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_task_configs (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK (source = 'local'),
      client_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      workspace_scope_type TEXT NULL CHECK (workspace_scope_type = 'local_workspace'),
      workspace_scope_id TEXT NULL,
      name TEXT NOT NULL,
      description TEXT NULL,
      task_type TEXT NOT NULL CHECK (task_type IN ('workflow', 'script')),
      cron_expr TEXT NOT NULL,
      timezone TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      payload_json TEXT NOT NULL,
      concurrency_policy TEXT NOT NULL CHECK (concurrency_policy IN ('skip_if_running', 'queue_one')),
      missed_policy TEXT NOT NULL CHECK (missed_policy IN ('skip_missed', 'run_once_on_reconnect')),
      timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0 AND timeout_ms <= 86400000),
      revision INTEGER NOT NULL CHECK (revision > 0),
      deleted_at INTEGER NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK ((workspace_scope_type IS NULL AND workspace_scope_id IS NULL)
        OR (workspace_scope_type IS NOT NULL AND workspace_scope_id IS NOT NULL)),
      CHECK (deleted_at IS NULL OR enabled = 0)
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_configs_device
      ON scheduled_task_configs(client_id, device_id, updated_at DESC, id);
  `);
}

/** v92：独立保留本机运行事实；配置或工作区删除不级联历史，不导入旧运行标记。 */
function applyV92(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      workspace_id TEXT NULL,
      workflow_instance_id TEXT NULL,
      workflow_name_snapshot TEXT NULL,
      workflow_version INTEGER NULL,
      scheduled_at INTEGER NOT NULL,
      started_at INTEGER NULL,
      finished_at INTEGER NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped', 'timeout')),
      trigger_source TEXT NOT NULL CHECK (trigger_source IN ('schedule', 'manual')),
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      duration_ms INTEGER NULL,
      summary TEXT NULL,
      error_message TEXT NULL,
      output_excerpt TEXT NULL,
      created_at INTEGER NOT NULL,
      source TEXT NOT NULL CHECK (source = 'local'),
      config_revision INTEGER NOT NULL CHECK (config_revision > 0),
      task_name_snapshot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_history
      ON scheduled_task_runs(task_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_device
      ON scheduled_task_runs(client_id, device_id, created_at DESC, id DESC);
  `);
}

/** v93：账号历史沿原表耐久保存；只在本次普通迁移内原子重建来源约束。 */
function applyV93(db: SqliteDb): void {
  const columns = db.prepare("PRAGMA table_info(scheduled_task_runs)").all() as Array<{ name: string }>;
  // 旧版本号可能重放已完成的新表；保留既有账号归属和结算，只补原索引。
  if (["server_origin", "owner_user_id", "report_settlement", "report_settled_at"].every(name => columns.some(column => column.name === name))) {
    createScheduledTaskRunV93Table(db); return;
  }
  db.exec(`ALTER TABLE scheduled_task_runs RENAME TO scheduled_task_runs_v92;
    DROP INDEX IF EXISTS idx_scheduled_task_runs_history; DROP INDEX IF EXISTS idx_scheduled_task_runs_device;`);
  createScheduledTaskRunV93Table(db);
  db.exec(`INSERT INTO scheduled_task_runs SELECT *, NULL, NULL, NULL, NULL FROM scheduled_task_runs_v92;
    DROP TABLE scheduled_task_runs_v92;`);
}

/** 新建或修复缺失表，不在每次打开时重建已存在历史。 */
function createScheduledTaskRunV93Table(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scheduled_task_runs (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, client_id TEXT NOT NULL, device_id TEXT NOT NULL,
    workspace_id TEXT NULL, workflow_instance_id TEXT NULL, workflow_name_snapshot TEXT NULL, workflow_version INTEGER NULL,
    scheduled_at INTEGER NOT NULL, started_at INTEGER NULL, finished_at INTEGER NULL,
    status TEXT NOT NULL CHECK(status IN ('running','success','failed','skipped','timeout')),
    trigger_source TEXT NOT NULL CHECK(trigger_source IN ('schedule','manual')), attempt INTEGER NOT NULL CHECK(attempt > 0),
    duration_ms INTEGER NULL, summary TEXT NULL, error_message TEXT NULL, output_excerpt TEXT NULL, created_at INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('local','account')), config_revision INTEGER NULL, task_name_snapshot TEXT NOT NULL,
    server_origin TEXT NULL, owner_user_id TEXT NULL, report_settlement TEXT NULL, report_settled_at INTEGER NULL,
    CHECK((source='local' AND config_revision > 0 AND config_revision IS NOT NULL AND server_origin IS NULL
      AND owner_user_id IS NULL AND report_settlement IS NULL AND report_settled_at IS NULL)
      OR (source='account' AND config_revision IS NULL AND workspace_id IS NULL AND workflow_instance_id IS NULL
        AND workflow_name_snapshot IS NULL AND workflow_version IS NULL AND server_origin IS NOT NULL AND length(trim(server_origin)) > 0
        AND owner_user_id IS NOT NULL AND length(trim(owner_user_id)) > 0)),
    CHECK((report_settlement IS NULL AND report_settled_at IS NULL) OR
      (source='account' AND report_settlement IS NOT NULL AND report_settlement IN ('acknowledged','task_deleted')
        AND typeof(report_settled_at)='integer' AND report_settled_at >= 0 AND report_settled_at <= 9007199254740991
        AND (report_settlement='task_deleted' OR status <> 'running')))
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_history ON scheduled_task_runs(task_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_device ON scheduled_task_runs(client_id, device_id, created_at DESC, id DESC);`);
}

/** 幂等维护运行证据索引；工具正文仍保留在原表，仅把 LIKE 扫描缩小到命中集合。 */
function ensureRawEngineEventRuntimeIndexes(db: SqliteDb): void {
  const rawTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'raw_engine_events'").get();
  const definitions: Array<{ name: string; table: string; sql: string }> = [];
  if (rawTable) {
    definitions.push(
      {
        name: "idx_raw_engine_events_thread_seq",
        table: "raw_engine_events",
        sql: `CREATE INDEX idx_raw_engine_events_thread_seq
          ON raw_engine_events(thread_id, seq, workspace_id, ts, source)`,
      },
      {
        name: "idx_raw_engine_events_thread_tools",
        table: "raw_engine_events",
        sql: `CREATE INDEX idx_raw_engine_events_thread_tools
          ON raw_engine_events(thread_id, seq, ts)
          WHERE event_json LIKE '%"tool_use"%' OR event_json LIKE '%"tool_result"%'`,
      },
    );
  }
  const promptTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orch_prompt_snapshots'").get();
  if (promptTable) {
    definitions.push({
      name: "idx_orch_prompt_snapshots_instance_node_attempt_created",
      table: "orch_prompt_snapshots",
      sql: `CREATE INDEX idx_orch_prompt_snapshots_instance_node_attempt_created
        ON orch_prompt_snapshots(instance_id, node_id, attempt_no, created_at ASC)`,
    });
  }
  const repairs = definitions.filter((definition) => !runtimeIndexMatches(db, definition));
  if (repairs.length === 0) return;
  db.transaction(() => {
    for (const definition of repairs) {
      db.exec(`DROP INDEX IF EXISTS ${definition.name}`);
      db.exec(definition.sql);
    }
  })();
}

/** 核对索引表和完整 SQL；保留 LIKE 字面量大小写，确保查询能匹配部分索引谓词。 */
function runtimeIndexMatches(
  db: SqliteDb,
  definition: { name: string; table: string; sql: string },
): boolean {
  const row = db.prepare(
    "SELECT tbl_name AS tableName, sql FROM sqlite_master WHERE type = 'index' AND name = ?",
  ).get(definition.name) as { tableName?: string; sql?: string | null } | undefined;
  const existingSql = String(row?.sql ?? "").trim().replace(/\s+/g, " ");
  const expectedSql = definition.sql.trim().replace(/\s+/g, " ");
  return String(row?.tableName ?? "") === definition.table
    && existingSql === expectedSql;
}

/** v83：持久化普通聊天显式输入类型与 Codex Skill opaque binding。 */
function applyV83(db: SqliteDb): void {
  ensureThreadInputContractColumns(db);
}

/** 创建代码归因 outbox；原始路径、源码和 Patch 不进入该表。 */
function createCodeAttributionOutboxTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_attribution_outbox (
      id TEXT PRIMARY KEY,
      source_batch_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      repository TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      association_id TEXT NOT NULL,
      association_expires_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      available_at INTEGER NOT NULL,
      lease_owner TEXT NULL,
      lease_expires_at INTEGER NULL,
      last_error_code TEXT NULL,
      last_error_message TEXT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)},
      FOREIGN KEY(instance_id) REFERENCES orch_instances(id) ON DELETE CASCADE,
      UNIQUE(workspace_id, instance_id, repository, commit_sha)
    );

    CREATE INDEX IF NOT EXISTS idx_code_attribution_outbox_ready
      ON code_attribution_outbox(status, available_at, lease_expires_at, created_at, id);
  `);
}

/** 创建本地留存观察任务；源码行与仓库路径不会同步到 Server。 */
function createCodeAttributionRetentionTaskTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_attribution_retention_tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      repository_path TEXT NOT NULL,
      repository TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_identity_sha256 TEXT NOT NULL,
      retained_lines_json TEXT NOT NULL,
      retained_ai_added_lines INTEGER NOT NULL CHECK(retained_ai_added_lines >= 0),
      window_days INTEGER NOT NULL CHECK(window_days IN (7, 30)),
      due_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      available_at INTEGER NOT NULL,
      lease_owner TEXT NULL,
      lease_expires_at INTEGER NULL,
      last_error_code TEXT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)},
      FOREIGN KEY(instance_id) REFERENCES orch_instances(id) ON DELETE CASCADE,
      UNIQUE(workspace_id, instance_id, repository, commit_sha, file_identity_sha256, window_days)
    );

    CREATE INDEX IF NOT EXISTS idx_code_attribution_retention_tasks_ready
      ON code_attribution_retention_tasks(status, due_at, available_at, lease_expires_at, created_at, id);
  `);
}

/** 幂等创建工作区目录迁移事实表及单 Client 未终态唯一约束。 */
function createWorkspaceDirectoryMigrationTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_directory_migrations (
      operation_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      source_path TEXT NOT NULL,
      target_parent_path TEXT NOT NULL,
      target_path TEXT NOT NULL,
      staging_path TEXT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'scanning', 'awaiting_confirmation', 'preparing', 'copying', 'verifying',
        'publish_intent', 'target_ready', 'path_committed', 'finalizing',
        'recovery_required', 'completed', 'cancelled', 'failed'
      )),
      source_file_count INTEGER NOT NULL DEFAULT 0 CHECK (source_file_count >= 0),
      source_dir_count INTEGER NOT NULL DEFAULT 0 CHECK (source_dir_count >= 0),
      source_total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (source_total_bytes >= 0),
      excluded_dependency_dir_count INTEGER NOT NULL DEFAULT 0 CHECK (excluded_dependency_dir_count >= 0),
      excluded_dependency_dirs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(excluded_dependency_dirs_json)),
      copied_files INTEGER NOT NULL DEFAULT 0 CHECK (copied_files >= 0),
      copied_bytes INTEGER NOT NULL DEFAULT 0 CHECK (copied_bytes >= 0),
      source_manifest_hash TEXT NULL,
      verified_target_manifest_hash TEXT NULL,
      terminal_cwd_snapshot_json TEXT NULL
        CHECK (terminal_cwd_snapshot_json IS NULL OR json_valid(terminal_cwd_snapshot_json)),
      external_writes_confirmed_at INTEGER NULL,
      target_storage_confirmed_at INTEGER NULL,
      start_attempt_id TEXT NULL,
      start_disposition TEXT NULL CHECK (start_disposition IS NULL OR start_disposition IN ('prepared', 'accepted', 'fenced')),
      start_decided_at INTEGER NULL,
      start_fence_ack_pending INTEGER NOT NULL DEFAULT 0 CHECK (start_fence_ack_pending IN (0, 1)),
      index_rebuild_generation INTEGER NULL,
      index_rebuild_status TEXT NOT NULL DEFAULT 'not_started'
        CHECK (index_rebuild_status IN ('not_started', 'pending', 'ready', 'failed', 'not_applicable')),
      index_rebuild_phase TEXT NULL CHECK (index_rebuild_phase IS NULL OR index_rebuild_phase IN ('queued', 'building')),
      index_rebuild_last_progress_at INTEGER NULL,
      state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version >= 1),
      notification_pending INTEGER NOT NULL DEFAULT 0 CHECK (notification_pending IN (0, 1)),
      notification_state_version INTEGER NULL,
      error_code TEXT NULL,
      error_message TEXT NULL,
      error_details_json TEXT NULL CHECK (error_details_json IS NULL OR json_valid(error_details_json)),
      warning_code TEXT NULL CHECK (warning_code IS NULL OR warning_code = 'WORKSPACE_INDEX_REBUILD_FAILED'),
      warning_details_json TEXT NULL CHECK (warning_details_json IS NULL OR json_valid(warning_details_json)),
      cancellation_reason TEXT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      CHECK ((start_attempt_id IS NULL AND start_disposition IS NULL AND start_decided_at IS NULL)
        OR (start_attempt_id IS NOT NULL AND start_disposition IS NOT NULL AND start_decided_at IS NOT NULL)),
      CHECK ((notification_pending = 0 AND notification_state_version IS NULL)
        OR (notification_pending = 1 AND notification_state_version IS NOT NULL))
    );

  `);
  ensureWorkspaceDirectoryMigrationDependencyExclusionColumns(db);
  ensureColumn(db, "workspace_directory_migrations", "cancellation_reason", "TEXT NULL");
  assertWorkspaceDirectoryMigrationTableShape(db);
  ensureWorkspaceDirectoryMigrationIndexDefinitions(db);
}

/** 幂等补齐依赖目录排除事实列，兼容 v71 数据库原地升级。 */
function ensureWorkspaceDirectoryMigrationDependencyExclusionColumns(db: SqliteDb): void {
  ensureColumn(
    db,
    "workspace_directory_migrations",
    "excluded_dependency_dir_count",
    "INTEGER NOT NULL DEFAULT 0 CHECK (excluded_dependency_dir_count >= 0)",
  );
  ensureColumn(
    db,
    "workspace_directory_migrations",
    "excluded_dependency_dirs_json",
    "TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(excluded_dependency_dirs_json))",
  );
}

/** 校验无法用 ADD COLUMN 安全修复的 v71 关键表结构，漂移时显式阻止启动。 */
function assertWorkspaceDirectoryMigrationTableShape(db: SqliteDb): void {
  const requiredColumns = [
    "operation_id", "idempotency_key", "workspace_id", "source_path", "target_parent_path", "target_path",
    "staging_path", "state", "source_file_count", "source_dir_count", "source_total_bytes", "copied_files",
    "excluded_dependency_dir_count", "excluded_dependency_dirs_json", "copied_bytes", "source_manifest_hash",
    "verified_target_manifest_hash", "terminal_cwd_snapshot_json",
    "external_writes_confirmed_at", "target_storage_confirmed_at", "start_attempt_id", "start_disposition",
    "start_decided_at", "start_fence_ack_pending", "index_rebuild_generation", "index_rebuild_status",
    "index_rebuild_phase", "index_rebuild_last_progress_at", "state_version", "notification_pending",
    "notification_state_version", "error_code", "error_message", "error_details_json", "warning_code",
    "warning_details_json", "cancellation_reason", "created_at", "updated_at", "completed_at",
  ];
  const columns = db.prepare("PRAGMA table_info(workspace_directory_migrations)").all() as Array<{ name?: string | null }>;
  const actual = new Set(columns.map((row) => String(row.name ?? "")));
  const missing = requiredColumns.filter((column) => !actual.has(column));
  const tableSql = String((db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_directory_migrations'",
  ).get() as { sql?: string | null } | undefined)?.sql ?? "");
  const normalizedSql = normalizeSchemaSql(tableSql);
  const requiredChecks = [
    "check (state in (",
    "check (start_fence_ack_pending in (0, 1))",
    "check ((start_attempt_id is null and start_disposition is null and start_decided_at is null)",
    "check ((notification_pending = 0 and notification_state_version is null)",
  ];
  const missingChecks = requiredChecks.filter((fragment) => !normalizedSql.includes(fragment));
  if (missing.length === 0 && missingChecks.length === 0) return;
  throw new Error(
    `workspace_directory_migrations schema 漂移，无法安全自动修复：missingColumns=${missing.join(",") || "none"}, missingChecks=${missingChecks.join("|") || "none"}`,
  );
}

/** 修复缺失或同名错误定义的 v71 索引，唯一约束冲突时由 SQLite 显式失败。 */
function ensureWorkspaceDirectoryMigrationIndexDefinitions(db: SqliteDb): void {
  const definitions = [
    {
      name: "uk_workspace_directory_migrations_idempotency",
      sql: "CREATE UNIQUE INDEX uk_workspace_directory_migrations_idempotency ON workspace_directory_migrations(idempotency_key)",
      fragments: ["create unique index", "on workspace_directory_migrations(idempotency_key)"],
    },
    {
      name: "uk_workspace_directory_migrations_single_active",
      sql: `CREATE UNIQUE INDEX uk_workspace_directory_migrations_single_active
        ON workspace_directory_migrations((1))
        WHERE state NOT IN ('completed', 'cancelled', 'failed')`,
      fragments: [
        "create unique index",
        "on workspace_directory_migrations((1))",
        "where state not in ('completed', 'cancelled', 'failed')",
      ],
    },
    {
      name: "idx_workspace_directory_migrations_workspace_updated",
      sql: `CREATE INDEX idx_workspace_directory_migrations_workspace_updated
        ON workspace_directory_migrations(workspace_id, updated_at DESC)`,
      fragments: ["create index", "on workspace_directory_migrations(workspace_id, updated_at desc)"],
    },
    {
      name: "idx_workspace_directory_migrations_notification",
      sql: `CREATE INDEX idx_workspace_directory_migrations_notification
        ON workspace_directory_migrations(notification_pending, updated_at ASC)
        WHERE notification_pending = 1`,
      fragments: [
        "create index",
        "on workspace_directory_migrations(notification_pending, updated_at asc)",
        "where notification_pending = 1",
      ],
    },
    {
      name: "idx_workspace_directory_migrations_start_fence",
      sql: `CREATE INDEX idx_workspace_directory_migrations_start_fence
        ON workspace_directory_migrations(start_fence_ack_pending, updated_at ASC)
        WHERE start_fence_ack_pending = 1`,
      fragments: [
        "create index",
        "on workspace_directory_migrations(start_fence_ack_pending, updated_at asc)",
        "where start_fence_ack_pending = 1",
      ],
    },
  ] as const;
  for (const definition of definitions) {
    const existingSql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(definition.name) as { sql?: string | null } | undefined)?.sql ?? "");
    const normalized = normalizeSchemaSql(existingSql);
    if (definition.fragments.every((fragment) => normalized.includes(fragment))) continue;
    db.exec(`DROP INDEX IF EXISTS ${definition.name}`);
    db.exec(definition.sql);
  }
}

/** 规范化 sqlite_master SQL，供结构修复做稳定片段比较。 */
function normalizeSchemaSql(sql: string): string {
  return String(sql ?? "").trim().replace(/\s+/g, " ").replace(/\s*;\s*$/g, "").toLowerCase();
}

/** 幂等创建会话删除引用索引；repair 阶段会补回已记录版本中的缺失索引。 */
function ensureThreadDeletionReferenceIndexes(db: SqliteDb): void {
  if (tableHasColumn(db, "orch_prompt_snapshots", "thread_id")
    && tableHasColumn(db, "orch_prompt_snapshots", "instance_id")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orch_prompt_snapshots_thread_instance
        ON orch_prompt_snapshots(thread_id, instance_id);
    `);
  }
  if (tableHasColumn(db, "orch_node_attempts", "thread_id")
    && tableHasColumn(db, "orch_node_attempts", "instance_id")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orch_node_attempts_thread_instance
        ON orch_node_attempts(thread_id, instance_id);
    `);
  }
  if (tableHasColumn(db, "orch_asset_generation_jobs", "thread_id")
    && tableHasColumn(db, "orch_asset_generation_jobs", "status")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orch_asset_generation_jobs_thread_status
        ON orch_asset_generation_jobs(thread_id, status);
    `);
  }
  if (tableHasColumn(db, "orch_instances", "master_thread_id")
    && tableHasColumn(db, "orch_instances", "status")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orch_instances_master_thread_status
        ON orch_instances(master_thread_id, status);
    `);
  }
}

/**
 * 只保存每个 thread/diff item 的最新完整正文。
 * conversation_events 继续保留 seq、哈希和大小，供回放边界与审计使用。
 */
function createConversationDiffSnapshotTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_diff_snapshots (
      thread_id TEXT NOT NULL,
      diff_key TEXT NOT NULL,
      event_seq INTEGER NOT NULL UNIQUE,
      diff_text TEXT NOT NULL,
      diff_sha256 TEXT NOT NULL,
      diff_bytes INTEGER NOT NULL CHECK (diff_bytes >= 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(thread_id, diff_key),
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE,
      FOREIGN KEY(event_seq) REFERENCES conversation_events(seq) ON DELETE CASCADE
    );
  `);
}

/** 幂等创建受控实验本地证据表及状态查询索引。 */
function createControlledExperimentTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS controlled_experiment_snapshots (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL,
      freeze_revision INTEGER NOT NULL,
      workspace_id TEXT NOT NULL,
      sample_id TEXT NOT NULL,
      evaluation_item_id TEXT NOT NULL,
      source_instance_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      prompt_snapshot_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      variant_key TEXT NOT NULL CHECK (variant_key IN ('baseline', 'candidate')),
      engine TEXT NOT NULL CHECK (engine IN ('claude', 'codex')),
      model TEXT NOT NULL,
      effort TEXT NULL,
      catalog_version INTEGER NOT NULL,
      prompt_envelope_json TEXT NOT NULL,
      system_message TEXT NOT NULL,
      developer_message TEXT NULL,
      user_message TEXT NOT NULL,
      artifact_input_json TEXT NOT NULL,
      input_sha256 TEXT NOT NULL,
      config_sha256 TEXT NOT NULL,
      prompt_definition_sha256 TEXT NOT NULL,
      price_snapshot_json TEXT NOT NULL,
      price_snapshot_sha256 TEXT NOT NULL,
      freeze_digest TEXT NOT NULL,
      per_run_timeout_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(experiment_id, freeze_revision, sample_id, variant_key),
      UNIQUE(experiment_id, freeze_revision, evaluation_item_id, variant_key)
    );
    CREATE INDEX IF NOT EXISTS idx_controlled_experiment_snapshots_lookup
      ON controlled_experiment_snapshots(experiment_id, sample_id, variant_key, freeze_revision DESC);

    CREATE TABLE IF NOT EXISTS controlled_experiment_runs (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL,
      assignment_id TEXT NOT NULL,
      sample_id TEXT NOT NULL,
      variant_key TEXT NOT NULL CHECK (variant_key IN ('baseline', 'candidate')),
      attempt_no INTEGER NOT NULL CHECK (attempt_no IN (1, 2)),
      snapshot_id TEXT NOT NULL,
      dispatch_token_sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('dispatched', 'running', 'cancel_requested', 'succeeded', 'failed', 'timed_out', 'cancelled')),
      status_version INTEGER NOT NULL DEFAULT 0,
      client_turn_id TEXT NOT NULL,
      engine TEXT NOT NULL CHECK (engine IN ('claude', 'codex')),
      engine_session_id TEXT NULL,
      engine_turn_id TEXT NULL,
      deadline_at INTEGER NOT NULL,
      started_at INTEGER NULL,
      completed_at INTEGER NULL,
      output_text TEXT NULL,
      output_sha256 TEXT NULL,
      input_tokens INTEGER NULL,
      output_tokens INTEGER NULL,
      cached_input_tokens INTEGER NULL,
      cache_creation_input_tokens INTEGER NULL,
      total_tokens INTEGER NULL,
      estimated_cost_micros INTEGER NULL,
      usage_accounting_status TEXT NOT NULL CHECK (usage_accounting_status IN ('pending', 'complete')),
      event_log_json TEXT NOT NULL DEFAULT '[]',
      error_code TEXT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(experiment_id, assignment_id, variant_key, attempt_no),
      FOREIGN KEY(snapshot_id) REFERENCES controlled_experiment_snapshots(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_controlled_experiment_runs_experiment_status
      ON controlled_experiment_runs(experiment_id, status, updated_at ASC);
    CREATE INDEX IF NOT EXISTS idx_controlled_experiment_runs_recovery
      ON controlled_experiment_runs(status, updated_at ASC)
      WHERE status IN ('dispatched', 'running', 'cancel_requested');
  `);
  ensureColumn(db, "controlled_experiment_snapshots", "catalog_version", "INTEGER NOT NULL DEFAULT 0");
}

type FileBlobReferenceIndexSpec = {
  name: string;
  table: string;
  column: string;
  partialNotNull: boolean;
};

const FILE_BLOB_REFERENCE_INDEX_SPECS: FileBlobReferenceIndexSpec[] = [
  {
    name: "idx_thread_draft_attachments_blob_id",
    table: "thread_draft_attachments",
    column: "blob_id",
    partialNotNull: false,
  },
  {
    name: "idx_thread_message_queue_attachments_blob_id",
    table: "thread_message_queue_attachments",
    column: "blob_id",
    partialNotNull: false,
  },
  {
    name: "idx_turn_file_changes_before_blob_id",
    table: "turn_file_changes",
    column: "before_blob_id",
    partialNotNull: true,
  },
  {
    name: "idx_turn_file_changes_after_blob_id",
    table: "turn_file_changes",
    column: "after_blob_id",
    partialNotNull: true,
  },
  {
    name: "idx_turn_file_changes_accepted_blob_id",
    table: "turn_file_changes",
    column: "accepted_blob_id",
    partialNotNull: true,
  },
];

/** 校验并原子修复 file_blobs 五类引用查询使用的索引。 */
function ensureFileBlobReferenceIndexes(db: SqliteDb): void {
  const repairSpecs = FILE_BLOB_REFERENCE_INDEX_SPECS.filter((spec) => (
    tableExists(db, spec.table)
    && tableHasColumn(db, spec.table, spec.column)
    && !fileBlobReferenceIndexMatches(db, spec)
  ));
  if (!repairSpecs.length) return;

  db.transaction(() => {
    for (const spec of repairSpecs) {
      db.exec(`DROP INDEX IF EXISTS ${quoteSqlIdentifier(spec.name)};`);
      const predicate = spec.partialNotNull
        ? ` WHERE ${quoteSqlIdentifier(spec.column)} IS NOT NULL`
        : "";
      db.exec(
        `CREATE INDEX ${quoteSqlIdentifier(spec.name)} ON ${quoteSqlIdentifier(spec.table)}(${quoteSqlIdentifier(spec.column)})${predicate};`,
      );
    }
  })();
}

/** 校验同名索引的目标表、非唯一 BINARY 升序键和 partial predicate。 */
function fileBlobReferenceIndexMatches(db: SqliteDb, spec: FileBlobReferenceIndexSpec): boolean {
  const row = db.prepare(
    "SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?",
  ).get(spec.name) as { tbl_name?: string | null; sql?: string | null } | undefined;
  if (!row || String(row.tbl_name ?? "") !== spec.table) return false;

  const indexList = db.prepare(`PRAGMA index_list(${quoteSqlIdentifier(spec.table)})`).all() as Array<{
    name?: string | null;
    unique?: number | null;
  }>;
  const indexMetadata = indexList.find((entry) => String(entry.name ?? "") === spec.name);
  if (!indexMetadata || Number(indexMetadata.unique ?? 0) !== 0) return false;

  const keyColumns = (db.prepare(`PRAGMA index_xinfo(${quoteSqlIdentifier(spec.name)})`).all() as Array<{
    name?: string | null;
    coll?: string | null;
    desc?: number | null;
    key?: number | null;
  }>).filter((entry) => Number(entry.key ?? 0) === 1);
  if (
    keyColumns.length !== 1
    || String(keyColumns[0]?.name ?? "") !== spec.column
    || String(keyColumns[0]?.coll ?? "").toUpperCase() !== "BINARY"
    || Number(keyColumns[0]?.desc ?? 0) !== 0
  ) {
    return false;
  }

  const normalizedSql = String(row.sql ?? "")
    .trim()
    .toLowerCase()
    .replace(/["`\[\]]/g, "")
    .replace(/\s+/g, " ")
    .replace(/;$/, "");
  const whereIndex = normalizedSql.indexOf(" where ");
  if (!spec.partialNotNull) return whereIndex < 0;
  return whereIndex >= 0
    && normalizedSql.slice(whereIndex + 7) === `${spec.column.toLowerCase()} is not null`;
}

/** 安全引用迁移内使用的 SQLite 标识符。 */
function quoteSqlIdentifier(value: string): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/** 幂等创建节点 Attempt 真源表及 Artifact Attempt 唯一来源索引。 */
function createOrchNodeAttemptTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orch_node_attempts (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      thread_id TEXT NULL,
      turn_id TEXT NULL,
      submission_json TEXT NULL,
      submission_hash TEXT NULL,
      response_text TEXT NULL,
      artifact_id TEXT NULL,
      last_error TEXT NULL,
      submitted_at INTEGER NULL,
      finalized_at INTEGER NULL,
      invalidated_at INTEGER NULL,
      version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(instance_id) REFERENCES orch_instances(id) ON DELETE CASCADE,
      UNIQUE(instance_id, node_id, attempt_no)
    );

    CREATE INDEX IF NOT EXISTS idx_orch_node_attempts_instance_status
      ON orch_node_attempts(instance_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orch_node_attempts_instance_node
      ON orch_node_attempts(instance_id, node_id, attempt_no DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS uk_orch_node_attempts_active
      ON orch_node_attempts(instance_id, node_id)
      WHERE status IN ('running', 'result-submitted', 'finalizing');
    CREATE UNIQUE INDEX IF NOT EXISTS uk_orch_artifacts_node_attempt
      ON orch_artifacts(
        instance_id,
        CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.nodeAttemptId') END
      )
      WHERE json_valid(metadata_json)
        AND json_extract(metadata_json, '$.nodeAttemptId') IS NOT NULL;
  `);
}

/** 幂等创建节点工作项看板、工作项和追加事件表。 */
function createOrchNodeWorkItemTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orch_node_work_item_boards (
      instance_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(instance_id, node_id),
      FOREIGN KEY(instance_id) REFERENCES orch_instances(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS orch_node_work_items (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      client_key TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NULL,
      source_key TEXT NULL,
      output_path TEXT NULL,
      sort_order INTEGER NOT NULL,
      status TEXT NOT NULL,
      result_summary TEXT NULL,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
      completion_checks_json TEXT NOT NULL DEFAULT '[]',
      output_sha256 TEXT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER NULL,
      completed_at INTEGER NULL,
      deleted_at INTEGER NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(instance_id, node_id)
        REFERENCES orch_node_work_item_boards(instance_id, node_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uk_orch_node_work_items_active_client_key
      ON orch_node_work_items(instance_id, node_id, client_key)
      WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_orch_node_work_items_node_order
      ON orch_node_work_items(instance_id, node_id, deleted_at, sort_order, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_orch_node_work_items_node_status
      ON orch_node_work_items(instance_id, node_id, status, deleted_at, sort_order);

    CREATE TABLE IF NOT EXISTS orch_node_work_item_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      item_id TEXT NULL,
      event_type TEXT NOT NULL,
      item_version INTEGER NULL,
      payload_json TEXT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(instance_id, node_id)
        REFERENCES orch_node_work_item_boards(instance_id, node_id) ON DELETE CASCADE,
      FOREIGN KEY(item_id) REFERENCES orch_node_work_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_orch_node_work_item_events_node
      ON orch_node_work_item_events(instance_id, node_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_orch_node_work_item_events_item
      ON orch_node_work_item_events(item_id, id DESC);
  `);
}

/** 幂等补齐工作项完成合同列，兼容已记录 v65 的历史数据库。 */
function ensureOrchNodeWorkItemCompletionColumns(db: SqliteDb): void {
  createOrchNodeWorkItemTables(db);
  ensureColumn(db, "orch_node_work_items", "acceptance_criteria_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "orch_node_work_items", "completion_checks_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "orch_node_work_items", "output_sha256", "TEXT NULL");
}

/** 幂等创建资产分组及资产关联表。 */
function createOrchAssetGroupTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orch_asset_groups (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)}
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uk_orch_asset_groups_workspace_type_name
      ON orch_asset_groups(workspace_id, asset_type, name_key);
    CREATE TABLE IF NOT EXISTS orch_asset_group_assignments (
      workspace_id TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id, asset_type, asset_id)${applicationWorkspaceForeignKey(db)},
      FOREIGN KEY(group_id) REFERENCES orch_asset_groups(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orch_asset_group_assignments_group
      ON orch_asset_group_assignments(group_id, asset_id);
  `);
}

/** 确保 workspace 软删除标记存在；0=可见，1=已移除。 */
function ensureWorkspaceSoftDeleteColumn(db: SqliteDb): void {
  ensureColumn(db, "workspaces", "is_deleted", "INTEGER NOT NULL DEFAULT 0");
}

function applyV10(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_engine_events (
      seq INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      source TEXT NOT NULL,
      event_json TEXT NOT NULL,
      ts INTEGER NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_raw_engine_events_thread_seq
      ON raw_engine_events(thread_id, seq);

    CREATE TABLE IF NOT EXISTS conversation_events (
      seq INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      ts INTEGER NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_conversation_events_thread_seq
      ON conversation_events(thread_id, seq);
  `);
}

/** v11：幂等补齐工作区上下文偏好。 */
function applyV11(db: SqliteDb): void {
  ensureColumn(db, "workspace_prefs", "context_window", "INTEGER NULL");
  ensureColumn(db, "workspace_prefs", "auto_compact_pct", "INTEGER NULL");
}

function applyV12(db: SqliteDb): void {
  // reserved
}

function applyV16(db: SqliteDb): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    dropOrchestrationTables(db);
    createOrchestrationTables(db);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function applyV17(db: SqliteDb): void {
  createOrchestrationAssetTables(db);
}

function applyV18(db: SqliteDb): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    dropOrchestrationTables(db);
    createOrchestrationTables(db);
    createOrchestrationAssetTables(db);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function applyV19(db: SqliteDb): void {
  ensureColumn(db, "orch_artifacts", "persistence_mode", "TEXT NULL");
  ensureColumn(db, "orch_artifacts", "payload_mode", "TEXT NULL");
  ensureColumn(db, "orch_artifacts", "workspace_status", "TEXT NULL");
  ensureColumn(db, "orch_artifacts", "workspace_base_dir", "TEXT NULL");
  ensureColumn(db, "orch_artifacts", "staging_path", "TEXT NULL");
  ensureColumn(db, "orch_artifacts", "published_path", "TEXT NULL");
  ensureColumn(db, "orch_artifacts", "content_hash", "TEXT NULL");
  ensureColumn(db, "orch_artifacts", "manifest_json", "TEXT NULL");
  createOrchestrationRuntimeExtensionTables(db);
}

function applyV20(db: SqliteDb): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    dropOrchestrationTables(db);
    createOrchestrationTables(db);
    createOrchestrationAssetTables(db);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function applyV21(db: SqliteDb): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    dropOrchestrationTables(db);
    createOrchestrationTables(db);
    createOrchestrationAssetTables(db);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function applyV22(db: SqliteDb): void {
  const rows = db.prepare(
    `SELECT id, execution_config_json, definition_json
       FROM orch_roles`,
  ).all() as Array<{ id: string; execution_config_json: string | null; definition_json: string | null }>;

  const update = db.prepare(
    `UPDATE orch_roles
        SET execution_config_json = ?,
            definition_json = ?,
            updated_at = ?
      WHERE id = ?`,
  );

  const now = Date.now();
  for (const row of rows) {
    const executionConfig = safeParseJson<Record<string, unknown> | null>(row.execution_config_json, null);
    const definition = safeParseJson<Record<string, unknown> | null>(row.definition_json, null);
    const definitionExec = definition && typeof definition === "object" ? definition.executionConfig : null;
    const currentMode = String(
      (executionConfig && typeof executionConfig === "object" ? executionConfig.accessMode : null)
      ?? (definitionExec && typeof definitionExec === "object" ? (definitionExec as Record<string, unknown>).accessMode : null)
      ?? "",
    ).trim();
    if (currentMode !== "current") continue;

    const nextExecutionConfig = {
      ...(executionConfig && typeof executionConfig === "object" ? executionConfig : {}),
      accessMode: "full-access",
    };
    const nextDefinition = {
      ...(definition && typeof definition === "object" ? definition : {}),
      executionConfig: {
        ...(definitionExec && typeof definitionExec === "object" ? definitionExec as Record<string, unknown> : {}),
        accessMode: "full-access",
      },
    };

    update.run(
      JSON.stringify(nextExecutionConfig),
      JSON.stringify(nextDefinition),
      now,
      row.id,
    );
  }
}

function applyV23(db: SqliteDb): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    dropOrchestrationTables(db);
    createOrchestrationTables(db);
    createOrchestrationAssetTables(db);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

/** 创建草案运行图，工作区沿本地父子关系保持原事务闭包。 */
function createOrchestrationAssetTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orch_asset_generation_jobs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      asset_kind TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      target_asset_id TEXT NULL,
      client_request_id TEXT NULL,
      base_version_id TEXT NULL,
      draft_id TEXT NULL,
      thread_id TEXT NULL,
      prompt TEXT NOT NULL,
      request_json TEXT NULL,
      interaction_json TEXT NULL,
      progress_json TEXT NULL,
      failure_json TEXT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_orch_asset_jobs_workspace_updated
      ON orch_asset_generation_jobs(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orch_asset_jobs_target
      ON orch_asset_generation_jobs(workspace_id, asset_kind, target_asset_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_asset_jobs_client_request
      ON orch_asset_generation_jobs(workspace_id, client_request_id)
      WHERE client_request_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS orch_asset_drafts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      asset_kind TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      target_asset_id TEXT NULL,
      base_version_id TEXT NULL,
      source_job_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      validation_issues_json TEXT NULL,
      rationale TEXT NULL,
      engine_info_json TEXT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)},
      FOREIGN KEY(source_job_id) REFERENCES orch_asset_generation_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orch_asset_drafts_workspace_updated
      ON orch_asset_drafts(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orch_asset_drafts_target
      ON orch_asset_drafts(workspace_id, asset_kind, target_asset_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS orch_asset_job_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(job_id) REFERENCES orch_asset_generation_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orch_asset_job_events_job_created
      ON orch_asset_job_events(job_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS orch_asset_versions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      asset_kind TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      source_draft_id TEXT NULL,
      snapshot_json TEXT NOT NULL,
      created_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)},
      FOREIGN KEY(source_draft_id) REFERENCES orch_asset_drafts(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orch_asset_versions_asset_created
      ON orch_asset_versions(workspace_id, asset_kind, asset_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_asset_versions_asset_version
      ON orch_asset_versions(workspace_id, asset_kind, asset_id, version);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_asset_versions_source_draft
      ON orch_asset_versions(source_draft_id)
      WHERE source_draft_id IS NOT NULL;
  `);
}

function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function dropOrchestrationTables(db: SqliteDb): void {
  db.exec(`
    DROP TABLE IF EXISTS orch_asset_versions;
    DROP TABLE IF EXISTS orch_asset_job_events;
    DROP TABLE IF EXISTS orch_asset_drafts;
    DROP TABLE IF EXISTS orch_asset_generation_jobs;
    DROP TABLE IF EXISTS orch_node_context_resolutions;
    DROP TABLE IF EXISTS orch_artifact_fields;
    DROP TABLE IF EXISTS orch_artifact_files;
    DROP TABLE IF EXISTS orch_prompt_snapshots;
    DROP TABLE IF EXISTS orch_events;
    DROP TABLE IF EXISTS orch_feedback_records;
    DROP TABLE IF EXISTS orch_artifacts;
    DROP TABLE IF EXISTS orch_proposals;
    DROP TABLE IF EXISTS orch_intakes;
    DROP TABLE IF EXISTS orch_toolsets;
    DROP TABLE IF EXISTS orch_skills;
    DROP TABLE IF EXISTS orch_tool_policies;
    DROP TABLE IF EXISTS orch_knowledge_bundles;
    DROP TABLE IF EXISTS orch_instances;
    DROP TABLE IF EXISTS orch_workflows;
    DROP TABLE IF EXISTS orch_roles;
    DROP TABLE IF EXISTS orch_asset_bundle_sync;
  `);
}

/** 创建编排主图；工作区库不复制应用级处理人模板。 */
function createOrchestrationTables(db: SqliteDb): void {
  const workspaceScoped = Number(db.pragma("application_id", { simple: true })) === WORKSPACE_DB_APPLICATION_ID;
  db.exec(`
    CREATE TABLE IF NOT EXISTS orch_roles (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      execution_config_json TEXT NOT NULL DEFAULT '{}',
      definition_json TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'custom',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_orch_roles_workspace ON orch_roles(workspace_id);

    CREATE TABLE IF NOT EXISTS orch_workflows (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      nodes_json TEXT NOT NULL DEFAULT '[]',
      edges_json TEXT NOT NULL DEFAULT '[]',
      definition_json TEXT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_orch_workflows_workspace ON orch_workflows(workspace_id);

    CREATE TABLE IF NOT EXISTS orch_instances (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      workflow_snapshot_json TEXT NOT NULL,
      asset_runtime_snapshot_json TEXT NULL,
      proposal_id TEXT NULL,
      intake_snapshot_json TEXT NOT NULL,
      role_snapshots_json TEXT NULL,
      toolset_snapshots_json TEXT NULL,
      runtime_config_json TEXT NULL,
      artifact_index_json TEXT NULL,
      master_thread_id TEXT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      node_states_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_orch_instances_workspace ON orch_instances(workspace_id, status);

    CREATE TABLE IF NOT EXISTS orch_toolsets (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      definition_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_orch_toolsets_workspace ON orch_toolsets(workspace_id);

    CREATE TABLE IF NOT EXISTS orch_knowledge_bundles (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'shared',
      definition_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_orch_knowledge_bundles_workspace
      ON orch_knowledge_bundles(workspace_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS orch_skills (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      definition_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_orch_skills_workspace
      ON orch_skills(workspace_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS orch_intakes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      task_type TEXT NOT NULL DEFAULT 'unknown',
      goal TEXT NOT NULL DEFAULT '',
      intake_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_orch_intakes_workspace ON orch_intakes(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orch_intakes_workspace_updated ON orch_intakes(workspace_id, updated_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS orch_proposals (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      intake_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      proposal_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)},
      FOREIGN KEY(intake_id) REFERENCES orch_intakes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orch_proposals_workspace ON orch_proposals(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orch_proposals_intake ON orch_proposals(intake_id);

    CREATE TABLE IF NOT EXISTS orch_artifacts (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      title TEXT NOT NULL DEFAULT '',
      schema_ref TEXT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      content_json TEXT NOT NULL,
      metadata_json TEXT NULL,
      persistence_mode TEXT NULL,
      payload_mode TEXT NULL,
      workspace_status TEXT NULL,
      workspace_base_dir TEXT NULL,
      staging_path TEXT NULL,
      published_path TEXT NULL,
      content_hash TEXT NULL,
      manifest_json TEXT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(instance_id) REFERENCES orch_instances(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orch_artifacts_instance_node ON orch_artifacts(instance_id, node_id, version DESC);

    CREATE TABLE IF NOT EXISTS orch_events (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      node_id TEXT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(instance_id) REFERENCES orch_instances(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orch_events_instance_created ON orch_events(instance_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS orch_feedback_records (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(instance_id) REFERENCES orch_instances(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orch_feedback_records_instance ON orch_feedback_records(instance_id, created_at DESC);
  `);
  if (!workspaceScoped) createOrchestrationAssigneeTemplateTables(db);
  createOrchestrationRuntimeExtensionTables(db);
}

/** v25：幂等补齐线程类型并回填历史编排线程。 */
function applyV25(db: SqliteDb): void {
  ensureColumn(db, "threads", "thread_type", "TEXT NOT NULL DEFAULT 'chat'");
  db.exec(`
    UPDATE threads
    SET thread_type = 'orchestration'
    WHERE id LIKE 'orch-%'
       OR id LIKE 'asset-draft-%'
       OR title LIKE '[编排]%'
       OR title LIKE '[编排主线程]%'
       OR title LIKE '[角色草案]%';

    CREATE INDEX IF NOT EXISTS idx_threads_workspace_type_updated
      ON threads(workspace_id, thread_type, archived, updated_at DESC);
  `);
}

/** v26：幂等补齐编排线程子类型并回填历史记录。 */
function applyV26(db: SqliteDb): void {
  ensureColumn(db, "threads", "thread_subtype", "TEXT NULL");
  db.exec(`
    UPDATE threads
    SET thread_subtype = 'master'
    WHERE thread_type = 'orchestration'
      AND (
        id LIKE 'orch-master-%'
        OR title LIKE '[编排主线程]%'
      );

    UPDATE threads
    SET thread_subtype = 'asset-draft'
    WHERE thread_type = 'orchestration'
      AND thread_subtype IS NULL
      AND (
        id LIKE 'asset-draft-%'
        OR title LIKE '[角色草案]%'
      );

    UPDATE threads
    SET thread_subtype = 'node'
    WHERE thread_type = 'orchestration'
      AND thread_subtype IS NULL
      AND (
        id LIKE 'orch-%'
        OR title LIKE '[编排]%'
      );
  `);
}

/** 创建需求分析事实与本地父子 FK。 */
function applyV27(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orch_requirement_analysis_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      phase TEXT NOT NULL DEFAULT 'discover',
      engine TEXT NOT NULL DEFAULT 'codex',
      model TEXT NULL,
      effort TEXT NULL,
      runtime_thread_id TEXT NULL,
      engine_session_id TEXT NULL,
      latest_turn_summary TEXT NULL,
      latest_assistant_reply TEXT NULL,
      last_message_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_orch_req_analysis_sessions_workspace_status_updated
      ON orch_requirement_analysis_sessions(workspace_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS orch_requirement_analysis_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      structured_payload_json TEXT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES orch_requirement_analysis_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orch_req_analysis_messages_session_created
      ON orch_requirement_analysis_messages(session_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS orch_requirement_candidate_drafts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      ready_to_create INTEGER NOT NULL DEFAULT 0,
      candidate_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(session_id) REFERENCES orch_requirement_analysis_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orch_req_candidate_drafts_session_updated
      ON orch_requirement_candidate_drafts(session_id, updated_at DESC);
  `);
}

function applyV28(db: SqliteDb): void {
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    backfillLegacyRequirementAnalysisThreads(db);
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

function applyV29(db: SqliteDb): void {
  const rows = db.prepare(
    `SELECT id, execution_config_json, definition_json
       FROM orch_roles`,
  ).all() as Array<{ id: string; execution_config_json: string | null; definition_json: string | null }>;
  if (!rows.length) return;

  const update = db.prepare(
    `UPDATE orch_roles
        SET execution_config_json = ?,
            definition_json = ?,
            updated_at = ?
      WHERE id = ?`,
  );

  const now = Date.now();
  for (const row of rows) {
    const executionConfig = safeParseJson<Record<string, unknown> | null>(row.execution_config_json, null);
    const definition = safeParseJson<Record<string, unknown> | null>(row.definition_json, null);
    const definitionExec = definition && typeof definition === "object" ? definition.executionConfig : null;
    const nextExecutionConfig = migrateRoleExecutionConfigV29(executionConfig ?? definitionExec ?? null);
    const nextDefinition = {
      ...(definition && typeof definition === "object" ? definition : {}),
      executionConfig: nextExecutionConfig,
    };
    update.run(
      JSON.stringify(nextExecutionConfig),
      JSON.stringify(nextDefinition),
      now,
      row.id,
    );
  }
}

function applyV30(db: SqliteDb): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orch_intakes_workspace_updated
      ON orch_intakes(workspace_id, updated_at DESC, id DESC);
  `);
}

function applyV31(db: SqliteDb): void {
  ensurePromptSnapshotEnvelopeColumn(db);
}

function applyV32(db: SqliteDb): void {
  createThreadDraftTables(db);
}

function applyV33(db: SqliteDb): void {
  ensureColumn(db, "threads", "auto_compact_pct", "INTEGER NULL");
  ensureColumn(db, "threads", "context_window", "INTEGER NULL");
}

function applyV34(db: SqliteDb): void {
  backfillExplicitThreadPrefs(db);
}

function applyV35(db: SqliteDb): void {
  ensureColumn(db, "threads", "session_capabilities_json", "TEXT NULL");
}

function applyV36(db: SqliteDb): void {
  ensureThreadTurnRunningIndex(db);
}

function applyV37(db: SqliteDb): void {
  createReminderTables(db);
}

function applyV38(db: SqliteDb): void {
  createReminderIgnoreTable(db);
}

function applyV39(db: SqliteDb): void {
  createThreadMessageQueueTables(db);
}

/** v40: 给 thread_message_queue 加 client_item_id 列 + active 状态范围内的唯一索引（幂等去重）。 */
function applyV40(db: SqliteDb): void {
  ensureColumn(db, "thread_message_queue", "client_item_id", "TEXT NULL");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uk_thread_message_queue_thread_client_item_id_active
      ON thread_message_queue(thread_id, client_item_id)
      WHERE client_item_id IS NOT NULL AND status IN ('pending','sending');
  `);
}

/** 创建会话提醒和收据，工作区归属由注册入口校验。 */
function createReminderTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_reminder_states (
      thread_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      attention_kind TEXT NULL,
      attention_request_id TEXT NULL,
      latest_completed_turn_id TEXT NULL,
      latest_completed_at INTEGER NULL,
      latest_completed_status TEXT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_thread_reminder_states_workspace_updated
      ON thread_reminder_states(workspace_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS reminder_receipts (
      entity_type TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      marker TEXT NULL,
      read_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (entity_type, workspace_id, entity_id)${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_reminder_receipts_workspace_updated
      ON reminder_receipts(workspace_id, updated_at DESC);
  `);
}

/** 复用应用与工作区表结构，省略跨文件注册 FK。 */
function createReminderIgnoreTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reminder_ignores (
      workspace_id TEXT NOT NULL,
      reminder_id TEXT NOT NULL,
      marker TEXT NOT NULL,
      ignored_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, reminder_id)${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_reminder_ignores_workspace_updated
      ON reminder_ignores(workspace_id, updated_at DESC);
  `);
}

/** 创建钉钉待办通知发送记录表；notification_key 是业务幂等键。 */
function createDingTalkReminderNotificationTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dingtalk_reminder_notifications (
      notification_key TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('chat', 'orchestration')),
      target_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      error_message TEXT NOT NULL DEFAULT '',
      sent_at INTEGER NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_dingtalk_reminder_notifications_workspace_updated
      ON dingtalk_reminder_notifications(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_dingtalk_reminder_notifications_status_updated
      ON dingtalk_reminder_notifications(status, updated_at DESC);
  `);
}

/** 创建企业微信待办通知发送记录表；notification_key 是业务幂等键。 */
function createWeComReminderNotificationTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wecom_reminder_notifications (
      notification_key TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN ('chat', 'orchestration')),
      target_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'sent', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
      error_message TEXT NOT NULL DEFAULT '',
      sent_at INTEGER NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_wecom_reminder_notifications_workspace_updated
      ON wecom_reminder_notifications(workspace_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_wecom_reminder_notifications_status_updated
      ON wecom_reminder_notifications(status, updated_at DESC);
  `);
}

function ensureThreadTurnRunningIndex(db: SqliteDb): void {
  const hasThreadTurns = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'thread_turns'").get(),
  );
  if (!hasThreadTurns) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_thread_turns_workspace_running
      ON thread_turns(workspace_id, status, ended_at, started_at DESC);
  `);
  createReminderTables(db);
}

function ensurePromptSnapshotEnvelopeColumn(db: SqliteDb): void {
  const columns = db.prepare("PRAGMA table_info(orch_prompt_snapshots)").all() as Array<{ name?: string | null }>;
  if (!columns.some((column) => String(column.name ?? "") === "prompt_envelope_json")) {
    db.exec(`
      ALTER TABLE orch_prompt_snapshots
        ADD COLUMN prompt_envelope_json TEXT NULL;
    `);
  }
}

function backfillExplicitThreadPrefs(db: SqliteDb): void {
  const rows = db.prepare(
    [
      "SELECT id, engine, thread_subtype, model, effort, access_mode, plan_mode, auto_compact_pct, context_window",
      "FROM threads",
    ].join("\n"),
  ).all() as Array<{
    id: string;
    engine: string | null;
    thread_subtype: string | null;
    model: string | null;
    effort: string | null;
    access_mode: string | null;
    plan_mode: number | null;
    auto_compact_pct: number | null;
    context_window: number | null;
  }>;
  if (!rows.length) return;

  const update = db.prepare(
    [
      "UPDATE threads",
      "SET model = ?,",
      "    effort = ?,",
      "    access_mode = ?,",
      "    plan_mode = ?,",
      "    auto_compact_pct = ?,",
      "    context_window = ?",
      "WHERE id = ?",
    ].join("\n"),
  );

  for (const row of rows) {
    const engine = row.engine === "claude" || row.engine === "codex" ? row.engine : null;
    if (!engine) continue;

    const resolved = resolveThreadPrefsWithCatalogDefaults(engine, {
      model: row.model ?? null,
      effort: row.effort ?? null,
      accessMode: row.access_mode === "read-only" || row.access_mode === "current" || row.access_mode === "full-access"
        ? row.access_mode
        : null,
      planMode: row.plan_mode != null ? Boolean(row.plan_mode) : null,
      autoCompactPct: row.auto_compact_pct ?? null,
      contextWindow: row.context_window ?? null,
    });

    const accessMode = row.thread_subtype === "node-discussion" ? "read-only" : resolved.accessMode;
    const planMode = row.thread_subtype === "node-discussion" ? false : resolved.planMode;

    update.run(
      resolved.model,
      resolved.effort,
      accessMode,
      planMode ? 1 : 0,
      resolved.autoCompactPct,
      resolved.contextWindow,
      row.id,
    );
  }
}

function migrateRoleExecutionConfigV29(raw: unknown) {
  if (raw && typeof raw === "object" && "preferredEngine" in (raw as Record<string, unknown>) && "engineProfiles" in (raw as Record<string, unknown>)) {
    return normalizeRoleExecutionConfig(raw as any, (raw as any)?.preferredEngine === "claude" ? "claude" : "codex");
  }
  const legacy = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const preferredEngine = legacy.engine === "claude" ? "claude" : legacy.engine === "codex" ? "codex" : "codex";
  const defaults = createDefaultRoleExecutionCustomConfig(preferredEngine);
  const accessMode = legacy.accessMode === "read-only" || legacy.accessMode === "current" || legacy.accessMode === "full-access"
    ? legacy.accessMode
    : defaults.accessMode;
  const autoCompactPct = Number(legacy.autoCompactPct);
  const contextWindow = Number(legacy.contextWindow);
  const maxRetries = Number(legacy.maxRetries);
  return normalizeRoleExecutionConfig({
    preferredEngine,
    engineProfiles: {
      claude: {
        enabled: true,
        mode: preferredEngine === "claude" ? "custom" : "auto",
        customConfig: preferredEngine === "claude"
          ? {
              model: String(legacy.model ?? "").trim() || defaults.model,
              effort: String(legacy.effort ?? "").trim() || defaults.effort,
              accessMode,
              autoCompactPct: Number.isFinite(autoCompactPct) ? autoCompactPct : null,
              contextWindow: Number.isFinite(contextWindow) ? contextWindow : null,
              maxRetries: Number.isFinite(maxRetries) ? maxRetries : defaults.maxRetries ?? 0,
            }
          : null,
      },
      codex: {
        enabled: true,
        mode: preferredEngine === "codex" ? "custom" : "auto",
        customConfig: preferredEngine === "codex"
          ? {
              model: String(legacy.model ?? "").trim() || defaults.model,
              effort: String(legacy.effort ?? "").trim() || defaults.effort,
              accessMode,
              autoCompactPct: null,
              contextWindow: Number.isFinite(contextWindow) ? contextWindow : null,
              maxRetries: Number.isFinite(maxRetries) ? maxRetries : defaults.maxRetries ?? 0,
            }
          : null,
      },
    },
  }, preferredEngine);
}

export function backfillLegacyRequirementAnalysisThreads(db: SqliteDb): void {
  const legacySessions = db.prepare(
    `SELECT id, workspace_id, title, status, phase, engine, model, effort,
            runtime_thread_id, engine_session_id, latest_turn_summary,
            latest_assistant_reply, last_message_at, created_at, updated_at
       FROM orch_requirement_analysis_sessions
      ORDER BY updated_at ASC, created_at ASC, id ASC`,
  ).all() as Array<{
    id: string;
    workspace_id: string;
    title: string | null;
    status: string | null;
    phase: string | null;
    engine: string | null;
    model: string | null;
    effort: string | null;
    runtime_thread_id: string | null;
    engine_session_id: string | null;
    latest_turn_summary: string | null;
    latest_assistant_reply: string | null;
    last_message_at: number | null;
    created_at: number | null;
    updated_at: number | null;
  }>;
  if (!legacySessions.length) return;

  let nextConversationSeq = Number(
    (db.prepare("SELECT COALESCE(MAX(seq), 0) AS value FROM conversation_events").get() as { value?: number } | undefined)?.value ?? 0,
  ) || 0;

  const getThread = db.prepare(
    `SELECT id, created_at
       FROM threads
      WHERE id = ?`,
  );
  const insertThread = db.prepare(
    `INSERT INTO threads (
      id, workspace_id, engine, title, thread_type, thread_subtype, session_id, archived,
      created_at, updated_at, model, effort, access_mode, plan_mode
    ) VALUES (?, ?, ?, ?, 'chat', 'requirement-analysis', ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  );
  const updateThread = db.prepare(
    `UPDATE threads
        SET workspace_id = ?,
            engine = ?,
            title = ?,
            thread_type = 'chat',
            thread_subtype = 'requirement-analysis',
            session_id = COALESCE(session_id, ?),
            archived = ?,
            updated_at = ?,
            model = COALESCE(model, ?),
            effort = COALESCE(effort, ?)
      WHERE id = ?`,
  );
  const getSession = db.prepare(
    `SELECT id, created_at
       FROM orch_requirement_analysis_sessions
      WHERE id = ?`,
  );
  const insertSession = db.prepare(
    `INSERT INTO orch_requirement_analysis_sessions (
      id, workspace_id, title, status, phase, engine, model, effort,
      runtime_thread_id, engine_session_id, latest_turn_summary,
      latest_assistant_reply, last_message_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateSession = db.prepare(
    `UPDATE orch_requirement_analysis_sessions
        SET workspace_id = ?,
            title = ?,
            status = ?,
            phase = ?,
            engine = ?,
            model = ?,
            effort = ?,
            runtime_thread_id = ?,
            engine_session_id = ?,
            latest_turn_summary = ?,
            latest_assistant_reply = ?,
            last_message_at = ?,
            updated_at = ?
      WHERE id = ?`,
  );
  const rebindMessages = db.prepare(
    `UPDATE orch_requirement_analysis_messages
        SET session_id = ?
      WHERE session_id = ?`,
  );
  const rebindCandidates = db.prepare(
    `UPDATE orch_requirement_candidate_drafts
        SET session_id = ?
      WHERE session_id = ?`,
  );
  const deleteSession = db.prepare(
    `DELETE FROM orch_requirement_analysis_sessions
      WHERE id = ?`,
  );
  const countConversationEvents = db.prepare(
    `SELECT COUNT(1) AS value
       FROM conversation_events
      WHERE thread_id = ?`,
  );
  const listLegacyMessages = db.prepare(
    `SELECT id, role, content, created_at
       FROM orch_requirement_analysis_messages
      WHERE session_id = ?
      ORDER BY created_at ASC, id ASC`,
  );
  const insertConversationEvent = db.prepare(
    `INSERT OR IGNORE INTO conversation_events (
      seq, thread_id, workspace_id, engine, type, event_json, ts
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const session of legacySessions) {
      const targetThreadId = normalizeLegacyRequirementAnalysisThreadId(session.runtime_thread_id, session.id);
      if (!targetThreadId) continue;

      const workspaceId = String(session.workspace_id ?? "").trim();
      const engine = normalizeLegacyRequirementAnalysisEngine(session.engine);
      const title = normalizeLegacyRequirementAnalysisTitle(session.title);
      const archived = session.status === "archived" ? 1 : 0;
      const createdAt = Number(session.created_at ?? Date.now()) || Date.now();
      const updatedAt = Math.max(
        Number(session.updated_at ?? 0) || 0,
        Number(session.last_message_at ?? 0) || 0,
        createdAt,
      );
      const phase = normalizeLegacyRequirementAnalysisPhase(session.phase);

      const existingThread = getThread.get(targetThreadId) as { id?: string; created_at?: number } | undefined;
      if (!existingThread) {
        insertThread.run(
          targetThreadId,
          workspaceId,
          engine,
          title,
          nullableString(session.engine_session_id),
          archived,
          createdAt,
          updatedAt,
          nullableString(session.model),
          nullableString(session.effort),
        );
      } else {
        updateThread.run(
          workspaceId,
          engine,
          title,
          nullableString(session.engine_session_id),
          archived,
          updatedAt,
          nullableString(session.model),
          nullableString(session.effort),
          targetThreadId,
        );
      }

      const existingSession = getSession.get(targetThreadId) as { id?: string; created_at?: number } | undefined;
      if (!existingSession) {
        insertSession.run(
          targetThreadId,
          workspaceId,
          title,
          archived ? "archived" : normalizeLegacyRequirementAnalysisStatus(session.status),
          phase,
          engine,
          nullableString(session.model),
          nullableString(session.effort),
          targetThreadId,
          nullableString(session.engine_session_id),
          nullableString(session.latest_turn_summary),
          nullableString(session.latest_assistant_reply),
          updatedAt,
          createdAt,
          updatedAt,
        );
      } else {
        updateSession.run(
          workspaceId,
          title,
          archived ? "archived" : normalizeLegacyRequirementAnalysisStatus(session.status),
          phase,
          engine,
          nullableString(session.model),
          nullableString(session.effort),
          targetThreadId,
          nullableString(session.engine_session_id),
          nullableString(session.latest_turn_summary),
          nullableString(session.latest_assistant_reply),
          updatedAt,
          updatedAt,
          targetThreadId,
        );
      }

      if (targetThreadId !== String(session.id ?? "").trim()) {
        rebindMessages.run(targetThreadId, session.id);
        rebindCandidates.run(targetThreadId, session.id);
        deleteSession.run(session.id);
      }

      const hasConversationEvents = Number(
        (countConversationEvents.get(targetThreadId) as { value?: number } | undefined)?.value ?? 0,
      ) > 0;
      if (hasConversationEvents) continue;

      const legacyMessages = listLegacyMessages.all(targetThreadId) as Array<{
        id: string;
        role: string | null;
        content: string | null;
        created_at: number | null;
      }>;
      for (const message of legacyMessages) {
        const normalized = mapLegacyRequirementAnalysisMessage({
          messageId: String(message.id ?? "").trim(),
          role: String(message.role ?? "").trim(),
          content: String(message.content ?? ""),
        });
        if (!normalized) continue;
        const ts = Number(message.created_at ?? updatedAt) || updatedAt;
        nextConversationSeq += 1;
        const envelope = {
          seq: nextConversationSeq,
          ts,
          threadId: targetThreadId,
          workspaceId,
          engine,
          type: normalized.type,
          payload: normalized.payload,
        };
        insertConversationEvent.run(
          envelope.seq,
          targetThreadId,
          workspaceId,
          engine,
          normalized.type,
          JSON.stringify(envelope),
          ts,
        );
      }
    }
  });

  tx();
}

function normalizeLegacyRequirementAnalysisThreadId(runtimeThreadId: string | null, sessionId: string): string {
  const runtime = String(runtimeThreadId ?? "").trim();
  if (runtime) return runtime;
  return String(sessionId ?? "").trim();
}

function normalizeLegacyRequirementAnalysisTitle(raw: string | null): string {
  const title = String(raw ?? "").trim();
  return title || "未命名需求分析";
}

function normalizeLegacyRequirementAnalysisEngine(raw: string | null): string {
  return String(raw ?? "").trim() === "claude" ? "claude" : "codex";
}

function normalizeLegacyRequirementAnalysisStatus(raw: string | null): string {
  const status = String(raw ?? "").trim();
  return status === "completed" || status === "archived" ? status : "active";
}

function normalizeLegacyRequirementAnalysisPhase(raw: string | null): string {
  const phase = String(raw ?? "").trim();
  return phase === "clarify" || phase === "split" || phase === "recommend" || phase === "confirm" || phase === "done"
    ? phase
    : "discover";
}

function mapLegacyRequirementAnalysisMessage(input: {
  messageId: string;
  role: string;
  content: string;
}): { type: string; payload: Record<string, unknown> } | null {
  if (!input.messageId || !input.content.trim()) return null;
  if (input.role === "assistant") {
    return {
      type: "item.agentMessage.completed",
      payload: {
        itemId: input.messageId,
        engineMessageId: input.messageId,
        text: input.content,
        revision: 0,
      },
    };
  }
  if (input.role === "system") {
    return {
      type: "system.notice",
      payload: {
        level: "info",
        text: input.content,
      },
    };
  }
  return {
    type: "item.userMessage.created",
    payload: {
      itemId: input.messageId,
      text: input.content,
    },
  };
}

function nullableString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

/** 运行中输入队列：item 表 + attachment 引用表 + thread 级暂停状态表（v39）。 */
function createThreadMessageQueueTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_message_queue (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      text TEXT NOT NULL DEFAULT '',
      attachments_json TEXT NOT NULL DEFAULT '[]',
      path_references_json TEXT NOT NULL DEFAULT '[]',
      input_kind TEXT NULL,
      skill_mentions_json TEXT NOT NULL DEFAULT '[]',
      send_options_json TEXT NOT NULL,
      origin_web_session_id TEXT NULL,
      enqueued_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      sent_turn_id TEXT NULL,
      failure_reason TEXT NULL,
      failure_code TEXT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_thread_message_queue_thread_pos
      ON thread_message_queue(thread_id, status, position ASC);
    CREATE UNIQUE INDEX IF NOT EXISTS uk_thread_message_queue_thread_position_active
      ON thread_message_queue(thread_id, position)
      WHERE status IN ('pending','sending');

    CREATE TABLE IF NOT EXISTS thread_message_queue_attachments (
      id TEXT PRIMARY KEY,
      queue_item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      name TEXT NULL,
      display_name TEXT NULL,
      mime TEXT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      blob_id TEXT NOT NULL,
      FOREIGN KEY(queue_item_id) REFERENCES thread_message_queue(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_thread_message_queue_attachments_item_order
      ON thread_message_queue_attachments(queue_item_id, kind, order_index ASC);

    CREATE TABLE IF NOT EXISTS thread_queue_states (
      thread_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      paused_reason TEXT NULL,
      paused_at INTEGER NULL,
      last_consumed_queue_id TEXT NULL,
      last_consumed_turn_id TEXT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_thread_queue_states_workspace_updated
      ON thread_queue_states(workspace_id, updated_at DESC);
  `);
}

/** 复用应用与工作区表结构，省略跨文件注册 FK。 */
function createThreadDraftTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_drafts (
      thread_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      path_references_json TEXT NOT NULL DEFAULT '[]',
      input_kind TEXT NULL,
      skill_mentions_json TEXT NOT NULL DEFAULT '[]',
      version INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      updated_by_web_session_id TEXT NULL,
      FOREIGN KEY(thread_id) REFERENCES threads(id) ON DELETE CASCADE${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_thread_drafts_workspace_updated
      ON thread_drafts(workspace_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS thread_draft_attachments (
      thread_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT NULL,
      mime TEXT NULL,
      size INTEGER NOT NULL,
      blob_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, attachment_id, kind),
      FOREIGN KEY(thread_id) REFERENCES thread_drafts(thread_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_thread_draft_attachments_thread_order
      ON thread_draft_attachments(thread_id, kind, order_index ASC);
  `);
}

/** 创建流程模板处理人模板表；repair 阶段也会幂等补齐。 */
function createOrchestrationAssigneeTemplateTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orch_assignee_templates (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      node_assignees_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
      ${applicationWorkspaceForeignKey(db)}
    );
    CREATE INDEX IF NOT EXISTS idx_orch_assignee_templates_workspace_workflow
      ON orch_assignee_templates(workspace_id, workflow_id, status, updated_at DESC);
  `);
}

/**
 * 创建工作区级流程执行默认值表；repair 阶段也会幂等补齐。
 * 每条流程在本工作区最多一行，因此 (workspace_id, workflow_id) 直接作为主键，不再另建索引。
 */
function createWorkflowExecutionDefaultTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orch_workflow_execution_defaults (
      workspace_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      engine TEXT NOT NULL CHECK(engine IN ('claude', 'codex')),
      model TEXT NOT NULL,
      updated_by_user_id TEXT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, workflow_id)
      ${applicationWorkspaceForeignKey(db)}
    );
  `);
}

/** 创建工作区执行 Profile 表；共享工作区 scopeId 是 sharedWorkspaceId，不加 workspace 外键。 */
function createWorkspaceExecutionProfileTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_execution_profiles (
      scope_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      profile_text TEXT NOT NULL,
      profile_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope_type, scope_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_exec_profiles_user
      ON workspace_execution_profiles(user_id);
  `);
}

/** 创建 Client 级自定义模型目录表；不同 Client 独立维护，不写入 Server。 */
function createEngineCustomModelTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS engine_custom_models (
      id TEXT PRIMARY KEY,
      engine TEXT NOT NULL CHECK(engine IN ('claude', 'codex')),
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      context_window INTEGER NULL,
      max_context_window INTEGER NULL,
      input_modalities_json TEXT NULL,
      reasoning_efforts_json TEXT NULL,
      default_reasoning_effort TEXT NULL,
      supports_fast_mode INTEGER NOT NULL DEFAULT 0,
      supports_1m_context INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(engine, model_id)
    );

    CREATE INDEX IF NOT EXISTS idx_engine_custom_models_engine_enabled
      ON engine_custom_models(engine, enabled, updated_at DESC);
  `);
}

/** 创建定时任务本地运行状态表。 */
function createScheduledTaskRuntimeStateTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_task_runtime_states (
      task_id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      last_scheduled_at INTEGER NULL,
      last_started_at INTEGER NULL,
      running_run_id TEXT NULL,
      last_workflow_instance_id TEXT NULL,
      last_config_sync_at INTEGER NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runtime_states_device
      ON scheduled_task_runtime_states(client_id, device_id, updated_at DESC);
  `);
}

/** 确保定时任务本地状态能持久化上一轮流程实例 ID。 */
function ensureScheduledTaskWorkflowInstanceColumn(db: SqliteDb): void {
  createScheduledTaskRuntimeStateTable(db);
  ensureColumn(db, "scheduled_task_runtime_states", "last_workflow_instance_id", "TEXT NULL");
}

/** 为 Prompt Snapshot 增加用途标识，区分普通节点执行与独立门禁评估。 */
function ensurePromptSnapshotPurposeColumn(db: SqliteDb): void {
  ensureColumn(db, "orch_prompt_snapshots", "purpose", "TEXT NULL");
}

/** 补齐迁移期间 queue_one 延期所需的独立调度字段。 */
function ensureScheduledTaskMigrationQueueColumns(db: SqliteDb): void {
  createScheduledTaskRuntimeStateTable(db);
  ensureColumn(db, "scheduled_task_runtime_states", "queued_scheduled_at", "INTEGER NULL");
  ensureColumn(db, "scheduled_task_runtime_states", "queued_reason", "TEXT NULL");
  ensureColumn(db, "scheduled_task_runtime_states", "queued_operation_id", "TEXT NULL");
}

/** 创建编排 Skills 规格资产表；正文索引放在 definition_json。 */
function createOrchSkillsTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orch_skills (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      definition_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)}
    );

    CREATE INDEX IF NOT EXISTS idx_orch_skills_workspace
      ON orch_skills(workspace_id, updated_at DESC);
  `);
  createOrchSkillFilesTable(db);
}

/** 创建 Skill 包文件树表，文件正文按 skill_id + rel_path 独立存储。 */
function createOrchSkillFilesTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orch_skill_files (
      skill_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      content_text TEXT NULL,
      content_base64 TEXT NULL,
      content_type TEXT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      sha256 TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(skill_id, rel_path),
      FOREIGN KEY(skill_id) REFERENCES orch_skills(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_orch_skill_files_skill
      ON orch_skill_files(skill_id, kind, rel_path);
  `);
}

/** 幂等创建编排入口列表状态缓存表。 */
function createOrchIntakeListStateTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orch_intake_list_states (
      workspace_id TEXT NOT NULL,
      intake_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      list_status TEXT NOT NULL,
      latest_instance_id TEXT NULL,
      latest_instance_status TEXT NULL,
      instance_count INTEGER NOT NULL DEFAULT 0,
      workflow_name TEXT NULL,
      progress_text TEXT NULL,
      updated_at INTEGER NOT NULL,
      rebuilt_at INTEGER NOT NULL,
      PRIMARY KEY(workspace_id, intake_id, source_kind),
      FOREIGN KEY(intake_id) REFERENCES orch_intakes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_orch_intake_list_states_workspace_source_status_updated
      ON orch_intake_list_states(workspace_id, source_kind, list_status, updated_at DESC, intake_id DESC);

    CREATE INDEX IF NOT EXISTS idx_orch_intake_list_states_workspace_source_updated
      ON orch_intake_list_states(workspace_id, source_kind, updated_at DESC, intake_id DESC);
  `);
}

/** 幂等创建编排侧栏搜索投影和状态计数缓存；FTS 只召回，权限与状态仍回表校验。 */
function createOrchestrationListSearchTables(db: SqliteDb): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS orch_intake_search_fts
      USING fts5(intake_id UNINDEXED, workspace_id UNINDEXED, source_kind UNINDEXED, title, summary, tokenize = 'trigram');

    CREATE INDEX IF NOT EXISTS idx_orch_instances_workspace_updated
      ON orch_instances(workspace_id, updated_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_orch_instances_workspace_status_updated
      ON orch_instances(workspace_id, status, updated_at DESC, id DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS orch_requirement_analysis_search_fts
      USING fts5(session_id UNINDEXED, workspace_id UNINDEXED, title, summary, tokenize = 'trigram');

    CREATE TABLE IF NOT EXISTS orch_list_status_count_cache (
      cache_key TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      list_kind TEXT NOT NULL,
      search TEXT NOT NULL DEFAULT '',
      scope_key TEXT NOT NULL DEFAULT '',
      counts_json TEXT NOT NULL,
      total_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orch_list_status_count_cache_scope
      ON orch_list_status_count_cache(workspace_id, list_kind, expires_at);
  `);
}

const ORCH_INSTANCE_SUMMARY_TABLE = "orch_instance_summaries";
const ORCH_INSTANCE_SUMMARY_WORKSPACE_INDEX = "idx_orch_instance_summaries_workspace_display";
const ORCH_INSTANCE_SUMMARY_INTAKE_INDEX = "idx_orch_instance_summaries_workspace_intake_display";
const ORCH_INSTANCE_SUMMARY_SOURCE_COLUMNS = [
  "id",
  "workspace_id",
  "workflow_id",
  "workflow_snapshot_json",
  "proposal_id",
  "intake_snapshot_json",
  "runtime_config_json",
  "status",
  "node_states_json",
  "created_at",
  "updated_at",
] as const;
const ORCH_INSTANCE_SUMMARY_WORKSPACE_INDEX_SQL = `CREATE INDEX ${ORCH_INSTANCE_SUMMARY_WORKSPACE_INDEX}
  ON ${ORCH_INSTANCE_SUMMARY_TABLE}(
    workspace_id,
    CASE
      WHEN status IN ('pending', 'running', 'paused', 'waiting-start', 'waiting-approval', 'waiting-feedback') THEN 0
      ELSE 1
    END,
    source_updated_at DESC,
    instance_id DESC
  )`;
const ORCH_INSTANCE_SUMMARY_INTAKE_INDEX_SQL = `CREATE INDEX ${ORCH_INSTANCE_SUMMARY_INTAKE_INDEX}
  ON ${ORCH_INSTANCE_SUMMARY_TABLE}(
    workspace_id,
    intake_id,
    CASE
      WHEN status IN ('pending', 'running', 'paused', 'waiting-start', 'waiting-approval', 'waiting-feedback') THEN 0
      ELSE 1
    END,
    source_updated_at DESC,
    instance_id DESC,
    status
  )`;

/** 幂等创建实例窄摘要表，并拒绝无法安全兼容的表结构漂移。 */
function createOrchInstanceSummaryTable(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ORCH_INSTANCE_SUMMARY_TABLE} (
      instance_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      intake_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'pending', 'running', 'paused', 'waiting-start', 'waiting-approval',
        'waiting-feedback', 'completed', 'failed', 'cancelled'
      )),
      source_updated_at INTEGER NOT NULL,
      summary_json TEXT NOT NULL CHECK(
        CASE WHEN json_valid(summary_json) THEN json_type(summary_json) = 'object' ELSE 0 END
      ),
      projection_version INTEGER NOT NULL CHECK(projection_version > 0),
      FOREIGN KEY(instance_id) REFERENCES orch_instances(id) ON DELETE CASCADE
    );
  `);

  const requiredColumns = [
    "instance_id",
    "workspace_id",
    "intake_id",
    "status",
    "source_updated_at",
    "summary_json",
    "projection_version",
  ];
  const missingColumns = requiredColumns.filter((column) => !tableHasColumn(db, ORCH_INSTANCE_SUMMARY_TABLE, column));
  if (missingColumns.length > 0) {
    throwProjectionMigrationError("ORCH_INSTANCE_SUMMARY_SCHEMA_DRIFT", "实例摘要投影表结构不兼容", {
      missingColumns,
    });
  }
  ensureOrchInstanceSummaryIndexes(db);
}

/** 校验两个窄摘要索引的完整 SQL，错误同名索引必须原子替换。 */
function ensureOrchInstanceSummaryIndexes(db: SqliteDb): void {
  const definitions = [
    { name: ORCH_INSTANCE_SUMMARY_WORKSPACE_INDEX, sql: ORCH_INSTANCE_SUMMARY_WORKSPACE_INDEX_SQL },
    { name: ORCH_INSTANCE_SUMMARY_INTAKE_INDEX, sql: ORCH_INSTANCE_SUMMARY_INTAKE_INDEX_SQL },
  ];
  const repairs = definitions.filter((definition) => {
    const existingSql = String((db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
    ).get(definition.name) as { sql?: string | null } | undefined)?.sql ?? "");
    return normalizeSchemaSql(existingSql) !== normalizeSchemaSql(definition.sql);
  });
  if (repairs.length === 0) return;
  db.transaction(() => {
    for (const repair of repairs) {
      db.exec(`DROP INDEX IF EXISTS ${repair.name}`);
      db.exec(repair.sql);
    }
  })();
}

/** 逐行回填实例摘要，限制每次进入 JS 的详情 JSON 只有一条。 */
function backfillOrchInstanceSummaries(db: SqliteDb): void {
  if (!prepareOrchInstanceSummarySourceRead(db)) return;
  let lastId = "";
  while (true) {
    const row = db.prepare(
      `SELECT id, workspace_id, workflow_id, workflow_snapshot_json,
              proposal_id, intake_snapshot_json, runtime_config_json,
              status, node_states_json, created_at, updated_at
       FROM orch_instances
       WHERE id > ?
       ORDER BY id ASC
       LIMIT 1`,
    ).get(lastId) as Record<string, unknown> | undefined;
    if (!row) return;
    const instance = parseOrchInstanceSummarySourceRow(row);
    db.transaction(() => upsertOrchInstanceSummaryProjection(db, instance))();
    lastId = String(row.id);
  }
}

/** 使用已回填的窄摘要一次性重建需求列表状态与搜索投影。 */
function rebuildOrchIntakeListProjections(db: SqliteDb): void {
  if (!tableExists(db, "orch_intakes")) {
    const hasInstance = Boolean(db.prepare("SELECT 1 AS found FROM orch_instances LIMIT 1").get());
    if (hasInstance) {
      throwProjectionMigrationError("ORCH_INTAKE_LIST_SOURCE_SCHEMA_DRIFT", "需求列表源表不存在", {
        missingObjects: ["orch_intakes"],
      });
    }
    return;
  }
  const hasIntake = Boolean(db.prepare("SELECT 1 AS found FROM orch_intakes LIMIT 1").get());
  if (!hasIntake) return;
  const requiredColumns = ["id", "workspace_id", "intake_json", "created_at", "updated_at"];
  const missingColumns = requiredColumns.filter((column) => !tableHasColumn(db, "orch_intakes", column));
  if (missingColumns.length > 0) {
    throwProjectionMigrationError("ORCH_INTAKE_LIST_SOURCE_SCHEMA_DRIFT", "需求列表源表结构不兼容", {
      missingColumns,
    });
  }
  const summaries = new OrchInstanceSummaryProjectionReader(db);
  const listStates = new OrchIntakeListStateRepo(db, summaries);
  const rows = db.prepare(
    "SELECT DISTINCT workspace_id FROM orch_intakes ORDER BY workspace_id ASC",
  ).all() as Array<{ workspace_id?: string }>;
  for (const row of rows) {
    const workspaceId = String(row.workspace_id ?? "").trim();
    if (!workspaceId) continue;
    listStates.rebuildWorkspace({ workspaceId: workspaceId as any, sourceKind: "requirement" });
    listStates.rebuildWorkspace({ workspaceId: workspaceId as any, sourceKind: "scheduled_task" });
  }
}

/** 校验摘要与事实标量完全一致；发现缺失或损坏时阻止 Client 启动。 */
function validateOrchInstanceSummaryProjection(db: SqliteDb): void {
  if (!tableExists(db, "orch_instances") || !tableExists(db, ORCH_INSTANCE_SUMMARY_TABLE)) return;
  const invalidJson = db.prepare(
    `SELECT instance_id, projection_version
     FROM ${ORCH_INSTANCE_SUMMARY_TABLE}
     WHERE projection_version <> ?
        OR CASE
             WHEN json_valid(summary_json) THEN json_type(summary_json) <> 'object'
             ELSE 1
           END
     LIMIT 1`,
  ).get(ORCH_INSTANCE_SUMMARY_PROJECTION_VERSION) as { instance_id?: string; projection_version?: number } | undefined;
  if (invalidJson) {
    throwProjectionMigrationError("ORCH_INSTANCE_SUMMARY_PROJECTION_INVALID", "实例摘要投影版本或 JSON 非法", {
      instanceId: String(invalidJson.instance_id ?? "") || null,
      projectionVersion: Number(invalidJson.projection_version ?? 0),
    });
  }

  if (prepareOrchInstanceSummarySourceRead(db)) {
    const invalidSource = db.prepare(
      `SELECT id AS instance_id
       FROM orch_instances
       WHERE CASE
               WHEN json_valid(intake_snapshot_json) THEN json_type(intake_snapshot_json) <> 'object'
               ELSE 1
             END
       LIMIT 1`,
    ).get() as { instance_id?: string } | undefined;
    if (invalidSource) {
      throwProjectionMigrationError("ORCH_INSTANCE_SUMMARY_SOURCE_JSON_INVALID", "实例摘要源 JSON 非法", {
        instanceId: String(invalidSource.instance_id ?? "") || null,
        field: "intake_snapshot_json",
      });
    }

    const mismatch = db.prepare(
      `SELECT oi.id AS instance_id, s.projection_version
       FROM orch_instances oi
       LEFT JOIN ${ORCH_INSTANCE_SUMMARY_TABLE} s ON s.instance_id = oi.id
       WHERE s.instance_id IS NULL
          OR s.workspace_id IS NOT oi.workspace_id
          OR s.intake_id IS NOT json_extract(oi.intake_snapshot_json, '$.id')
          OR s.status IS NOT oi.status
          OR s.source_updated_at IS NOT oi.updated_at
          OR json_extract(s.summary_json, '$.id') IS NOT s.instance_id
          OR json_extract(s.summary_json, '$.workspaceId') IS NOT s.workspace_id
          OR json_extract(s.summary_json, '$.intakeId') IS NOT s.intake_id
          OR json_extract(s.summary_json, '$.status') IS NOT s.status
          OR json_extract(s.summary_json, '$.updatedAt') IS NOT s.source_updated_at
          OR json_extract(s.summary_json, '$.runSummary.instanceId') IS NOT s.instance_id
          OR json_extract(s.summary_json, '$.runSummary.artifactCount') IS NOT 0
          OR json_type(s.summary_json, '$.sharedContext') IS NOT NULL
          OR json_type(s.summary_json, '$.readOnly') IS NOT NULL
       LIMIT 1`,
    ).get() as { instance_id?: string; projection_version?: number } | undefined;
    if (mismatch) {
      throwProjectionMigrationError("ORCH_INSTANCE_SUMMARY_PROJECTION_INVALID", "实例摘要投影与事实不一致", {
        instanceId: String(mismatch.instance_id ?? "") || null,
        projectionVersion: Number(mismatch.projection_version ?? 0),
      });
    }
  }

  const orphan = db.prepare(
    `SELECT s.instance_id
     FROM ${ORCH_INSTANCE_SUMMARY_TABLE} s
     LEFT JOIN orch_instances oi ON oi.id = s.instance_id
     WHERE oi.id IS NULL
     LIMIT 1`,
  ).get() as { instance_id?: string } | undefined;
  if (orphan) {
    throwProjectionMigrationError("ORCH_INSTANCE_SUMMARY_PROJECTION_INVALID", "实例摘要投影存在孤立记录", {
      instanceId: String(orphan.instance_id ?? "") || null,
    });
  }
}

/** 空实例表无需详情列；有事实行时则要求完整源 schema，禁止带数据跳过回填。 */
function prepareOrchInstanceSummarySourceRead(db: SqliteDb): boolean {
  const hasInstance = Boolean(db.prepare("SELECT 1 AS found FROM orch_instances LIMIT 1").get());
  if (!hasInstance) return false;
  const missingColumns = ORCH_INSTANCE_SUMMARY_SOURCE_COLUMNS.filter(
    (column) => !tableHasColumn(db, "orch_instances", column),
  );
  if (missingColumns.length > 0) {
    throwProjectionMigrationError("ORCH_INSTANCE_SUMMARY_SOURCE_SCHEMA_DRIFT", "实例摘要源表结构不兼容", {
      missingColumns,
    });
  }
  return true;
}

/** 构造带稳定 code/details 的迁移错误，避免日志携带详情 JSON。 */
function throwProjectionMigrationError(code: string, message: string, details: Record<string, unknown>): never {
  const error = new Error(message) as Error & { code: string; details: Record<string, unknown> };
  error.code = code;
  error.details = details;
  throw error;
}

/** 校验并幂等修复实例需求关联与展示顺序覆盖索引。 */
function ensureOrchInstanceIntakeDisplayIndex(db: SqliteDb): void {
  const requiredColumns = ["id", "workspace_id", "intake_snapshot_json", "status", "updated_at"];
  if (!tableExists(db, "orch_instances")
    || requiredColumns.some((column) => !tableHasColumn(db, "orch_instances", column))) return;

  const existingSql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME) as { sql?: string | null } | undefined)?.sql ?? "");
  if (normalizeSchemaSql(existingSql) === normalizeSchemaSql(ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_SQL)) return;

  db.transaction(() => {
    db.exec(`DROP INDEX IF EXISTS ${ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_NAME};`);
    db.exec(ORCH_INSTANCE_INTAKE_DISPLAY_INDEX_SQL);
  })();
}

/** 幂等修复：草稿 @ 路径引用 JSON 列。 */
function ensureThreadDraftPathReferencesColumn(db: SqliteDb): void {
  ensureColumn(db, "thread_drafts", "path_references_json", "TEXT NOT NULL DEFAULT '[]'");
}

/** 幂等修复：队列项 @ 路径引用 JSON 列。 */
function ensureThreadMessageQueuePathReferencesColumn(db: SqliteDb): void {
  ensureColumn(db, "thread_message_queue", "path_references_json", "TEXT NOT NULL DEFAULT '[]'");
}

/** 幂等补齐草稿与队列的输入语义列，历史行继续保留 input_kind=NULL。 */
function ensureThreadInputContractColumns(db: SqliteDb): void {
  ensureColumn(db, "thread_drafts", "input_kind", "TEXT NULL");
  ensureColumn(db, "thread_drafts", "skill_mentions_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "thread_message_queue", "input_kind", "TEXT NULL");
  ensureColumn(db, "thread_message_queue", "skill_mentions_json", "TEXT NOT NULL DEFAULT '[]'");
}

/** 归一化 provider 并去重已有 active；零 active 代表显式停用，重启不得补选。 */
function ensureEngineKeyProviderSchema(db: SqliteDb): void {
  if (!tableExists(db, "engine_keys")) return;
  const claudeProviderIds = Object.values(ENGINE_MODEL_PROVIDERS)
    .filter((provider) => provider.engines.includes("claude"))
    .map((provider) => provider.providerId);
  const codexProviderIds = Object.values(ENGINE_MODEL_PROVIDERS)
    .filter((provider) => provider.engines.includes("codex"))
    .map((provider) => provider.providerId);
  if (!claudeProviderIds.length || !codexProviderIds.length) {
    throw new Error("引擎供应商目录缺少 Claude 或 Codex 默认配置");
  }
  const claudeProviderPlaceholders = claudeProviderIds.map(() => "?").join(", ");
  const codexProviderPlaceholders = codexProviderIds.map(() => "?").join(", ");

  ensureColumn(db, "engine_keys", "provider_id", "TEXT NULL");
  db.exec(`
    UPDATE engine_keys
    SET provider_id = CASE
      WHEN engine = 'codex' THEN 'openai'
      WHEN engine = 'claude' AND lower(coalesce(base_url, '')) LIKE '%deepseek%' THEN 'deepseek'
      WHEN engine = 'claude' THEN 'anthropic'
      ELSE 'anthropic'
    END
    WHERE provider_id IS NULL OR trim(provider_id) = '';
  `);

  db.prepare(`
    UPDATE engine_keys
    SET provider_id = 'anthropic'
    WHERE engine = 'claude' AND provider_id NOT IN (${claudeProviderPlaceholders})
  `).run(...claudeProviderIds);

  db.prepare(`
    UPDATE engine_keys
    SET provider_id = 'openai'
    WHERE engine = 'codex' AND provider_id NOT IN (${codexProviderPlaceholders})
  `).run(...codexProviderIds);

  db.exec(`
    UPDATE engine_keys
    SET is_active = CASE
      WHEN id = (
        SELECT next_active.id
        FROM engine_keys AS next_active
        WHERE next_active.engine = engine_keys.engine
          AND next_active.provider_id = engine_keys.provider_id
          AND next_active.is_active = 1
        ORDER BY next_active.is_active DESC, next_active.updated_at DESC, next_active.created_at DESC, next_active.id DESC
        LIMIT 1
      ) THEN 1
      ELSE 0
    END
    WHERE engine IN ('claude', 'codex');

    CREATE INDEX IF NOT EXISTS idx_engine_keys_engine_provider_active
      ON engine_keys(engine, provider_id, is_active DESC);
  `);
}

/** v42：会话置顶时间，用于列表持久化排序。 */
function ensureThreadPinnedSchema(db: SqliteDb): void {
  ensureColumn(db, "threads", "archived", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "threads", "pinned_at", "INTEGER NULL");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_threads_workspace_pinned_created
      ON threads(workspace_id, archived, pinned_at DESC, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_workspace_pinned_activity
      ON threads(workspace_id, archived, pinned_at DESC, updated_at DESC, created_at DESC, id DESC);
  `);
  if (tableHasColumn(db, "threads", "thread_type")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_threads_workspace_type_pinned_created
        ON threads(workspace_id, thread_type, archived, pinned_at DESC, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_workspace_type_pinned_activity
        ON threads(workspace_id, thread_type, archived, pinned_at DESC, updated_at DESC, created_at DESC, id DESC);
    `);
  }
}

/** 幂等创建会话列表最近活动排序索引。 */
function ensureThreadListActivitySortIndex(db: SqliteDb): void {
  ensureColumn(db, "threads", "archived", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "threads", "pinned_at", "INTEGER NULL");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_threads_workspace_pinned_updated
      ON threads(workspace_id, archived, pinned_at DESC, updated_at DESC, id DESC);
  `);
}

/** 幂等创建共享会话 ACL 字段；仅 Host 路由使用，普通本地会话保持 NULL。 */
function ensureSharedThreadAclColumns(db: SqliteDb): void {
  ensureColumn(db, "threads", "owner_user_id", "TEXT NULL");
  ensureColumn(db, "threads", "shared_workspace_id", "TEXT NULL");
  ensureColumn(db, "threads", "shared_visibility", "TEXT NULL");
  ensureColumn(db, "threads", "shared_participant_user_ids_json", "TEXT NULL");
  ensureColumn(db, "threads", "shared_acl_updated_at", "INTEGER NULL");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_threads_shared_workspace_updated
      ON threads(workspace_id, shared_workspace_id, archived, pinned_at DESC, updated_at DESC, id DESC)
      WHERE shared_workspace_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_threads_shared_workspace_owner
      ON threads(shared_workspace_id, owner_user_id, updated_at DESC, id DESC)
      WHERE shared_workspace_id IS NOT NULL;
  `);
}

/** 幂等创建会话分组表和会话分组查询索引。 */
function createThreadGroupTables(db: SqliteDb): void {
  ensureColumn(db, "threads", "group_id", "TEXT NULL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_groups (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      shared_workspace_id TEXT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      created_by_user_id TEXT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${applicationWorkspaceForeignKey(db)}
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uk_thread_groups_workspace_name
      ON thread_groups(workspace_id, name_key)
      WHERE shared_workspace_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uk_thread_groups_shared_name
      ON thread_groups(workspace_id, shared_workspace_id, name_key)
      WHERE shared_workspace_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_thread_groups_workspace_updated
      ON thread_groups(workspace_id, shared_workspace_id, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_workspace_group_activity
      ON threads(workspace_id, group_id, archived, pinned_at DESC, updated_at DESC, id DESC);
  `);
}

function createOrchestrationRuntimeExtensionTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orch_prompt_snapshots (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL DEFAULT 1,
      thread_id TEXT NULL,
      turn_id TEXT NULL,
      engine TEXT NOT NULL,
      model TEXT NULL,
      effort TEXT NULL,
      purpose TEXT NULL,
      prompt_envelope_json TEXT NULL,
      system_message TEXT NOT NULL,
      developer_message TEXT NULL,
      user_message TEXT NOT NULL,
      rendered_input_preview TEXT NOT NULL,
      runtime_policy_json TEXT NOT NULL,
      tool_registry_json TEXT NULL,
      knowledge_catalogs_json TEXT NULL,
      artifact_input_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(instance_id) REFERENCES orch_instances(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS orch_gate_evaluation_runs (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_attempt_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      criteria_hash TEXT NOT NULL,
      artifact_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
      status_version INTEGER NOT NULL DEFAULT 1,
      active_call_id TEXT NULL,
      active_thread_id TEXT NULL,
      active_turn_id TEXT NULL,
      retry_ordinal INTEGER NOT NULL DEFAULT 0,
      prompt_snapshot_id TEXT NULL,
      results_json TEXT NULL,
      last_error_code TEXT NULL,
      last_error TEXT NULL,
      started_at INTEGER NULL,
      finished_at INTEGER NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(instance_id) REFERENCES orch_instances(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orch_gate_evaluation_runs_instance_status
      ON orch_gate_evaluation_runs(instance_id, status, updated_at ASC);
    CREATE INDEX IF NOT EXISTS idx_orch_prompt_snapshots_instance_node_created
      ON orch_prompt_snapshots(instance_id, node_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS orch_artifact_files (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      file_key TEXT NULL,
      file_role TEXT NOT NULL DEFAULT 'contract',
      format TEXT NULL,
      contract_key TEXT NULL,
      summary TEXT NULL,
      validation_status TEXT NULL,
      rel_path TEXT NOT NULL,
      staging_path TEXT NULL,
      published_path TEXT NULL,
      status TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(artifact_id) REFERENCES orch_artifacts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orch_artifact_files_artifact_created
      ON orch_artifact_files(artifact_id, created_at ASC);
  `);
  ensureArtifactFileContractColumns(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS orch_artifact_fields (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      result_name TEXT NOT NULL,
      field_key TEXT NOT NULL,
      label TEXT NULL,
      value_type TEXT NOT NULL,
      value_json TEXT NOT NULL,
      value_preview TEXT NULL,
      required INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL,
      validation_status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(artifact_id) REFERENCES orch_artifacts(id) ON DELETE CASCADE,
      UNIQUE(artifact_id, field_key)
    );
    CREATE INDEX IF NOT EXISTS idx_orch_artifact_fields_artifact
      ON orch_artifact_fields(artifact_id);
    CREATE INDEX IF NOT EXISTS idx_orch_artifact_fields_instance_node_result
      ON orch_artifact_fields(instance_id, node_id, result_name, field_key);

    CREATE TABLE IF NOT EXISTS orch_node_context_resolutions (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      context_json TEXT NOT NULL,
      error_json TEXT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(instance_id) REFERENCES orch_instances(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_orch_node_context_resolutions_instance_node
      ON orch_node_context_resolutions(instance_id, node_id, attempt_no DESC, created_at DESC);
  `);
}

/** 幂等补齐 artifact 文件契约列，兼容旧库已经存在 orch_artifact_files 的情况。 */
function ensureArtifactFileContractColumns(db: SqliteDb): void {
  ensureColumn(db, "orch_artifact_files", "file_key", "TEXT NULL");
  ensureColumn(db, "orch_artifact_files", "file_role", "TEXT NOT NULL DEFAULT 'contract'");
  ensureColumn(db, "orch_artifact_files", "format", "TEXT NULL");
  ensureColumn(db, "orch_artifact_files", "contract_key", "TEXT NULL");
  ensureColumn(db, "orch_artifact_files", "summary", "TEXT NULL");
  ensureColumn(db, "orch_artifact_files", "validation_status", "TEXT NULL");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_orch_artifact_files_artifact_key
      ON orch_artifact_files(artifact_id, file_key)
      WHERE file_key IS NOT NULL;
  `);
}

function ensureColumn(db: SqliteDb, table: string, column: string, definition: string): void {
  if (tableHasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

function tableExists(db: SqliteDb, table: string): boolean {
  const row = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { found?: number } | undefined;
  return Boolean(row);
}

function tableHasColumn(db: SqliteDb, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return rows.some((row) => String(row.name ?? "").trim() === column);
}

