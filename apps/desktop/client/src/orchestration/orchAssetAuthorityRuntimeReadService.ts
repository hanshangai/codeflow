import type {
  KnowledgeBundleDefinition,
  KnowledgeBundleId,
  OrchAssetType,
  OrchestrationRuntimeAssetDefinitionByType,
  RoleDefinition,
  RoleId,
  SkillDefinition,
  SkillId,
  ToolsetDefinition,
  ToolsetId,
  ThreadId,
  WorkflowDefinition,
  WorkflowId,
  WorkspaceId,
} from "@codeflowai/shared";

import type { ClientDb } from "../db/clientDb.js";
import { OrchRequirementAnalysisSessionRepoError, type RequirementAnalysisWorkspaceScopeRow } from "../db/repos/orchRequirementAnalysisSessionRepo.js";
import { isLocalOrchestrationExecutionFacts } from "../db/repos/orchInstanceRepo.js";
import { isDesktopLocalAssetWorkspace } from "./desktopBuiltinAssetService.js";

type LegacyDefinitionByType = {
  role: RoleDefinition;
  workflow: WorkflowDefinition;
  knowledge_bundle: KnowledgeBundleDefinition;
  toolset: ToolsetDefinition;
  skill: SkillDefinition;
};

type LegacyRuntimeReader = {
  withReadSnapshot?<T>(read: () => T, workspaceId?: WorkspaceId): T;
  listAssets<T extends OrchAssetType>(
    workspaceId: WorkspaceId,
    assetType: T,
  ): Array<OrchAssetAuthorityRuntimeAsset<T>>;
  getAsset<T extends OrchAssetType>(
    workspaceId: WorkspaceId,
    assetType: T,
    assetId: string,
  ): OrchAssetAuthorityRuntimeAsset<T> | null;
};

export type OrchAssetRuntimeRoot = { assetType: OrchAssetType; assetId: string };

export type OrchAssetAuthorityRuntimeAsset<T extends OrchAssetType> = {
  assetType: T;
  assetId: string;
  definition: OrchestrationRuntimeAssetDefinitionByType[T];
  source: { authorityMode: "legacy"; createdAt: number; updatedAt: number };
};

export type OrchAssetAuthorityRuntimeReadSession = {
  readonly authorityMode: "legacy";
  listAssets<T extends OrchAssetType>(assetType: T): Array<OrchAssetAuthorityRuntimeAsset<T>>;
  getAsset<T extends OrchAssetType>(assetType: T, assetId: string): OrchAssetAuthorityRuntimeAsset<T> | null;
};

export class OrchAssetAuthorityRuntimeReadError extends Error {
  /** 本地工作区身份或完整定义非法时显式失败。 */
  constructor(readonly code: "ASSET_RUNTIME_WORKSPACE_INVALID" | "ASSET_LEGACY_RUNTIME_DATA_INVALID", message: string) {
    super(message);
    this.name = "OrchAssetAuthorityRuntimeReadError";
  }
}

/** 仅通过已有工作区仓储读取本地内置与自定义资产。 */
export class OrchAssetAuthorityRuntimeReadService {
  private readonly listAssets: LegacyRuntimeReader["listAssets"];
  private readonly getAsset: LegacyRuntimeReader["getAsset"];
  private readonly withReadSnapshot: <T>(read: () => T, workspaceId?: WorkspaceId) => T;

  /** 固定原仓储方法和接收者，不装配网络或缓存来源。 */
  constructor(reader: LegacyRuntimeReader) {
    const listAssets = reader?.listAssets, getAsset = reader?.getAsset;
    if (typeof listAssets !== "function" || typeof getAsset !== "function") {
      throw new Error("本地资产运行读取配置非法");
    }
    this.listAssets = listAssets.bind(reader);
    this.getAsset = getAsset.bind(reader);
    this.withReadSnapshot = reader.withReadSnapshot?.bind(reader) ?? (read => read());
  }

