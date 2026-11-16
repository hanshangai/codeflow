import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { WorkspaceId } from "../../packages/shared/src/index.ts";
import { openClientDb } from "../../apps/desktop/client/src/db/clientDb.ts";
import { backfillLegacyRequirementAnalysisThreads } from "../../apps/desktop/client/src/db/migrateClientDb.ts";

test("backfillLegacyRequirementAnalysisThreads 将旧需求分析会话迁移到 requirement-analysis thread 主线", () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-req-migration-"));
  const workspaceId = "client-test:ws-legacy-req" as WorkspaceId;
  const dbPath = path.join(workspacePath, "client.db");
  const targetThreadId = "req-analysis-legacy-1";

  const clientDb = openClientDb({ dbPath });
  try {
    clientDb.workspaces.upsert({ id: workspaceId, title: "tmp", path: workspacePath });

    clientDb.db.prepare(
      `INSERT INTO orch_requirement_analysis_sessions (
        id, workspace_id, title, status, phase, engine, model, effort,
        runtime_thread_id, engine_session_id, latest_turn_summary, latest_assistant_reply,
        last_message_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-session-1",
      String(workspaceId),
      "鲜花市场首页静态页（PC+移动端）",
      "active",
      "clarify",
      "codex",
      null,
      null,
      targetThreadId,
      "engine-session-legacy",
      "等待用户补充首页模块和风格",
      "请补充首页模块、风格和静态交付边界。",
      3000,
      1000,
      3000,
    );

    const insertMessage = clientDb.db.prepare(
      `INSERT INTO orch_requirement_analysis_messages (
        id, session_id, role, content, structured_payload_json, created_at
      ) VALUES (?, ?, ?, ?, NULL, ?)`,
    );
    insertMessage.run("legacy-msg-1", "legacy-session-1", "assistant", "欢迎描述您的需求。", 1100);
    insertMessage.run("legacy-msg-2", "legacy-session-1", "user", "我要做鲜花市场首页。", 2000);
    insertMessage.run("legacy-msg-3", "legacy-session-1", "assistant", "请补充首页模块和风格。", 3000);

    clientDb.db.prepare(
      `INSERT INTO orch_requirement_candidate_drafts (
        id, session_id, title, ready_to_create, candidate_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "candidate-legacy-1",
      "legacy-session-1",
      "鲜花市场首页静态页（PC+移动端）",
      0,
      JSON.stringify({
        id: "candidate-legacy-1",
        sessionId: "legacy-session-1",
        title: "鲜花市场首页静态页（PC+移动端）",
        goal: "实现一个可在 PC 和移动端访问的鲜花市场首页静态页面。",
        background: "旧模型下生成的需求候选。",
        acceptanceCriteria: [{ text: "首页主要内容可展示", blocking: true }],
        splitSource: "single",
        complexity: "standard",
        uiScope: "heavy",
        architectureRisk: "low",
        recommendedWorkflowId: null,
        recommendedWorkflowName: null,
        recommendedWorkflowReason: "等待补充信息后再锁定流程。",
        recommendedRoleIds: [],
        recommendedKnowledgeBundleIds: [],
        assetGaps: [],
        assumptions: [],
        openQuestions: ["首页模块清单未确认"],
        readyToCreate: false,
        createdAt: 2500,
        updatedAt: 3000,
      }),
      2500,
      3000,
    );

    backfillLegacyRequirementAnalysisThreads(clientDb.db);

    const thread = clientDb.threads.get(targetThreadId as any);
    assert.ok(thread);
    assert.equal(thread?.threadType, "chat");
    assert.equal(thread?.threadSubtype, "requirement-analysis");
    assert.equal(thread?.sessionId, "engine-session-legacy");

    const session = clientDb.orchRequirementAnalysisSessions.get(targetThreadId as any);
    assert.ok(session);
    assert.equal(session?.id, targetThreadId);
    assert.equal(session?.runtimeThreadId, targetThreadId);
    assert.equal(session?.phase, "clarify");

    const events = clientDb.conversationEvents.listByThread(targetThreadId as any);
    assert.deepEqual(
      events.map((event) => event.type),
      ["item.agentMessage.completed", "item.userMessage.created", "item.agentMessage.completed"],
    );
    assert.equal(String((events[0]?.payload as { text?: string } | undefined)?.text ?? ""), "欢迎描述您的需求。");
    assert.equal(String((events[1]?.payload as { text?: string } | undefined)?.text ?? ""), "我要做鲜花市场首页。");
    assert.equal(String((events[2]?.payload as { text?: string } | undefined)?.text ?? ""), "请补充首页模块和风格。");

    const candidates = clientDb.orchRequirementCandidateDrafts.listBySession(targetThreadId as any);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.sessionId, targetThreadId);

    const legacySessionRow = clientDb.db
      .prepare("SELECT id FROM orch_requirement_analysis_sessions WHERE id = ?")
      .get("legacy-session-1") as { id?: string } | undefined;
    assert.equal(legacySessionRow ?? null, null);
  } finally {
    clientDb.close();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

