import path from "node:path";

import type {
  EngineType,
  KnowledgeAssetRuntimeMode,
  ExecutableToolRegistry,
  KnowledgeSpecificationRules,
} from "@codeflowai/shared";

import type { RequiredWorkspaceSkill } from "../engines/threadSession.js";
import { logger } from "../logger.js";
import { KnowledgeAssetStore } from "../knowledge/knowledgeAssetStore.js";
import { KNOWLEDGE_ASSET_READING_RULE, buildKnowledgeAssetReadTools, renderKnowledgeSpecificationRules } from "../knowledge/knowledgeAssetTools.js";
import { buildKnowledgeChangeTool, KNOWLEDGE_CHANGE_RULE } from "../knowledge/knowledgeChangeTools.js";
import { buildKnowledgeAcceptanceTool } from "../knowledge/knowledgeSpecificationTurn.js";

export type WorkspaceKnowledgeChatStatus = "ready" | "initializing" | "not_initialized" | "unavailable";

export type WorkspaceKnowledgeIssue = {
  code: string;
  message: string;
  path?: string | null;
};

export type WorkspaceKnowledgeReadiness = {
  status: WorkspaceKnowledgeChatStatus;
  reasonCode: string | null;
  engine: EngineType;
  runtimeMode: KnowledgeAssetRuntimeMode;
  workspacePath: string;
  targetProjectRoot: string;
  knowledgeRoot: string;
  knowledgeEntryPath: string;
  issues: WorkspaceKnowledgeIssue[];
};

export type WorkspaceKnowledgeChatPrompt = {
  systemRule: string | null;
  requiredWorkspaceSkills: RequiredWorkspaceSkill[];
  knowledgeAssetTools?: ExecutableToolRegistry | null;
  specifications?: KnowledgeSpecificationRules;
};

export type WorkspaceKnowledgeChatContext = WorkspaceKnowledgeReadiness & WorkspaceKnowledgeChatPrompt;

/** 自动注入降级日志需要的主键与业务上下文，便于按会话检索。 */
export type WorkspaceKnowledgeLogContext = {
  requestId?: string | null;
  turnId?: string | null;
  workspaceId?: string | null;
  threadId?: string | null;
};

/** 读取当前项目资产知识状态，存在任一已采用知识文档时自动挂载知识与规格工具。 */
export function resolveWorkspaceKnowledgeChatContext(input: {
  workspacePath: string;
  engine: EngineType;
  paths?: string[];
  logContext?: WorkspaceKnowledgeLogContext;
}): WorkspaceKnowledgeChatContext {
  const readiness = resolveWorkspaceKnowledgeReadiness(input);
  return {
    ...readiness,
    ...renderWorkspaceKnowledgeChatPrompt(readiness, input.paths, input.logContext),
  };
}

/** 新资产树是项目知识可用性的唯一判断。 */
export function resolveWorkspaceKnowledgeReadiness(input: {
  workspacePath: string;
  engine: EngineType;
}): WorkspaceKnowledgeReadiness {
  const workspacePath = path.resolve(input.workspacePath);
  const base = {
    engine: input.engine,
    workspacePath,
    targetProjectRoot: workspacePath,
    knowledgeRoot: "",
    knowledgeEntryPath: "",
  };

  try {
    const snapshot = new KnowledgeAssetStore(workspacePath).snapshot(false, false);
    base.knowledgeRoot = path.posix.dirname(snapshot.root);
    base.knowledgeEntryPath = snapshot.root;
    if (!snapshot.initialized) {
      return {
        ...base,
        status: "not_initialized",
        reasonCode: "KNOWLEDGE_NOT_INITIALIZED",
        runtimeMode: "project_assets_v1",
        issues: [{ code: "KNOWLEDGE_NOT_INITIALIZED", message: "当前项目尚未建立资产知识库" }],
      };
    }
    return {
      ...base,
      status: "ready",
      reasonCode: null,
      runtimeMode: "project_assets_v1",
      issues: [],
    };
  } catch (error) {
    return {
      ...base,
      status: "unavailable",
      reasonCode: "KNOWLEDGE_READINESS_UNAVAILABLE",
      runtimeMode: "project_assets_v1",
      issues: [{ code: "KNOWLEDGE_READINESS_UNAVAILABLE", message: `项目资产知识库读取失败：${errorMessage(error)}` }],
    };
  }
}

/**
 * 规格确定加载，其他知识按需导航；存在任一已采用知识文档即自动启用。
 * 降级：规格库不可用、规格文件损坏或总量超限时跳过注入并记录日志，保证普通会话可继续；
 * 影响仅限本回合系统提示与知识工具，不修改规格资产或已提交代码；修复规格库后新回合自动恢复。
 * 日志标识 [workspace-knowledge.auto-inject.skipped] 携带 requestId/workspaceId/threadId/原因。
 */
export function renderWorkspaceKnowledgeChatPrompt(
  readiness: WorkspaceKnowledgeReadiness,
  paths: string[] = [],
  logContext: WorkspaceKnowledgeLogContext = {},
): WorkspaceKnowledgeChatPrompt {
  if (readiness.status !== "ready") {
    if (readiness.status === "unavailable") {
      logKnowledgeInjectionSkip(readiness, logContext, readiness.reasonCode ?? "KNOWLEDGE_READINESS_UNAVAILABLE", readiness.issues.map(issue => issue.message).join("；"));
    }
    return { systemRule: null, requiredWorkspaceSkills: [] };
  }
  const store = new KnowledgeAssetStore(readiness.workspacePath);
  try {
    if (!store.hasAdoptedKnowledge()) return { systemRule: null, requiredWorkspaceSkills: [] };
    const specifications = store.rules(paths);
    return {
      specifications,
      systemRule: [`项目知识实际目录：${readiness.knowledgeEntryPath}。`,
        renderKnowledgeSpecificationRules(store, specifications),
        KNOWLEDGE_ASSET_READING_RULE, KNOWLEDGE_CHANGE_RULE].filter(Boolean).join("\n"),
      requiredWorkspaceSkills: [],
      knowledgeAssetTools: { tools: [...buildKnowledgeAssetReadTools(true).tools, buildKnowledgeChangeTool(), buildKnowledgeAcceptanceTool()] },
    };
  } catch (error) {
    logKnowledgeInjectionSkip(readiness, logContext, knowledgeErrorCode(error), errorMessage(error));
    return { systemRule: null, requiredWorkspaceSkills: [] };
  }
}

/** 保留知识资产错误码，便于日志直接检索修复方向。 */
function knowledgeErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.trim() ? code.trim() : "KNOWLEDGE_INJECTION_FAILED";
}

/** 记录自动注入降级事实；日志标识稳定可检索，根因中的工作区绝对路径先脱敏。 */
function logKnowledgeInjectionSkip(
  readiness: WorkspaceKnowledgeReadiness,
  logContext: WorkspaceKnowledgeLogContext,
  reasonCode: string,
  reason: string,
): void {
  logger.warn("workspace-knowledge", "[workspace-knowledge.auto-inject.skipped]", {
    code: reasonCode,
    requestId: logContext.requestId ?? null,
    turnId: logContext.turnId ?? null,
    workspaceId: logContext.workspaceId ?? null,
    threadId: logContext.threadId ?? null,
    status: readiness.status,
    reason: reason.split(readiness.workspacePath).join("<workspace>"),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
