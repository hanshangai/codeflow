import type { ClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";

export type ChatWorkflowCardSeed = {
  id: string;
  workspaceId: string;
  /** 卡片冻结的流程 id；传 null 表示 task_json 里没有可命中的流程引用。 */
  workflowId: string | null;
  threadId?: string;
  state?: string;
  intakeId?: string | null;
  instanceId?: string | null;
  /** 需要构造处理中回执时传入 requestId。 */
  requestId?: string;
};

export type SeededChatWorkflowCard = ChatWorkflowCardSeed & {
  threadId: string;
  state: string;
  intakeId: string | null;
  instanceId: string | null;
};

/**
 * 直接落一行会话工作流卡片，绕过服务层以便构造正常/悬空/脏数据。
 * 字段取值只满足删除路径与展示层断言，不代表完整业务语义。
 */
export function seedChatWorkflowCard(db: ClientDb, seed: ChatWorkflowCardSeed): SeededChatWorkflowCard {
  const threadId = seed.threadId ?? "thread-card";
  const state = seed.state ?? "linked";
  const intakeId = seed.intakeId ?? null;
  const instanceId = seed.instanceId ?? null;
  const task = {
    id: seed.id, workspaceId: seed.workspaceId, threadId, sourceTurnId: "turn-1", initiatorUserId: "owner",
    version: 1, state, title: "卡片", goal: "目标", context: "", acceptanceCriteria: [], rationale: "理由",
    workflow: { id: seed.workflowId, workspaceId: seed.workspaceId, name: "流程", description: "", family: "feature-dev", version: 1, nodes: [], edges: [] },
    assetHash: "card-hash", proposalId: null, intakeId, instanceId,
    acceptedResultVersion: null, acceptedBy: null, acceptedAt: null, rework: null, createdAt: 1, updatedAt: 1,
  };
  db.db.prepare(`INSERT INTO chat_workflow_tasks (id, workspace_id, thread_id, source_turn_id, instance_id, state, version, task_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(task.id, task.workspaceId, task.threadId, task.sourceTurnId, task.instanceId, task.state, task.version, JSON.stringify(task), task.createdAt, task.updatedAt);
  if (seed.requestId) {
    db.db.prepare("INSERT INTO chat_workflow_actions (request_id, task_id, actor_user_id, input_hash, state, created_at, updated_at) VALUES (?, ?, 'owner', 'input-hash', 'processing', 1, 1)")
      .run(seed.requestId, task.id);
  }
  return { ...seed, threadId, state, intakeId, instanceId };
}

/** 读取当前卡片 id 集合，用于断言删除范围。 */
export function listChatWorkflowCardIds(db: ClientDb): string[] {
  return (db.db.prepare("SELECT id FROM chat_workflow_tasks ORDER BY id").all() as Array<{ id: string }>)
    .map((row) => String(row.id));
}

/** 读取当前卡片回执 request_id 集合，用于断言回执随卡片一并清理。 */
export function listChatWorkflowActionRequestIds(db: ClientDb): string[] {
  return (db.db.prepare("SELECT request_id FROM chat_workflow_actions ORDER BY request_id").all() as Array<{ request_id: string }>)
    .map((row) => String(row.request_id));
}