  /** 整张启动资产图复用同一工作区 SQLite 只读快照。 */
  withWorkspace<T>(workspaceId: WorkspaceId, read: (session: OrchAssetAuthorityRuntimeReadSession) => T, root?: OrchAssetRuntimeRoot): T {
    const session = this.openWorkspace(workspaceId, root);
    return this.withReadSnapshot(() => read(session), workspaceId);
  }

  /** 会话固定工作区；root 保留原调用接口，资产缺失由依赖读取边界判定。 */
  openWorkspace(runtimeWorkspaceId: WorkspaceId, _root?: OrchAssetRuntimeRoot): OrchAssetAuthorityRuntimeReadSession {
    const workspaceId = requiredWorkspaceId(runtimeWorkspaceId);
    return {
      authorityMode: "legacy",
      listAssets: type => this.listAssets(workspaceId, type),
      getAsset: (type, id) => this.getAsset(workspaceId, type, id),
    };
  }
}

/** Creates the legacy half of the authority reader from the existing ClientDb ownership boundary. */
export function createClientDbOrchAssetLegacyRuntimeReader(
  db: Pick<ClientDb, "orchRoles" | "orchWorkflows" | "orchKnowledgeBundles" | "orchToolsets" | "orchSkills"> & Partial<Pick<ClientDb, "db" | "forWorkspace">>,
  options?: { requireCompleteDefinitions?: boolean },
): LegacyRuntimeReader {
  const strict = options?.requireCompleteDefinitions ? { requireCompleteDefinition: true } : undefined;
  const roles = snapshotLegacyRepo<RoleDefinition, RoleId>(db?.orchRoles, "角色", strict);
  const workflows = snapshotLegacyRepo<WorkflowDefinition, WorkflowId>(db?.orchWorkflows, "工作流", strict);
  const knowledgeBundles = snapshotLegacyRepo<KnowledgeBundleDefinition, KnowledgeBundleId>(
    db?.orchKnowledgeBundles,
    "知识包",
    strict,
  );
  const toolsets = snapshotLegacyRepo<ToolsetDefinition, ToolsetId>(db?.orchToolsets, "工具集", strict);
  const skills = snapshotLegacyRepo<SkillDefinition, SkillId>(db?.orchSkills, "Skill",
    options?.requireCompleteDefinitions ? { requireCompletePackage: true } : undefined);
  /** 产品入口固定可信W；仅手工提供的原应用仓储适配器沿已有边界读取。 */
  const workspaceRepos = (workspaceId: WorkspaceId): SnapshotLegacyRepos => {
    if (!db.forWorkspace) return { roles, workflows, knowledgeBundles, toolsets, skills };
    const view = db.forWorkspace(workspaceId);
    return {
      roles: snapshotLegacyRepo(view.orchRoles, "角色", strict),
      workflows: snapshotLegacyRepo(view.orchWorkflows, "工作流", strict),
      knowledgeBundles: snapshotLegacyRepo(view.orchKnowledgeBundles, "知识包", strict),
      toolsets: snapshotLegacyRepo(view.orchToolsets, "工具集", strict),
      skills: snapshotLegacyRepo(view.orchSkills, "Skill", options?.requireCompleteDefinitions ? { requireCompletePackage: true } : undefined),
    };
  };
  return {
    /** 整图读取固定W的真实同步事务，多个Repo复用同一快照。 */
    withReadSnapshot: db.db ? (read, workspaceId) => {
      if (db.forWorkspace) return db.forWorkspace(requiredWorkspaceId(workspaceId)).db.transaction(read)();
      return db.db!.transaction(read)();
    } : undefined,
    /** Lists one existing workspace-scoped legacy repository and removes presentation timestamps. */
    listAssets<T extends OrchAssetType>(workspaceId: WorkspaceId, assetType: T) {
      const definitions = listLegacyDefinitions(
        workspaceRepos(workspaceId),
        workspaceId,
        assetType,
      );
      return definitions.map((definition) => toLegacyRuntimeAsset(workspaceId, assetType, definition)) as Array<
        OrchAssetAuthorityRuntimeAsset<T>
      >;
    },
    /** Gets one legacy definition and rejects cross-workspace or malformed runtime data. */
    getAsset<T extends OrchAssetType>(workspaceId: WorkspaceId, assetType: T, assetId: string) {
      const definition = getLegacyDefinition(
        workspaceRepos(workspaceId),
        assetType,
        assetId,
      );
      return definition ? toLegacyRuntimeAsset(workspaceId, assetType, definition) : null;
    },
  };
}

