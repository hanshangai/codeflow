import crypto from "node:crypto";
import {
  CHAT_WORKFLOW_ACTIVE_STATUSES,
  type ChatWorkflowTask, type ChatWorkflowSnapshot, type ChatWorkflowView, type ChatWorkflowTodo,
  type ChatWorkflowActionInput, type OrchestrationInstance, type WorkspaceId, type ThreadId,
  type WorkflowId, type OrchestrationId, type Artifact, type ExecutableToolRegistry,
  type ThreadQueueSharedWorkspaceContext,
  type IntakeId, type ProposalId, type NodeExecutionProfileScope,
  humanizeTurnErrorMessage,
} from "@codeflowai/shared";
import type { ApiHandlerContext, ApiRequestMessage } from "../app/handleApiRequest.js";
import { ChatWorkflowRepo } from "../db/repos/chatWorkflowRepo.js";
import { readIntakeWorkspaceScope } from "../db/repos/orchIntakeRepo.js";
import type { OrchNodeStatusTransition } from "../db/repos/orchEventRepo.js";
import { mapNodeStatusToSegment } from "../app/handlers/orchMetricsHandlers.js";
import { createProposalFromIntake } from "./proposalBuilder.js";
import { orderWorkflowNodesForDisplay } from "./workflowStageOrder.js";
import {
  handleOrchInstancesStart, handleOrchInstancesPause, handleOrchInstancesResume,
  handleOrchInstancesCancel, handleOrchInstancesFeedback, handleOrchInstancesRerunFromNode,
  handleOrchNodesStart,
} from "../app/handlers/orchestrationHandlers.js";
import { emitQueueChanged } from "../app/handleThreadQueueRequest.js";
import { logger } from "../logger.js";
import { notifyChatWorkflowThreadActivity } from "./chatWorkflowActivity.js";
import { OrchCurrentWorkflowLabelResolver, relabelWorkflowDefinition } from "./orchCurrentDefinitionLabels.js";
import { assertChatWorkflowDirectoryAvailable } from "./workspaceExecutionGuard.js";
export { assertChatWorkflowDirectoryAvailable } from "./workspaceExecutionGuard.js";

export const CHAT_WORKFLOW_TOOL_ID = "runtime.chatWorkflow";
const taskOperations = new WeakMap<object, Set<string>>();

export function chatWorkflowError(code: string, message: string, status = 409): Error {
  return Object.assign(new Error(message), { code, status });
}

/** 排除对象键顺序的影响，版本由业务事实而非模型生成。 */
export function chatWorkflowHash(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, normalize(val)])) : item;
  return crypto.createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}

function artifactRevision(artifact: Artifact) {
  return { id: artifact.id, nodeId: artifact.nodeId, version: artifact.version, hash: artifact.contentHash,
    status: artifact.status, workspaceStatus: artifact.workspaceStatus, manifest: artifact.manifest, updatedAt: artifact.updatedAt };
}

function nodeVersion(instance: OrchestrationInstance, nodeId: string, artifacts: Artifact[]): string {
  const state = instance.nodeStates[nodeId];
  const indexedIds = new Set([...(instance.artifactIndex?.[nodeId] ?? []), ...(state?.inputArtifactIds ?? []), ...(state?.outputArtifactIds ?? [])]);
  return chatWorkflowHash({ state: instance.nodeStates[nodeId], artifactIds: [...indexedIds].sort(),
    artifacts: artifacts.filter(a => a.nodeId === nodeId || indexedIds.has(a.id)).map(artifactRevision).sort((a, b) => a.id.localeCompare(b.id)) });
}

type NodeActiveDuration = { activeMs: number; activeSinceAt: number | null };

/**
 * 节点累计执行耗时：按状态迁移时间轴切区间，只累计执行类（resource_activity）区间，剔除审核/补充/排队/暂停等待。
 * activeMs 为已闭合区间之和；activeSinceAt 为仍未闭合区间的起点（无则 null），由前端按本机时钟秒级递增。
 * 同一节点多轮执行（返工/续跑/重试）的区间天然累加。末条迁移仍是执行类时区间不闭合，
 * 仅在实例仍活跃且未暂停时开放（否则实例取消/失败后停在 running 的节点会永远递增）。
 */
function nodeActiveDurations(transitions: OrchNodeStatusTransition[], instance: OrchestrationInstance): Map<string, NodeActiveDuration> {
  // 暂停同样不开放区间：pause() 只把 queued/running 节点置回 ready，仍停在 artifact-writing/gate-checking
  // 等执行态的节点不会落新的状态事件，开放区间会把整个暂停时长算进去。封口时刻取 pause 已更新的 updatedAt。
  const closedAt = instance.status !== "paused" && CHAT_WORKFLOW_ACTIVE_STATUSES.has(instance.status) ? null : instance.updatedAt;
  const byNode = new Map<string, OrchNodeStatusTransition[]>();
  for (const transition of transitions) {
    // 事件缺 status 属契约漂移，显式失败而不是当成 0 耗时继续。
    if (!transition.status) throw chatWorkflowError("CHAT_WORKFLOW_EVENT_CONTRACT_INVALID", `节点状态事件缺少 status 字段（实例 ${instance.id}）`, 500);
    const list = byNode.get(transition.nodeId);
    if (list) list.push(transition);
    else byNode.set(transition.nodeId, [transition]);
  }
  const durations = new Map<string, NodeActiveDuration>();
  for (const [nodeId, list] of byNode) {
    let activeMs = 0;
    let activeSinceAt: number | null = null;
    list.forEach((transition, index) => {
      if (mapNodeStatusToSegment(transition.status)?.segmentClass !== "resource_activity") return;
      const endedAt = list[index + 1]?.createdAt ?? closedAt;
      if (endedAt === null) { activeSinceAt = transition.createdAt; return; }
      if (endedAt > transition.createdAt) activeMs += endedAt - transition.createdAt;
    });
    durations.set(nodeId, { activeMs, activeSinceAt });
  }
  return durations;
}

export class ChatWorkflowService {
  readonly repo: ChatWorkflowRepo;
  /** 展示层按 nodeId 解析当前工作流定义；执行路径仍使用实例冻结快照。 */
  private readonly currentLabels: OrchCurrentWorkflowLabelResolver;
  constructor(private readonly ctx: ApiHandlerContext) {
    this.repo = new ChatWorkflowRepo(ctx.db.db);
    this.currentLabels = new OrchCurrentWorkflowLabelResolver(ctx.orchAssetRuntimeRead);
  }