type SnapshotLegacyRepo<T, TId extends string> = {
  listByWorkspace(workspaceId: WorkspaceId): T[];
  get(id: TId): T | null;
};

type SnapshotLegacyRepos = {
  roles: SnapshotLegacyRepo<RoleDefinition, RoleId>;
  workflows: SnapshotLegacyRepo<WorkflowDefinition, WorkflowId>;
  knowledgeBundles: SnapshotLegacyRepo<KnowledgeBundleDefinition, KnowledgeBundleId>;
  toolsets: SnapshotLegacyRepo<ToolsetDefinition, ToolsetId>;
  skills: SnapshotLegacyRepo<SkillDefinition, SkillId>;
};

/** Captures one legacy repository's two read methods once. */
function snapshotLegacyRepo<T, TId extends string>(
  repo: { listByWorkspace?: unknown; get?: unknown } | null | undefined,
  label: string,
  readOptions?: { requireCompleteDefinition?: boolean; requireCompletePackage?: boolean },
): SnapshotLegacyRepo<T, TId> {
  const listByWorkspace = repo?.listByWorkspace;
  const get = repo?.get;
  if (typeof listByWorkspace !== "function" || typeof get !== "function") {
    throw new Error(`${label} legacy 仓储配置非法`);
  }
  return {
    /** 严格模式逐项取完整定义，避免列表归一化隐藏损坏或遗漏的依赖。 */
    listByWorkspace(workspaceId) {
      const items = listByWorkspace.call(repo, workspaceId) as Array<T & { id: TId }>;
      return readOptions ? items.map(item => get.call(repo, item.id, readOptions) as T) : items;
    },
    /** 完整性要求只由可信装配入口选择，不接受 renderer 覆盖。 */
    get: id => get.call(repo, id, readOptions) as T | null,
  };
}

/** 按持久归属选本机权威；共享线程或历史实例的任一共享标记均保留 Server 边界。 */
export function isDesktopLocalAssetExecution(clientId: string, workspaces: ReadonlyMap<WorkspaceId, string>, target: {
  workspaceId: WorkspaceId;
  sharedWorkspaceId?: string | null;
  sharedContext?: { sharedWorkspaceId?: string } | null;
  intakeSnapshot?: { workspaceScope?: { scopeType: string; scopeId: string } | null; sharedContext?: { sharedWorkspaceId?: string } | null };
  runtimeConfig?: { executionProfileScope?: { scopeType: string; scopeId: string } | null } | null;
} | null | undefined): boolean {
  return Boolean(target && !target.sharedWorkspaceId && !target.sharedContext?.sharedWorkspaceId
    && (!("intakeSnapshot" in target) || isLocalOrchestrationExecutionFacts(target))
    && ("intakeSnapshot" in target || target.runtimeConfig?.executionProfileScope?.scopeType !== "shared_workspace")
    && isDesktopLocalAssetWorkspace(clientId, workspaces, target.workspaceId));
}

/** 线程归属复用持久 RA 或父实例绑定；缺失或未知归属不开放本机执行及事件桥。 */
export function isDesktopLocalThreadAssetExecution(clientId: string, workspaces: ReadonlyMap<WorkspaceId, string>,
  db: Pick<ClientDb, "threads" | "orchInstances" | "orchRequirementAnalysisSessions">, threadId: ThreadId): boolean {
  const thread = db.threads.get(threadId);
  if (!thread || !isDesktopLocalAssetWorkspace(clientId, workspaces, thread.workspaceId)) return false;
  if (thread.threadSubtype === "requirement-analysis") {
    const session = db.orchRequirementAnalysisSessions.listWorkspaceScopeRows(thread.workspaceId, threadId)[0];
    return isDesktopLocalRequirementThread(thread, session) && isDesktopLocalAssetExecution(clientId, workspaces, thread);
  }
  if (!isDesktopLocalAssetExecution(clientId, workspaces, thread)) return false;
  if (thread.threadSubtype === "node" || thread.threadSubtype === "node-discussion") {
    return listDesktopLocalNodeThreadIds(clientId, workspaces, db, thread.workspaceId, threadId).includes(threadId);
  }
  return true;
}

/** 汇总持久 RA 的明确本机归属；严格解析全部相关行，禁止分页或查询条件隐藏损坏。 */
export function listDesktopLocalRequirementThreadIds(clientId: string, workspaces: ReadonlyMap<WorkspaceId, string>,
  db: Pick<ClientDb, "threads" | "orchRequirementAnalysisSessions">, workspaceId: WorkspaceId): ThreadId[] {
  if (!isDesktopLocalAssetWorkspace(clientId, workspaces, workspaceId)) return [];
  const allowed: ThreadId[] = [];
  for (const session of db.orchRequirementAnalysisSessions.listWorkspaceScopeRows(workspaceId)) {
    const thread = db.threads.get(session.id as unknown as ThreadId);
    if (thread?.threadSubtype === "requirement-analysis" && isDesktopLocalRequirementThread(thread, session)
      && isDesktopLocalAssetExecution(clientId, workspaces, thread)) allowed.push(thread.id);
  }
  return allowed;
}

/** 已知记录必须维持同 ID 与精确工作区；只比较仓储已解析的范围，不另定义归属语义。 */
function isDesktopLocalRequirementThread(thread: { id: ThreadId; workspaceId: WorkspaceId }, session: RequirementAnalysisWorkspaceScopeRow | undefined): boolean {
  if (!session) return false;
  if (String(session.id) !== String(thread.id) || session.runtimeThreadId !== thread.id || session.workspaceId !== thread.workspaceId) {
    throw new OrchRequirementAnalysisSessionRepoError("ORCH_REQUIREMENT_ANALYSIS_SCOPE_CONFLICT", { sessionId: String(session.id), workspaceId: String(thread.workspaceId) });
  }
  return session.workspaceScope?.scopeType === "local_workspace";
}

/** 汇总全部父实例的当前、讨论和历史节点；严格归属损坏时抛错，禁止跳过共享父。 */
export function listDesktopLocalNodeThreadIds(clientId: string, workspaces: ReadonlyMap<WorkspaceId, string>,
  db: Pick<ClientDb, "orchInstances">, workspaceId: WorkspaceId, threadId?: ThreadId): ThreadId[] {
  if (!isDesktopLocalAssetWorkspace(clientId, workspaces, workspaceId)) return [];
  const allowed = new Map<ThreadId, boolean>();
  for (const instance of db.orchInstances.listByWorkspace(workspaceId, { strictScope: true, threadId })) {
    const local = isDesktopLocalAssetExecution(clientId, workspaces, instance);
    for (const state of Object.values(instance.nodeStates ?? {})) {
      for (const threadId of [state.threadId, state.discussionThreadId, ...state.previousThreadIds ?? []]) {
        if (threadId) allowed.set(threadId, (allowed.get(threadId) ?? true) && local);
      }
    }
  }
  return [...allowed].filter(([, local]) => local).map(([threadId]) => threadId);
}

/** Selects one legacy list without constructing a parallel repository abstraction. */
function listLegacyDefinitions<T extends OrchAssetType>(
  repos: SnapshotLegacyRepos,
  workspaceId: WorkspaceId,
  assetType: T,
): Array<LegacyDefinitionByType[T]> {
  switch (assetType) {
    case "role": return repos.roles.listByWorkspace(workspaceId) as Array<LegacyDefinitionByType[T]>;
    case "workflow": return repos.workflows.listByWorkspace(workspaceId) as Array<LegacyDefinitionByType[T]>;
    case "knowledge_bundle": return repos.knowledgeBundles.listByWorkspace(workspaceId) as Array<LegacyDefinitionByType[T]>;
    case "toolset": return repos.toolsets.listByWorkspace(workspaceId) as Array<LegacyDefinitionByType[T]>;
    case "skill": return repos.skills.listByWorkspace(workspaceId) as Array<LegacyDefinitionByType[T]>;
    default: throw legacyDataInvalid("legacy 资产类型非法");
  }
}