  /** 只为同步仓储与投影申请许可，原实例控制owner持有异步等待。 */
  private async withDatabase<T>(requestId: string, operation: () => T): Promise<T> {
    return this.ctx.withDatabase ? this.ctx.withDatabase(requestId, operation) : operation();
  }

  private recoverThreadStarts(threadId: string): void {
    const recovered = this.repo.recoverStarts(threadId, taskOperations.get(this.ctx.db.db));
    for (const task of recovered) logger.info("chat-workflow", "interrupted workflow start reconciled", {
      code: "CHAT_WORKFLOW_START_RECOVERED", requestId: task.requestIds[0] ?? null,
      threadId, taskId: task.taskId, instanceId: task.instanceId,
      cause: task.instanceId ? "persisted instance found" : "no persisted instance or active start operation",
    });
  }

  requireThread(workspaceId: string, threadId: string) {
    const thread = this.ctx.db.threads.get(threadId as ThreadId);
    if (!thread || thread.workspaceId !== workspaceId || thread.threadType !== "chat" || thread.threadSubtype) {
      throw chatWorkflowError("CHAT_WORKFLOW_THREAD_INVALID", "工作流会话不存在或不属于当前工作区", 404);
    }
    return thread;
  }

  requireTask(workspaceId: string, threadId: string, taskId: string): ChatWorkflowTask {
    this.requireThread(workspaceId, threadId);
    this.recoverThreadStarts(threadId);
    const task = this.repo.get(taskId);
    if (!task || task.threadId !== threadId || task.workspaceId !== workspaceId) throw chatWorkflowError("CHAT_WORKFLOW_TASK_NOT_FOUND", "会话工作流任务不存在", 404);
    return task;
  }

  snapshot(workspaceId: string, threadId: string, actorUserId: string): ChatWorkflowSnapshot {
    this.requireThread(workspaceId, threadId);
    this.recoverThreadStarts(threadId);
    return { recommendationEnabled: this.repo.isEnabled(threadId), tasks: this.filterVisibleTasks(this.repo.list(threadId)).map(task => this.view(task, actorUserId)) };
  }

  /**
   * 展示层可见性：绑定实例已被清理（删需求/删流程资产）的卡片不再返回，避免出现点不动的幽灵卡。
   * instanceId 为空表示尚未启动，始终可见；实例存在性一次批查询覆盖整份列表，不在循环里逐张查。
   */
  private filterVisibleTasks(tasks: ChatWorkflowTask[]): ChatWorkflowTask[] {
    const boundInstanceIds = tasks.map(task => task.instanceId).filter((instanceId): instanceId is string => Boolean(instanceId));
    if (!boundInstanceIds.length) return tasks;
    const existingInstanceIds = this.ctx.db.orchInstances.listExistingIds(boundInstanceIds);
    return tasks.filter(task => !task.instanceId || existingInstanceIds.has(task.instanceId));
  }

  view(task: ChatWorkflowTask, actorUserId: string): ChatWorkflowView {
    const continuation = task.continuationQueueItemId ? this.ctx.db.threadMessageQueue.getById(task.continuationQueueItemId) : null;
    const instance = task.instanceId ? this.ctx.db.orchInstances.get(task.instanceId as OrchestrationId) : null;
    const artifacts = instance ? this.ctx.db.orchArtifacts.listSummariesByInstance(instance.id) : [];
    const activeByNode = instance ? nodeActiveDurations(this.ctx.db.orchEvents.listNodeStatusTransitions(instance.id), instance) : new Map<string, NodeActiveDuration>();
    const resultVersion = instance ? chatWorkflowHash({ status: instance.status, nodes: instance.nodeStates, artifacts: artifacts.map(artifactRevision).sort((a, b) => a.id.localeCompare(b.id)) }) : null;
    // 展示用的流程名与节点名取当前工作流定义；task 必须复制后覆盖，禁止就地改写，否则会污染冻结的 task_json。
    const labels = this.currentLabels.resolve(task.workspaceId, task.workflow.id);
    const displayTaskWorkflow = relabelWorkflowDefinition(task.workflow, labels);
    const displayWorkflow = instance ? relabelWorkflowDefinition(instance.workflowSnapshot, labels) : displayTaskWorkflow;
    // 事件文案里的节点名按 nodeId 取当前定义；节点已删除时该 id 仍落在快照旧名上。
    const displayNodeLabels = new Map(displayWorkflow.nodes.map(node => [node.id, node.label] as const));
    // 卡片按 DAG 依赖展示，不沿用 nodes 数组顺序：自定义工作流的数组是添加顺序，与流程先后无关。
    const orderedStages = orderWorkflowNodesForDisplay(displayWorkflow.nodes, displayWorkflow.edges);
    return {
      ...(task.continuationQueueItemId ? { continuation: {
        queueItemId: task.continuationQueueItemId,
        status: continuation?.status ?? "cancelled",
        failureReason: continuation?.failureReason ?? null,
        paused: continuation ? this.ctx.db.threadQueueStates.getState(task.threadId as ThreadId).paused : false,
      } } : {}),
      task: labels ? { ...task, workflow: displayTaskWorkflow } : task,
      status: instance?.status ?? null, resultVersion,
      stages: orderedStages.map(({ node: n, parallelBranchIndex, isBranchStart }) => {
        const active = activeByNode.get(n.id);
        return { nodeId: n.id, nodeType: n.type, label: n.label, status: instance?.nodeStates[n.id]?.status ?? "pending", error: humanizeTurnErrorMessage(instance?.nodeStates[n.id]?.error),
          activeMs: active?.activeMs ?? 0, activeSinceAt: active?.activeSinceAt ?? null, parallelBranchIndex, isBranchStart };
      }),
      todos: instance ? orderedStages.flatMap(({ node }) => {
        const state = instance.nodeStates[node.id];
        if (!state || !["waiting-start", "waiting-approval", "waiting-feedback"].includes(state.status)) return [];
        const actions: ChatWorkflowTodo["actions"] = state.status === "waiting-start"
          ? [{ action: "start_node", label: "启动节点", effect: "启动当前阶段，后续按工作流规则推进" }]
          : node.type === "condition" || state.humanActionSource === "branch_decision"
            ? [{ action: "choose_branch", label: "确认分支", effect: "按所选分支继续执行" }]
            // 门禁未通过时，除「补充并继续」外还必须给出「重新评估」与「忽略门禁继续」，
            // 否则会话卡片会把人工卡在必须提供补充说明的死路上。
            : state.humanActionSource === "gate"
              ? [
                  { action: "reevaluate_gates", label: "重新评估门禁", effect: "按当前结果重新判定门禁，不改动结果内容" },
                  { action: "override", label: "忽略门禁继续", effect: "忽略门禁未通过结果，把节点标记为通过并继续后续流程" },
                  { action: "resume_with_input", label: "补充并继续", effect: "将补充内容交给当前节点继续处理" },
                ]
              : state.status === "waiting-approval"
                ? [{ action: "approve", label: "审核通过", effect: "通过当前节点审核，继续推进依赖节点" }]
                : [{ action: "resume_with_input", label: "补充并继续", effect: "将补充内容交给当前节点继续处理" }];
        return [{ nodeId: node.id, label: node.label, version: nodeVersion(instance, node.id, artifacts), status: state.status,
          summary: String(state.output ?? "").slice(0, 3000), question: humanizeTurnErrorMessage(state.error) || "请审阅当前结果并选择下一步操作。", actions,
          branches: instance.workflowSnapshot.edges.filter(e => e.sourceNodeId === node.id).map(e => ({ nodeId: e.targetNodeId, label: displayWorkflow.nodes.find(n => n.id === e.targetNodeId)?.label ?? e.targetNodeId })),
        }];
      }) : [],
      artifacts: artifacts.map(a => ({ id: a.id, title: a.title, nodeId: a.nodeId, version: a.version, summary: a.manifest?.summary ?? "" })),
      checks: instance ? Object.entries(instance.nodeStates).flatMap(([nodeId, state]) => (state.gateResults ?? []).map(g => ({ nodeId, criterion: g.criterionId, passed: g.passed, message: g.message }))) : [],
      canAccept: Boolean(actorUserId && actorUserId === task.initiatorUserId),
      accepted: Boolean(resultVersion && task.acceptedResultVersion === resultVersion),
      updates: instance ? this.ctx.db.orchEvents.listByInstance(instance.id, { limit: 100, includePayload: false }).flatMap(event => {
        const p = JSON.parse(event.payloadJson) as Record<string, unknown>;
        const name = String(displayNodeLabels.get(String(p.nodeId ?? "")) ?? p.nodeLabel ?? p.nodeId ?? task.title);
        const type = event.type;
        const text = type === "orchestration.started" ? "工作流已启动"
          : type === "orchestration.completed" ? `执行已结束：${String(p.status ?? instance.status)}`
          : type === "orchestration.paused" ? "工作流已暂停"
          : type === "orchestration.approvalRequested" ? `${name}：等待审核`
          : type === "orchestration.feedbackRequested" ? `${name}：需要补充或决定`
          : type === "orchestration.error" ? `${name}：${String(p.error ?? "执行失败")}`
          : type === "orchestration.nodeStateChanged" && p.status === "completed" ? `${name}：阶段完成` : null;
        return text ? [{ id: event.id, createdAt: event.createdAt, text }] : [];
      }) : [],
      acceptance: task.acceptanceCriteria.map((text, index) => {
        const checks = instance ? Object.values(instance.nodeStates).flatMap(s => s.gateResults ?? []).filter(g => g.criterionId === `acceptance-${index + 1}`) : [];
        return { text, status: checks.length ? checks.every(g => g.passed) ? "passed" as const : "failed" as const : "unverified" as const, evidence: checks.map(g => g.message).join("；") };
      }),
    };
  }