/** Selects one legacy definition by canonical asset type. */
function getLegacyDefinition<T extends OrchAssetType>(
  repos: SnapshotLegacyRepos,
  assetType: T,
  assetId: string,
): LegacyDefinitionByType[T] | null {
  const normalizedAssetId = requiredText(assetId, "assetId");
  switch (assetType) {
    case "role": return repos.roles.get(normalizedAssetId as RoleId) as LegacyDefinitionByType[T] | null;
    case "workflow": return repos.workflows.get(normalizedAssetId as WorkflowId) as LegacyDefinitionByType[T] | null;
    case "knowledge_bundle": return repos.knowledgeBundles.get(normalizedAssetId as KnowledgeBundleId) as LegacyDefinitionByType[T] | null;
    case "toolset": return repos.toolsets.get(normalizedAssetId as ToolsetId) as LegacyDefinitionByType[T] | null;
    case "skill": return repos.skills.get(normalizedAssetId as SkillId) as LegacyDefinitionByType[T] | null;
    default: throw legacyDataInvalid("legacy 资产类型非法");
  }
}

/** Converts one legacy full definition into the common time-free runtime representation. */
function toLegacyRuntimeAsset<T extends OrchAssetType>(
  workspaceId: WorkspaceId,
  assetType: T,
  definition: LegacyDefinitionByType[T],
): OrchAssetAuthorityRuntimeAsset<T> {
  const assetId = requiredText(definition?.id, "legacy assetId");
  if (definition.workspaceId !== workspaceId) throw legacyDataInvalid("legacy 资产不属于运行工作区");
  const createdAt = safeTimestamp(definition.createdAt, "createdAt");
  const updatedAt = safeTimestamp(definition.updatedAt, "updatedAt");
  if (updatedAt < createdAt) throw legacyDataInvalid("legacy 资产时间顺序非法");
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...runtimeDefinition } = definition;
  if (assetType === "skill") {
    const skill = definition as SkillDefinition;
    if (typeof skill.skillMd !== "string" || !Array.isArray(skill.files)) {
      throw legacyDataInvalid("legacy Skill 缺少完整运行包");
    }
    const skillMdFiles = skill.files.filter((file) => file.relPath === "SKILL.md");
    if (skillMdFiles.length !== 1 || skillMdFiles[0]?.kind !== "skill-md"
      || typeof skillMdFiles[0].contentText !== "string" || skillMdFiles[0].contentText !== skill.skillMd) {
      throw legacyDataInvalid("legacy Skill 的文本 SKILL.md 不完整或正文不一致");
    }
    Object.assign(runtimeDefinition, {
      skillMd: skill.skillMd,
      files: skill.files.map((file) => ({ ...file })),
    });
  }
  return {
    assetType,
    assetId,
    definition: runtimeDefinition as unknown as OrchestrationRuntimeAssetDefinitionByType[T],
    source: { authorityMode: "legacy", createdAt, updatedAt },
  };
}

/** Requires one normalized runtime workspace identity before consulting authority state. */
function requiredWorkspaceId(value: unknown): WorkspaceId {
  try {
    return requiredText(value, "runtimeWorkspaceId") as WorkspaceId;
  } catch {
    throw new OrchAssetAuthorityRuntimeReadError("ASSET_RUNTIME_WORKSPACE_INVALID", "资产运行工作区身份非法");
  }
}

/** Requires one non-empty normalized internal identifier. */
function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) throw legacyDataInvalid(`${label} 非法`);
  return value;
}

/** Requires one non-negative safe legacy timestamp. */
function safeTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw legacyDataInvalid(`legacy 资产 ${label} 非法`);
  }
  return value;
}

/** Creates one explicit legacy runtime data failure. */
function legacyDataInvalid(message: string): OrchAssetAuthorityRuntimeReadError {
  return new OrchAssetAuthorityRuntimeReadError("ASSET_LEGACY_RUNTIME_DATA_INVALID", message);
}