  recommend(input: { workspaceId: string; threadId: string; turnId: string; actorUserId: string; workflowId: string; title: string; goal: string; context: string; rationale: string; acceptanceCriteria: string[] }): ChatWorkflowView {
    this.requireThread(input.workspaceId, input.threadId);
    this.recoverThreadStarts(input.threadId);
    if (!input.actorUserId) throw chatWorkflowError("CHAT_WORKFLOW_ACTOR_REQUIRED", "缺少真实发起人身份", 403);
    if (!input.goal.trim() || !input.rationale.trim() || !input.acceptanceCriteria.length) throw chatWorkflowError("CHAT_WORKFLOW_INPUT_REQUIRED", "请先明确目标、推荐原因和验收条件", 400);
    if (input.goal.length + input.context.length > 32000 || input.acceptanceCriteria.length > 30) throw chatWorkflowError("CHAT_WORKFLOW_INPUT_LIMIT", "需求上下文过长，请先整理摘要", 400);
    const latestTurn = this.ctx.db.db.prepare("SELECT turn_id, user_text FROM thread_turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(input.threadId) as { turn_id: string; user_text: string } | undefined;
    if (latestTurn && latestTurn.turn_id !== input.turnId) throw chatWorkflowError("CHAT_WORKFLOW_SOURCE_EXPIRED", "用户已发送新的消息，请基于最新需求重新评估");
    const explicitRequest = /(?:使用|用|启动|运行|执行).{0,16}(?:工作流|workflow)/iu.test(latestTurn?.user_text ?? "") && !/(?:不要|不用|别|不需要).{0,16}(?:工作流|workflow)/iu.test(latestTurn?.user_text ?? "");
    if (!this.repo.isEnabled(input.threadId) && !explicitRequest) throw chatWorkflowError("CHAT_WORKFLOW_RECOMMENDATION_DISABLED", "本会话已关闭主动推荐，需用户明确要求后再推荐");
    const tasks = this.repo.list(input.threadId);
    if (!explicitRequest && tasks.some(t => t.state === "dismissed" && t.goal === input.goal.trim())) throw chatWorkflowError("CHAT_WORKFLOW_RECOMMENDATION_DISMISSED", "用户已拒绝该任务的推荐，请继续普通会话处理");
    // 去重扫描只认可见卡片，否则会把一张已不可见的幽灵卡当重复推荐回给模型。
    const duplicate = this.filterVisibleTasks(tasks).find(t => t.sourceTurnId === input.turnId && t.state === "recommended" && t.workflow.id === input.workflowId && t.goal === input.goal);
    if (duplicate) return this.view(duplicate, input.actorUserId);
    this.assertThreadAvailable(input.threadId);
    const asset = this.ctx.orchAssetLaunchSnapshot?.createFromWorkflowId(input.workspaceId as WorkspaceId, input.workflowId as WorkflowId);
    if (!asset) throw chatWorkflowError("CHAT_WORKFLOW_ASSETS_UNAVAILABLE", "工作流资产暂不可用");
    const now = Date.now();
    const task: ChatWorkflowTask = { id: crypto.randomUUID(), workspaceId: input.workspaceId, threadId: input.threadId, sourceTurnId: input.turnId,
      initiatorUserId: input.actorUserId, version: 1, state: "recommended", title: input.title.trim().slice(0, 60) || input.goal.slice(0, 60), goal: input.goal.trim(),
      context: input.context, rationale: input.rationale, acceptanceCriteria: input.acceptanceCriteria, workflow: asset.workflow.definition, assetHash: chatWorkflowHash(asset),
      proposalId: null, intakeId: null, instanceId: null, acceptedResultVersion: null, acceptedBy: null, acceptedAt: null, rework: null, createdAt: now, updatedAt: now };
    this.ctx.db.db.transaction(() => {
      for (const old of tasks.filter(t => t.state === "recommended")) this.repo.update({ ...old, state: "superseded" }, old.version);
      this.repo.create(task);
    })();
    return this.view(task, input.actorUserId);
  }

  planRework(workspaceId: string, threadId: string, taskId: string, nodeId: string, reason: string, actorUserId: string): ChatWorkflowView {
    const task = this.requireTask(workspaceId, threadId, taskId);
    const view = this.view(task, actorUserId);
    if (!task.instanceId || !view.resultVersion || !reason.trim()) throw chatWorkflowError("CHAT_WORKFLOW_REWORK_INVALID", "请提供已有执行任务和明确的修改意见", 400);
    const instance = this.ctx.db.orchInstances.get(task.instanceId as OrchestrationId)!;
    if (!instance.workflowSnapshot.nodes.some(n => n.id === nodeId && n.type === "role")) throw chatWorkflowError("CHAT_WORKFLOW_REWORK_INVALID", "返工起点必须是当前工作流中的角色节点", 400);
    const affected = new Set([nodeId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const edge of instance.workflowSnapshot.edges) if (affected.has(edge.sourceNodeId) && !affected.has(edge.targetNodeId)) { affected.add(edge.targetNodeId); changed = true; }
    }
    const next = this.repo.update({ ...task, rework: { nodeId, reason: reason.trim().slice(0, 16000), affectedNodeIds: [...affected], resultVersion: view.resultVersion } }, task.version);
    return this.view(next, actorUserId);
  }

  /** 在恢复或准备写入前核对已知归属；未知保持未知，提案只继承需求快照。 */
  prepareStart(workspaceId: string, threadId: string, taskId: string, expectedVersion: number, actorUserId: string): ChatWorkflowView {
    const thread = this.requireThread(workspaceId, threadId);
    const requestScope = readIntakeWorkspaceScope(this.ctx.intakeWorkspaceScope, workspaceId as WorkspaceId);
    const threadScope: NodeExecutionProfileScope | null = thread.sharedWorkspaceId
      ? { scopeType: "shared_workspace", scopeId: thread.sharedWorkspaceId } : null;
    const persistedTask = this.repo.get(taskId);
    let intakeScope: NodeExecutionProfileScope | null = null;
    if (persistedTask?.workspaceId === workspaceId && persistedTask.threadId === threadId && (persistedTask.intakeId || persistedTask.proposalId)) {
      const intake = persistedTask.intakeId ? this.ctx.db.orchIntakes.get(persistedTask.intakeId as IntakeId) : null;
      const proposal = persistedTask.proposalId ? this.ctx.db.orchProposals.get(persistedTask.proposalId as ProposalId) : null;
      if (!intake || !proposal || intake.workspaceId !== workspaceId || proposal.workspaceId !== workspaceId
        || proposal.intakeId !== intake.id || proposal.intakeSnapshot.id !== intake.id || proposal.intakeSnapshot.workspaceId !== workspaceId) {
        throw chatWorkflowError("CONFLICT", "已准备任务的需求或提案引用不一致");
      }
      intakeScope = intake.workspaceScope ?? null;
      const snapshotScope = readIntakeWorkspaceScope(proposal.intakeSnapshot.workspaceScope, workspaceId as WorkspaceId, intake.id);
      if (snapshotScope?.scopeType !== intakeScope?.scopeType || snapshotScope?.scopeId !== intakeScope?.scopeId) {
        throw chatWorkflowError("FORBIDDEN", `已准备提案快照与需求归属不一致（需求 ${intake.id}，提案 ${proposal.id}）`, 403);
      }
    }
    // 缺少 shared 标记仅表示没有共享事实，不能据此推导个人归属。
    const knownScopes = [requestScope, threadScope, intakeScope].filter((scope): scope is NodeExecutionProfileScope => scope !== null);
    if (knownScopes.some(scope => scope.scopeType !== knownScopes[0]!.scopeType || scope.scopeId !== knownScopes[0]!.scopeId)) {
      throw chatWorkflowError("FORBIDDEN", "可信入口、源会话或已准备需求的工作区归属不一致", 403);
    }
    let task = this.requireTask(workspaceId, threadId, taskId);
    if (task.version !== expectedVersion) throw chatWorkflowError("CHAT_WORKFLOW_VERSION_CONFLICT", "方案已更新，请重新查看");
    if (task.initiatorUserId !== actorUserId) throw chatWorkflowError("CHAT_WORKFLOW_INITIATOR_REQUIRED", "请由方案发起人确认启动", 403);
    if (task.instanceId || task.state === "linked") return this.view(task, actorUserId);
    if (task.state !== "recommended" && task.state !== "starting") throw chatWorkflowError("CHAT_WORKFLOW_PROPOSAL_EXPIRED", "推荐已撤回或被新方案替代");
    const latestTurn = this.ctx.db.db.prepare("SELECT turn_id FROM thread_turns WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1").get(threadId) as { turn_id: string } | undefined;
    if (latestTurn && latestTurn.turn_id !== task.sourceTurnId) throw chatWorkflowError("CHAT_WORKFLOW_SOURCE_EXPIRED", "推荐后已有新的会话输入，请先更新执行方案再确认");
    this.assertThreadAvailable(threadId, task.id);
    const asset = this.ctx.orchAssetLaunchSnapshot?.createFromWorkflowId(workspaceId as WorkspaceId, task.workflow.id);
    if (!asset || chatWorkflowHash(asset) !== task.assetHash) throw chatWorkflowError("CHAT_WORKFLOW_ASSET_CHANGED", "工作流配置已变更，请重新生成方案后确认");
    if (!task.proposalId) {
      task = this.ctx.db.db.transaction(() => {
        const intake = this.ctx.db.orchIntakes.create({ workspaceId: workspaceId as WorkspaceId, workspaceScope: requestScope, triggerMode: "manual", taskType: "feature", title: task.title, goal: task.goal,
          background: task.context, acceptanceCriteria: task.acceptanceCriteria.map((text, index) => ({ id: `acceptance-${index + 1}`, text, blocking: true })),
          constraints: { requireUserConfirmation: true }, requester: { source: "chat", userId: actorUserId } });
        const proposal = createProposalFromIntake({ db: this.ctx.db, getRole: id => asset.roles[id]?.definition ?? null }, intake, asset.workflow.definition, task.rationale);
        return this.repo.update({ ...task, intakeId: intake.id, proposalId: proposal.id }, task.version);
      })();
    }
    return this.view(task, actorUserId);
  }

  /**
   * 硬删未启动的推荐卡及其操作回执，真实用户可见范围随之在所有设备与协作者处收敛。
   * 仅发起人可删；已启动（instanceId 非空）或正在启动的卡必须先终止流程。
   * 续跑队列项为 pending 时同事务取消，为 sending 时拒绝删除（避免「删了但消息仍发出」的错位）；
   * 卡片自己创建的需求与提案一并删除，不留下无主记录。
   */
  remove(workspaceId: string, threadId: string, taskId: string, expectedVersion: number, actorUserId: string): {
    taskId: string; cancelledContinuationQueueItemId: string | null; deletedIntakeId: string | null;
  } {
    const task = this.requireTask(workspaceId, threadId, taskId);
    if (task.version !== expectedVersion) throw chatWorkflowError("CHAT_WORKFLOW_VERSION_CONFLICT", "卡片已更新，请刷新后操作");
    if (task.initiatorUserId !== actorUserId) throw chatWorkflowError("CHAT_WORKFLOW_INITIATOR_REQUIRED", "请由方案发起人删除该卡片", 403);
    if (task.state === "starting") throw chatWorkflowError("CHAT_WORKFLOW_DELETE_STARTING", "工作流正在启动，请稍后再试");
    if (task.instanceId) throw chatWorkflowError("CHAT_WORKFLOW_DELETE_INSTANCE_BOUND", "工作流已启动，请先终止流程后再删除卡片");
    const continuationQueueItemId = task.continuationQueueItemId;
    const continuation = continuationQueueItemId ? this.ctx.db.threadMessageQueue.getById(continuationQueueItemId) : null;
    if (continuation?.status === "sending") throw chatWorkflowError("CHAT_WORKFLOW_DELETE_CONTINUATION_SENDING", "续跑消息正在发送，请稍后再试");
    let busy = taskOperations.get(this.ctx.db.db);
    if (!busy) { busy = new Set(); taskOperations.set(this.ctx.db.db, busy); }
    if (busy.has(task.id)) throw chatWorkflowError("CHAT_WORKFLOW_ACTION_BUSY", "该工作流正在处理另一项操作");
    busy.add(task.id);
    let cancelledContinuationQueueItemId: string | null = null;
    let deletedIntakeId: string | null = null;
    try {
      this.ctx.db.db.transaction(() => {
        // remove 自带 status='pending' 条件：已发出或已终结的队列项不在这里被改动。
        if (continuationQueueItemId && this.ctx.db.threadMessageQueue.remove(threadId as ThreadId, continuationQueueItemId)) {
          cancelledContinuationQueueItemId = continuationQueueItemId;
        }
        // 未命中即文档事实与请求不一致，显式失败而不是伪装成功。
        if (!this.repo.deleteTask(workspaceId, taskId)) throw chatWorkflowError("CHAT_WORKFLOW_TASK_NOT_FOUND", "会话工作流任务不存在", 404);
        if (task.intakeId) {
          // 一卡一需求由 prepareStart 保证；被别的卡片引用说明是脏数据，宁可整体回滚也不留下无主需求。
          if (this.repo.listTaskIdsByIntakeId(workspaceId, task.intakeId).length) {
            throw chatWorkflowError("CHAT_WORKFLOW_INTAKE_REFERENCED", "该需求仍被其它工作流卡片引用，无法删除");
          }
          this.ctx.db.orchProposals.deleteByIntake(task.intakeId as any);
          this.ctx.db.orchIntakes.delete(task.intakeId as any);
          deletedIntakeId = task.intakeId;
        }
      })();
    } finally { busy.delete(task.id); }
    // 队列项被取消后必须广播，否则队列面板仍显示这条待发消息。
    if (cancelledContinuationQueueItemId) emitQueueChanged(this.ctx, workspaceId as WorkspaceId, threadId as ThreadId, "removed");
    return { taskId: task.id, cancelledContinuationQueueItemId, deletedIntakeId };
  }

  assertThreadAvailable(threadId: string, exceptTaskId?: string): void {
    this.recoverThreadStarts(threadId);
    for (const task of this.repo.list(threadId)) {
      if (task.id === exceptTaskId) continue;
      const view = this.view(task, "");
      if (task.state === "starting" || (view.status && CHAT_WORKFLOW_ACTIVE_STATUSES.has(view.status))) throw chatWorkflowError("CHAT_WORKFLOW_THREAD_OCCUPIED", "当前会话已有进行中的工作流，请先完成或终止该流程");
    }
  }

  /** 动作准入与结果各持短许可，实例控制等待期间释放数据库。 */
  async action(input: ChatWorkflowActionInput, actorUserId: string, runtimeContext: Record<string, unknown> = {}): Promise<ChatWorkflowView> {
    let task = await this.withDatabase(input.requestId, () => this.requireTask(input.workspaceId, input.threadId, input.taskId));
    if (!actorUserId || !input.requestId) throw chatWorkflowError("CHAT_WORKFLOW_IDENTITY_REQUIRED", "操作缺少真实用户或请求标识", 400);
    if (!["start", "dismiss", "pause", "resume", "cancel", "feedback", "accept", "confirm_rework"].includes(input.action)) throw chatWorkflowError("CHAT_WORKFLOW_ACTION_INVALID", "未知工作流操作", 400);
    const inputHash = chatWorkflowHash({ ...input, actorUserId });
    const existing = await this.withDatabase(input.requestId, () => this.ctx.db.db.prepare("SELECT * FROM chat_workflow_actions WHERE request_id = ?").get(input.requestId)) as { task_id: string; actor_user_id: string; input_hash: string; state: string; result_json: string | null } | undefined;
    if (existing) {
      if (existing.task_id !== task.id || existing.actor_user_id !== actorUserId || existing.input_hash !== inputHash) throw chatWorkflowError("CHAT_WORKFLOW_REQUEST_CONFLICT", "重复请求的内容不一致");
      if (existing.state === "completed") {
        if (input.action === "dismiss") await this.withDatabase(input.requestId, () => this.wakeContinuation(task, input.requestId));
        return await this.withDatabase(input.requestId, () => this.view(task, actorUserId));
      }
      if (existing.state === "interrupted") throw chatWorkflowError("CHAT_WORKFLOW_START_INTERRUPTED", "上次启动已中断且未创建实例，请刷新后重试");
      throw chatWorkflowError("CHAT_WORKFLOW_ACTION_UNCERTAIN", "该操作已提交，请刷新核对实际状态后再处理");
    }
    if (task.version !== input.expectedVersion) throw chatWorkflowError("CHAT_WORKFLOW_VERSION_CONFLICT", "卡片已更新，请刷新后操作");
    let busy = taskOperations.get(this.ctx.db.db);
    if (!busy) { busy = new Set(); taskOperations.set(this.ctx.db.db, busy); }
    if (busy.has(task.id)) throw chatWorkflowError("CHAT_WORKFLOW_ACTION_BUSY", "该工作流正在处理另一项操作");
    busy.add(task.id);
    let actionPersisted = false;
    try {
      const view = await this.withDatabase(input.requestId, () => this.view(task, actorUserId));
      const instanceId = task.instanceId;
      if (input.action === "accept" && (!view.canAccept || view.status !== "completed" || !input.resultVersion || input.resultVersion !== view.resultVersion)) throw chatWorkflowError("CHAT_WORKFLOW_ACCEPT_INVALID", "仅发起人可验收当前已完成的结果版本", 403);
      if (input.action === "feedback") {
        const todo = view.todos.find(t => t.nodeId === input.nodeId);
        if (!todo || input.nodeVersion !== todo.version || !todo.actions.some(a => a.action === input.feedbackAction)) throw chatWorkflowError("CHAT_WORKFLOW_TODO_EXPIRED", "待办已处理或结果发生变化，请查看最新状态");
        if (input.feedbackAction === "choose_branch" && !todo.branches.some(b => b.nodeId === input.targetNodeId)) throw chatWorkflowError("CHAT_WORKFLOW_BRANCH_INVALID", "请选择当前待办的有效分支", 400);
        if (input.feedbackAction === "resume_with_input" && !input.feedback?.trim()) throw chatWorkflowError("CHAT_WORKFLOW_FEEDBACK_REQUIRED", "请填写需要补充的内容", 400);
      }
      if (input.action === "confirm_rework" && (!task.rework || task.rework.resultVersion !== view.resultVersion)) throw chatWorkflowError("CHAT_WORKFLOW_REWORK_EXPIRED", "执行结果已变化，请重新查看返工范围");
      if (["resume", "confirm_rework", "start"].includes(input.action)) {
        await this.withDatabase(input.requestId, () => this.assertThreadAvailable(task.threadId, task.id));
        await this.withDatabase(input.requestId, () => assertChatWorkflowDirectoryAvailable(this.ctx, task.workspaceId, instanceId, task.threadId));
      }
      if (input.action === "start") {
        if (this.ctx.sessions.hasActiveTurn(task.threadId as ThreadId)) throw chatWorkflowError("CHAT_WORKFLOW_SOURCE_BUSY", "请等待当前回复结束或停止当前回复后再启动工作流");
        if (!task.proposalId || task.initiatorUserId !== actorUserId || !["recommended", "starting"].includes(task.state)) throw chatWorkflowError("CHAT_WORKFLOW_START_INVALID", "请由发起人确认当前执行方案");
        const asset = await this.withDatabase(input.requestId, () => this.ctx.orchAssetLaunchSnapshot?.createFromWorkflowId(task.workspaceId as WorkspaceId, task.workflow.id));
        if (!asset || chatWorkflowHash(asset) !== task.assetHash) throw chatWorkflowError("CHAT_WORKFLOW_ASSET_CHANGED", "工作流已更新，请重新生成方案");
      } else if (input.action === "dismiss") {
        if (task.state !== "recommended" && task.state !== "dismissed") throw chatWorkflowError("CHAT_WORKFLOW_PROPOSAL_EXPIRED", "该推荐已失效");
        return await this.withDatabase(input.requestId, () => this.dismissAndContinue(task, input, actorUserId, inputHash, runtimeContext));
      } else if (!instanceId) throw chatWorkflowError("CHAT_WORKFLOW_INSTANCE_REQUIRED", "工作流尚未启动");
      if (input.action === "resume" && view.status !== "paused") throw chatWorkflowError("CHAT_WORKFLOW_RESUME_INVALID", "仅暂停中的工作流可以恢复");
      if ((input.action === "pause" || input.action === "cancel") && (!view.status || !CHAT_WORKFLOW_ACTIVE_STATUSES.has(view.status))) throw chatWorkflowError("CHAT_WORKFLOW_CONTROL_EXPIRED", "工作流已结束，请查看最新结果");
      await this.withDatabase(input.requestId, () => this.ctx.db.db.transaction(() => {
        const now = Date.now();
        this.ctx.db.db.prepare("INSERT INTO chat_workflow_actions (request_id, task_id, actor_user_id, input_hash, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'processing', ?, ?)").run(input.requestId, task.id, actorUserId, inputHash, now, now);
        task = this.repo.update({ ...task, ...(input.action === "start" ? { state: "starting" as const } : {}) }, task.version);
      })());
      actionPersisted = true;
      const body = { ...runtimeContext, workspaceId: task.workspaceId, instanceId, actorUserId };
      switch (input.action) {
        case "start": {
          await this.withDatabase(input.requestId, () => this.ctx.db.orchProposals.confirm(task.proposalId as any));
          const result = await invokeHandler(this.ctx, handleOrchInstancesStart, { ...body, proposalId: task.proposalId, initiatorUserId: actorUserId });
          task = await this.withDatabase(input.requestId, () => this.repo.linkInstance(task.id, String(result.instanceId)));
          break;
        }
        case "accept": task = await this.withDatabase(input.requestId, () => this.repo.update({ ...task, acceptedResultVersion: view.resultVersion, acceptedBy: actorUserId, acceptedAt: Date.now() }, task.version)); break;
        case "pause": await invokeHandler(this.ctx, handleOrchInstancesPause, body); break;
        case "resume": await invokeHandler(this.ctx, handleOrchInstancesResume, body); break;
        case "cancel": await invokeHandler(this.ctx, handleOrchInstancesCancel, body); break;
        case "feedback": await invokeHandler(this.ctx, input.feedbackAction === "start_node" ? handleOrchNodesStart : handleOrchInstancesFeedback, { ...body, nodeId: input.nodeId, action: input.feedbackAction, feedback: input.feedback, targetNodeId: input.targetNodeId }); break;
        case "confirm_rework":
          await invokeHandler(this.ctx, handleOrchInstancesRerunFromNode, { ...body, targetNodeId: task.rework!.nodeId, note: task.rework!.reason, rerunNodeIds: task.rework!.affectedNodeIds });
          task = await this.withDatabase(input.requestId, () => this.repo.update({ ...task, rework: null, acceptedResultVersion: null, acceptedAt: null, acceptedBy: null }, task.version));
          break;
        default: throw chatWorkflowError("CHAT_WORKFLOW_ACTION_INVALID", "未知工作流操作", 400);
      }
      await this.withDatabase(input.requestId, () => this.ctx.db.db.prepare("UPDATE chat_workflow_actions SET state = 'completed', updated_at = ? WHERE request_id = ?").run(Date.now(), input.requestId));
      // 验收、拒绝推荐等操作不驱动实例状态迁移，这里统一兜底同步承载会话的活动时间。
      await this.withDatabase(input.requestId, () => notifyChatWorkflowThreadActivity({
        host: {
          touchThread: (threadId, updatedAt) => this.ctx.db.threads.touch(threadId, updatedAt),
          emitOrchestration: this.ctx.emitOrchestration,
        },
        workspaceId: task.workspaceId as WorkspaceId,
        threadId: task.threadId,
        instanceId: task.instanceId,
        taskId: task.id,
      }));
      return await this.withDatabase(input.requestId, () => this.view(task, actorUserId));
    } catch (error) {
      if (actionPersisted && input.action === "start") {
        await this.withDatabase(input.requestId, () => this.repo.recoverStarts(task.threadId, new Set([...busy].filter(id => id !== task.id))));
        const recovered = await this.withDatabase(input.requestId, () => this.repo.get(task.id));
        if (recovered?.instanceId) {
          await this.withDatabase(input.requestId, () => this.ctx.db.db.prepare("UPDATE chat_workflow_actions SET state = 'completed', updated_at = ? WHERE request_id = ?").run(Date.now(), input.requestId));
          logger.warn("chat-workflow", "workflow start response recovered from persisted instance", {
            code: "CHAT_WORKFLOW_START_RESPONSE_RECOVERED", requestId: input.requestId,
            workspaceId: task.workspaceId, threadId: task.threadId, taskId: task.id, instanceId: recovered.instanceId,
            cause: error instanceof Error ? error.message : String(error),
          });
          return await this.withDatabase(input.requestId, () => this.view(recovered, actorUserId));
        }
      }
      await this.withDatabase(input.requestId, () => this.ctx.db.db.prepare("UPDATE chat_workflow_actions SET state = 'failed', updated_at = ? WHERE request_id = ? AND state = 'processing'").run(Date.now(), input.requestId));
      throw error;
    } finally { busy.delete(task.id); }
  }

  /** 决定、续跑消息和回执同事务落库，避免取消推荐成功但续跑消息丢失。 */
  private dismissAndContinue(task: ChatWorkflowTask, input: ChatWorkflowActionInput, actorUserId: string, inputHash: string, runtimeContext: Record<string, unknown>): ChatWorkflowView {
    const thread = this.requireThread(task.workspaceId, task.threadId);
    if (!this.ctx.queueDispatcher) throw chatWorkflowError("CHAT_WORKFLOW_CONTINUATION_UNAVAILABLE", "会话调度尚未就绪，请稍后重试");
    if (!this.ctx.workspaces.has(thread.workspaceId)) throw chatWorkflowError("CHAT_WORKFLOW_CONTINUATION_UNAVAILABLE", "工作区目录不可用，请恢复后重试");
    const sharedContext = runtimeContext.sharedWorkspaceToolContext as ThreadQueueSharedWorkspaceContext | null | undefined;
    if (thread.sharedWorkspaceId && (sharedContext?.sharedWorkspaceId !== thread.sharedWorkspaceId || sharedContext.toolPolicyKey !== "ai.shared.write")) {
      throw chatWorkflowError("CHAT_WORKFLOW_CONTINUATION_CONTEXT_REQUIRED", "缺少共享会话续跑的执行权限上下文", 403);
    }
    this.ctx.db.db.transaction(() => {
      const now = Date.now();
      this.ctx.db.db.prepare("INSERT INTO chat_workflow_actions (request_id, task_id, actor_user_id, input_hash, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'processing', ?, ?)").run(input.requestId, task.id, actorUserId, inputHash, now, now);
      if (!task.continuationQueueItemId) {
        const before = this.ctx.db.threadQueueStates.getState(thread.id);
        const hasQueuedInput = this.ctx.db.threadMessageQueue.hasActiveByThread(thread.id);
        const { item } = this.ctx.db.threadMessageQueue.appendItem({
          workspaceId: thread.workspaceId, threadId: thread.id,
          text: [`本次不用工作流，请直接在当前会话继续处理「${task.title}」。`,
            "请承接已有分析和原始需求执行，不再为本任务推荐工作流；完成后汇总结果和验证情况。",
            `任务目标：${task.goal}`, task.context ? `已有上下文：${task.context}` : "",
            `验收条件：\n${task.acceptanceCriteria.map(text => `- ${text}`).join("\n")}`].filter(Boolean).join("\n\n"),
          images: [], files: [], originWebSessionId: null, clientItemId: `chat-workflow-dismiss:${task.id}`,
          sendOptions: { workMode: "general", accessMode: thread.accessMode, planMode: Boolean(thread.planMode), model: thread.model,
            effort: thread.effort, contextWindow: thread.contextWindow, autoCompactPct: thread.autoCompactPct, serviceTier: thread.serviceTier,
            roleId: thread.roleId, forceNewTurn: true },
          sharedWorkspaceToolContext: sharedContext ?? null,
          executionProfileContext: { userId: actorUserId, scope: thread.sharedWorkspaceId
            ? { scopeType: "shared_workspace", scopeId: thread.sharedWorkspaceId }
            : { scopeType: "local_workspace", scopeId: thread.workspaceId } },
        });
        task = this.repo.update({ ...task, state: "dismissed", continuationQueueItemId: item.id }, task.version);
        // 沿用普通新消息的规则：只解除没有其他待发项的历史停止，不恢复手动暂停。
        if (before.paused && !hasQueuedInput && ["user_stop", "rollback", "transient_cleanup"].includes(before.pausedReason ?? "")) {
          this.ctx.db.threadQueueStates.resume(thread.id, thread.workspaceId);
        }
      }
      this.ctx.db.db.prepare("UPDATE chat_workflow_actions SET state = 'completed', result_json = ?, updated_at = ? WHERE request_id = ?")
        .run(JSON.stringify({ continuationQueueItemId: task.continuationQueueItemId }), now, input.requestId);
    })();
    this.wakeContinuation(task, input.requestId);
    return this.view(task, actorUserId);
  }

  /** 通知被拒绝即停止后续派发，重试沿已保存的同一队列项恢复。 */
  private wakeContinuation(task: ChatWorkflowTask, requestId: string): void {
    if (!task.continuationQueueItemId) return;
    const item = this.ctx.db.threadMessageQueue.getById(task.continuationQueueItemId);
    if (item?.status !== "pending") return;
    try {
      const sent = this.ctx.send({ t: "thread.queue.changed", workspaceId: task.workspaceId as WorkspaceId, threadId: task.threadId as ThreadId, reason: "appended" });
      if (sent?.accepted === false) throw new Error("CHAT_WORKFLOW_CONTINUATION_DISPATCH_REJECTED", { cause: sent });
    } catch (error) {
      logger.error("chat-workflow", "continuation queue notification failed", { code: "CHAT_WORKFLOW_CONTINUATION_NOTIFY_FAILED", requestId, taskId: task.id,
        threadId: task.threadId, workspaceId: task.workspaceId, queueItemId: item.id, rootCause: error instanceof Error ? error.message : String(error) });
      throw Object.assign(chatWorkflowError("CHAT_WORKFLOW_CONTINUATION_NOTIFY_FAILED", "已保存会话续跑任务，但通知失败，请重试；不会重复提交", 503), { cause: error });
    }
    try {
      if (!this.ctx.queueDispatcher) throw new Error("会话调度尚未就绪");
      this.ctx.queueDispatcher.kickIfIdle(task.threadId as ThreadId);
    } catch (error) {
      logger.error("chat-workflow", "continuation wake failed after persistence", { code: "CHAT_WORKFLOW_CONTINUATION_WAKE_FAILED", requestId, taskId: task.id,
        threadId: task.threadId, workspaceId: task.workspaceId, queueItemId: item.id, rootCause: error instanceof Error ? error.message : String(error) });
      throw chatWorkflowError("CHAT_WORKFLOW_CONTINUATION_WAKE_FAILED", "已保存会话续跑任务，但调度失败，请点击继续处理重试；不会重复提交", 503);
    }
  }
}

type Handler = (ctx: ApiHandlerContext, req: ApiRequestMessage) => void | Promise<void>;
async function invokeHandler(ctx: ApiHandlerContext, handler: Handler, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: { status: number; body: Record<string, unknown> } | null = null;
  const id = crypto.randomUUID();
  await handler({ ...ctx, send: message => {
    if (message.t === "api.res" && message.id === id) response = { status: message.status, body: message.body as Record<string, unknown> };
    else ctx.send(message);
  } }, { id, method: "orch.chat.internal", path: "/orch/chat/internal", body } as ApiRequestMessage);
  const result = response as { status: number; body: Record<string, unknown> } | null;
  if (!result || result.status >= 400 || result.body.ok !== true) throw chatWorkflowError(String(result?.body.code ?? "CHAT_WORKFLOW_EXECUTION_FAILED"), String(result?.body.message ?? "工作流操作未返回结果"), result?.status ?? 500);
  return result.body;
}

/** 模型工具只读取和准备方案；用户决定必须走经认证的会话操作接口。 */
export function buildChatWorkflowToolRegistry(): ExecutableToolRegistry {
  return { tools: [{ toolsetId: "__runtime_chat_workflow__" as any, toolsetName: "会话工作流", toolId: CHAT_WORKFLOW_TOOL_ID as any,
    name: "会话工作流", runtime: "builtin", code: "", permissions: { requiresWrite: false },
    description: "查询当前会话工作流与可用流程，推荐执行方案，或准备返工方案。方案以卡片展示，只有用户确认才执行。",
    inputSchema: JSON.stringify({ type: "object", required: ["action"], properties: {
      action: { type: "string", enum: ["list", "recommend", "plan_rework"] }, workflowId: { type: "string" }, taskId: { type: "string" }, nodeId: { type: "string" },
      title: { type: "string" }, goal: { type: "string" }, context: { type: "string" }, rationale: { type: "string" }, reason: { type: "string" }, acceptanceCriteria: { type: "array", items: { type: "string" } },
    }, additionalProperties: false }),
  }] };
}

export function executeChatWorkflowTool(ctx: ApiHandlerContext, input: { workspaceId: string; threadId: string; turnId: string; actorUserId: string }, raw: unknown) {
  try {
    const service = new ChatWorkflowService(ctx);
    const args = raw as Record<string, unknown>;
    let output: unknown;
    if (args?.action === "list") output = { ...service.snapshot(input.workspaceId, input.threadId, input.actorUserId), workflows: ctx.orchAssetRuntimeRead?.openWorkspace(input.workspaceId as WorkspaceId).listAssets("workflow").map(w => ({ id: w.assetId, name: w.definition.name, description: w.definition.description, stages: w.definition.nodes.map(n => n.label) })) ?? [] };
    else if (args?.action === "recommend") output = service.recommend({ ...input, workflowId: String(args.workflowId ?? ""), title: String(args.title ?? ""), goal: String(args.goal ?? ""), context: String(args.context ?? ""), rationale: String(args.rationale ?? ""), acceptanceCriteria: Array.isArray(args.acceptanceCriteria) ? args.acceptanceCriteria.map(String).filter(t => t.trim()) : [] });
    else if (args?.action === "plan_rework") output = service.planRework(input.workspaceId, input.threadId, String(args.taskId ?? ""), String(args.nodeId ?? ""), String(args.reason ?? ""), input.actorUserId);
    else throw chatWorkflowError("CHAT_WORKFLOW_TOOL_INPUT_INVALID", "不支持的工作流工具操作", 400);
    return { ok: true as const, output, durationMs: 0 };
  } catch (error) {
    const code = String((error as { code?: string }).code ?? "CHAT_WORKFLOW_TOOL_FAILED");
    const message = error instanceof Error ? error.message : String(error);
    logger.error("chat-workflow", "workflow tool failed", { code, requestId: input.turnId, workspaceId: input.workspaceId, threadId: input.threadId, cause: message });
    return { ok: false as const, code, message, output: { code, message }, durationMs: 0 };
  }
}
