import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OrchestrationId } from "../../packages/shared/src/index.ts";

import { migrateClientDb } from "../../apps/desktop/client/src/db/migrateClientDb.ts";
import { OrchNodeWorkItemRepo } from "../../apps/desktop/client/src/db/repos/orchNodeWorkItemRepo.ts";
import { openSqliteDb } from "../../apps/desktop/client/src/db/sqliteDb.ts";

test("OrchNodeWorkItemRepo enforces one in-progress item and strict order", () => {
  const fixture = createFixture();
  try {
    const created = fixture.repo.createMany({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      actorAttemptId: "attempt-1",
      items: [
        { clientKey: "asset:a", title: "生成 A", sourceKey: "a", outputPath: "docs/a.md" },
        { clientKey: "asset:b", title: "生成 B", sourceKey: "b", outputPath: "docs/b.md" },
        { clientKey: "asset:c", title: "生成 C", sourceKey: "c", outputPath: "docs/c.md" },
      ],
    });
    assert.equal(created.summary.total, 3);
    assert.equal(created.summary.completed, 0);
    assert.equal(created.items[0]?.sortOrder, 1000);

    assert.throws(
      () => fixture.repo.update({
        instanceId: fixture.instanceId,
        nodeId: fixture.nodeId,
        itemId: created.items[1]!.id,
        expectedVersion: 1,
        patch: { status: "in_progress" },
      }),
      /只能处理首个未完成工作项/,
    );

    const started = fixture.repo.update({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: created.items[0]!.id,
      expectedVersion: 1,
      patch: { status: "in_progress" },
    });
    assert.equal(started.item.status, "in_progress");
    assert.equal(started.item.version, 2);

    assert.throws(
      () => fixture.repo.createMany({
        instanceId: fixture.instanceId,
        nodeId: fixture.nodeId,
        items: [{ clientKey: "asset:insert", title: "插队", sortOrder: 0 }],
      }),
      /不能通过排序或新增工作项插队/,
    );
    assert.equal(fixture.repo.getSummary(fixture.instanceId, fixture.nodeId).total, 3);

    const completed = fixture.repo.complete({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: started.item.id,
      expectedVersion: 2,
      resultSummary: "A 详情已生成并核对",
      evidence: ["src/a.ts", "docs/a.md"],
      outputPath: "docs/a.md",
    });
    assert.equal(completed.item.status, "completed");
    assert.equal(completed.nextItem?.clientKey, "asset:b");
    assert.equal(completed.summary.completed, 1);
    assert.equal(completed.summary.progressPercent, 33);
  } finally {
    fixture.close();
  }
});

test("OrchNodeWorkItemRepo keeps clientKey idempotent and uses CAS", () => {
  const fixture = createFixture();
  try {
    const first = fixture.repo.createMany({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      items: [{ clientKey: "stable-key", title: "稳定工作项", sourceKey: "source" }],
    });
    const replay = fixture.repo.createMany({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      items: [{ clientKey: "stable-key", title: "稳定工作项", sourceKey: "source" }],
    });
    assert.equal(replay.items[0]?.id, first.items[0]?.id);
    assert.deepEqual(replay.idempotentClientKeys, ["stable-key"]);
    assert.equal(replay.summary.boardVersion, first.summary.boardVersion);

    const updated = fixture.repo.update({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: first.items[0]!.id,
      expectedVersion: 1,
      patch: { description: "补充说明" },
    });
    assert.equal(updated.item.version, 2);
    assert.throws(
      () => fixture.repo.update({
        instanceId: fixture.instanceId,
        nodeId: fixture.nodeId,
        itemId: first.items[0]!.id,
        expectedVersion: 1,
        patch: { title: "迟到更新" },
      }),
      /当前版本 2/,
    );
  } finally {
    fixture.close();
  }
});

test("OrchNodeWorkItemRepo atomically rejects damaged output paths at every write boundary", () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () => fixture.repo.createMany({
        instanceId: fixture.instanceId,
        nodeId: fixture.nodeId,
        items: [
          { clientKey: "asset:valid", title: "合法中文路径", outputPath: "文档/详情.md" },
          { clientKey: "asset:damaged", title: "损坏路径", outputPath: "文档/详\uFFFD.md" },
        ],
      }),
      (error: any) => {
        assert.equal(error?.code, "INVALID_OUTPUT_PATH_TEXT");
        assert.match(String(error?.message ?? ""), /U\+FFFD/);
        return true;
      },
    );
    assert.equal(fixture.repo.getBoard(fixture.instanceId, fixture.nodeId), null);
    assert.equal(fixture.repo.getSummary(fixture.instanceId, fixture.nodeId).total, 0);
    assert.deepEqual(fixture.repo.listEvents({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
    }).events, []);

    const created = fixture.repo.createMany({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      items: [{ clientKey: "asset:utf8", title: "合法中文路径", outputPath: "文档/资产详情.md" }],
    });
    const beforeItem = structuredClone(created.items[0]!);
    const beforeSummary = fixture.repo.getSummary(fixture.instanceId, fixture.nodeId);
    assert.equal(beforeItem.outputPath, "文档/资产详情.md");

    assert.throws(
      () => fixture.repo.update({
        instanceId: fixture.instanceId,
        nodeId: fixture.nodeId,
        itemId: beforeItem.id,
        expectedVersion: beforeItem.version,
        patch: { outputPath: "文档/资\uFFFD详情.md" },
      }),
      (error: any) => {
        assert.equal(error?.code, "INVALID_OUTPUT_PATH_TEXT");
        return true;
      },
    );
    assert.deepEqual(fixture.repo.get(fixture.instanceId, fixture.nodeId, beforeItem.id), beforeItem);
    assert.deepEqual(fixture.repo.getSummary(fixture.instanceId, fixture.nodeId), beforeSummary);
  } finally {
    fixture.close();
  }

  const completionFixture = createFixture();
  try {
    const created = completionFixture.repo.createMany({
      instanceId: completionFixture.instanceId,
      nodeId: completionFixture.nodeId,
      items: [{ clientKey: "asset:legacy-no-path", title: "历史空路径工作项" }],
    });
    const started = completionFixture.repo.update({
      instanceId: completionFixture.instanceId,
      nodeId: completionFixture.nodeId,
      itemId: created.items[0]!.id,
      expectedVersion: created.items[0]!.version,
      patch: { status: "in_progress" },
    });
    const beforeItem = structuredClone(started.item);
    const beforeSummary = completionFixture.repo.getSummary(
      completionFixture.instanceId,
      completionFixture.nodeId,
    );

    assert.throws(
      () => completionFixture.repo.complete({
        instanceId: completionFixture.instanceId,
        nodeId: completionFixture.nodeId,
        itemId: started.item.id,
        expectedVersion: started.item.version,
        resultSummary: "不应写入损坏路径",
        outputPath: "文档/历史资\uFFFD.md",
      }),
      (error: any) => {
        assert.equal(error?.code, "INVALID_OUTPUT_PATH_TEXT");
        return true;
      },
    );
    assert.deepEqual(
      completionFixture.repo.get(completionFixture.instanceId, completionFixture.nodeId, started.item.id),
      beforeItem,
    );
    assert.deepEqual(
      completionFixture.repo.getSummary(completionFixture.instanceId, completionFixture.nodeId),
      beforeSummary,
    );
  } finally {
    completionFixture.close();
  }
});

test("OrchNodeWorkItemRepo repairs only reopened pending items with a legacy U+FFFD output path", () => {
  const fixture = createFixture();
  try {
    const damagedSegment = String.fromCodePoint(0xfffd).repeat(4);
    const created = fixture.repo.createMany({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      items: [{
        clientKey: "asset:legacy-damaged-path",
        title: "评审旧资产",
        sourceKey: "frontend:stable-source",
        outputPath: "codeflow-docs/legacy/detail.md",
        sortOrder: 19_000,
      }],
    });
    const started = fixture.repo.update({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: created.items[0]!.id,
      expectedVersion: created.items[0]!.version,
      patch: { status: "in_progress" },
    });
    fixture.repo.reopenMany({
      instanceId: fixture.instanceId,
      scopes: [{ nodeId: fixture.nodeId, mode: "all" }],
      reason: "恢复历史看板",
      allowInProgress: true,
    });
    fixture.db.prepare(
      "UPDATE orch_node_work_items SET title = ?, output_path = ? WHERE id = ?",
    ).run(
      `${damagedSegment} FE-COMP-stable ${damagedSegment}`,
      `codeflow-docs/${damagedSegment}/${damagedSegment}/stable.md`,
      started.item.id,
    );
    const damaged = fixture.repo.get(fixture.instanceId, fixture.nodeId, started.item.id)!;
    assert.equal(damaged.status, "pending");
    assert.ok(damaged.startedAt != null);
    assert.match(damaged.outputPath ?? "", /\uFFFD/);

    const repaired = fixture.repo.update({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: damaged.id,
      expectedVersion: damaged.version,
      patch: {
        title: "评审 FE-COMP-stable 详情",
        outputPath: "codeflow-docs/代码知识库/公共组件/前端组件/详情/stable.md",
      },
      reason: "修复历史 UTF-8 路径",
    });

    assert.equal(repaired.item.title, "评审 FE-COMP-stable 详情");
    assert.equal(repaired.item.outputPath, "codeflow-docs/代码知识库/公共组件/前端组件/详情/stable.md");
    assert.equal(repaired.item.sourceKey, "frontend:stable-source");
    assert.equal(repaired.item.sortOrder, 19_000);
    assert.equal(repaired.item.startedAt, damaged.startedAt);

    const restarted = fixture.repo.update({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: repaired.item.id,
      expectedVersion: repaired.item.version,
      patch: { status: "in_progress" },
    });
    assert.throws(
      () => fixture.repo.update({
        instanceId: fixture.instanceId,
        nodeId: fixture.nodeId,
        itemId: restarted.item.id,
        expectedVersion: restarted.item.version,
        patch: { outputPath: "codeflow-docs/other.md" },
      }),
      /工作项启动后不能改写 outputPath/,
    );
  } finally {
    fixture.close();
  }
});

test("OrchNodeWorkItemRepo freezes acceptance criteria after start and requires exact completion checks", () => {
  const fixture = createFixture();
  try {
    assert.throws(
      () => fixture.repo.createMany({
        instanceId: fixture.instanceId,
        nodeId: fixture.nodeId,
        items: [{
          clientKey: "asset:duplicate-criteria",
          title: "重复验收条件",
          acceptanceCriteria: [
            { id: "same", label: "第一项" },
            { id: "same", label: "第二项" },
          ],
        }],
      }),
      /验收条件 id 重复：same/,
    );
    const created = fixture.repo.createMany({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      items: [{
        clientKey: "asset:strict",
        title: "生成严格资产",
        sourceKey: "strict",
        outputPath: "docs/strict.md",
        acceptanceCriteria: [
          { id: "source-read", label: "已回读直接证据" },
          { id: "output-checked", label: "已核对输出文件" },
        ],
      }],
    });
    const strengthenedCriteria = [
      ...created.items[0]!.acceptanceCriteria,
      { id: "contract-written", label: "已归纳资产契约" },
    ];
    const strengthened = fixture.repo.update({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: created.items[0]!.id,
      expectedVersion: created.items[0]!.version,
      patch: { acceptanceCriteria: strengthenedCriteria },
    });
    const started = fixture.repo.update({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: strengthened.item.id,
      expectedVersion: strengthened.item.version,
      patch: { status: "in_progress" },
    });

    assert.throws(
      () => fixture.repo.update({
        instanceId: fixture.instanceId,
        nodeId: fixture.nodeId,
        itemId: started.item.id,
        expectedVersion: started.item.version,
        patch: { acceptanceCriteria: [] },
      }),
      /不能弱化或改写 acceptanceCriteria/,
    );
    assert.throws(
      () => fixture.repo.update({
        instanceId: fixture.instanceId,
        nodeId: fixture.nodeId,
        itemId: started.item.id,
        expectedVersion: started.item.version,
        patch: { acceptanceCriteria: strengthenedCriteria.slice(0, 1) },
      }),
      /不能弱化或改写 acceptanceCriteria/,
    );
    assert.throws(
      () => fixture.repo.complete({
        instanceId: fixture.instanceId,
        nodeId: fixture.nodeId,
        itemId: started.item.id,
        expectedVersion: started.item.version,
        resultSummary: "只检查了一部分",
        completionChecks: [{ criterionId: "source-read", evidence: "src/strict.ts" }],
      }),
      /仍有未检查验收条件：output-checked、contract-written/,
    );
    assert.throws(
      () => fixture.repo.complete({
        instanceId: fixture.instanceId,
        nodeId: fixture.nodeId,
        itemId: started.item.id,
        expectedVersion: started.item.version,
        resultSummary: "提交未知检查",
        completionChecks: [
          { criterionId: "source-read", evidence: "src/strict.ts" },
          { criterionId: "output-checked", evidence: "docs/strict.md" },
          { criterionId: "contract-written", evidence: "已归纳契约" },
          { criterionId: "unknown", evidence: "无效检查" },
        ],
      }),
      /引用未知验收条件：unknown/,
    );
    assert.throws(
      () => fixture.repo.complete({
        instanceId: fixture.instanceId,
        nodeId: fixture.nodeId,
        itemId: started.item.id,
        expectedVersion: started.item.version,
        resultSummary: "重复提交同一检查",
        completionChecks: [
          { criterionId: "source-read", evidence: "src/strict.ts" },
          { criterionId: "source-read", evidence: "再次提交" },
        ],
      }),
      /完成检查 criterionId 重复：source-read/,
    );

    const outputSha256 = "a".repeat(64);
    const completed = fixture.repo.complete({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: started.item.id,
      expectedVersion: started.item.version,
      resultSummary: "严格资产已生成并完成全部检查",
      evidence: ["src/strict.ts", "docs/strict.md"],
      completionChecks: [
        { criterionId: "source-read", evidence: "已回读 src/strict.ts" },
        { criterionId: "output-checked", evidence: "已核对 docs/strict.md" },
        { criterionId: "contract-written", evidence: "已归纳公开契约" },
      ],
      outputSha256,
    });
    assert.equal(completed.item.status, "completed");
    assert.deepEqual(completed.item.acceptanceCriteria, strengthenedCriteria);
    assert.equal(completed.item.completionChecks.length, 3);
    assert.equal(completed.item.outputSha256, outputSha256);
  } finally {
    fixture.close();
  }
});

test("OrchNodeWorkItemRepo lets a reopened legacy item append acceptance criteria without unlocking identity", () => {
  const fixture = createFixture();
  try {
    const created = fixture.repo.createMany({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      items: [{
        clientKey: "asset:legacy",
        title: "旧工作项",
        sourceKey: "legacy-source",
        outputPath: "docs/legacy.md",
      }],
    });
    const started = fixture.repo.update({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: created.items[0]!.id,
      expectedVersion: created.items[0]!.version,
      patch: { status: "in_progress" },
    });
    fixture.repo.reopenMany({
      instanceId: fixture.instanceId,
      scopes: [{ nodeId: fixture.nodeId, mode: "all" }],
      reason: "同步新版严格验收合同",
      allowInProgress: true,
    });
    const reopened = fixture.repo.get(fixture.instanceId, fixture.nodeId, started.item.id)!;
    const criteria = [
      { id: "source-read", label: "已回读直接证据" },
      { id: "output-checked", label: "已核对输出文件" },
    ];
    const strengthened = fixture.repo.update({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: reopened.id,
      expectedVersion: reopened.version,
      patch: { acceptanceCriteria: criteria },
    });

    assert.deepEqual(strengthened.item.acceptanceCriteria, criteria);
    assert.equal(strengthened.item.sourceKey, "legacy-source");
    assert.equal(strengthened.item.outputPath, "docs/legacy.md");
    assert.throws(
      () => fixture.repo.update({
        instanceId: fixture.instanceId,
        nodeId: fixture.nodeId,
        itemId: strengthened.item.id,
        expectedVersion: strengthened.item.version,
        patch: { acceptanceCriteria: [{ id: "changed", label: "改写旧条件" }] },
      }),
      /不能弱化或改写 acceptanceCriteria/,
    );
  } finally {
    fixture.close();
  }
});

test("OrchNodeWorkItemRepo soft-deletes only unstarted items and preserves audit events", () => {
  const fixture = createFixture();
  try {
    const created = fixture.repo.createMany({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      items: [
        { clientKey: "keep", title: "保留" },
        { clientKey: "remove", title: "删除" },
      ],
    });
    const removed = fixture.repo.delete({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: created.items[1]!.id,
      expectedVersion: 1,
      reason: "清单评审后确认不适用",
    });
    assert.ok(removed.item.deletedAt);
    assert.equal(removed.summary.total, 1);
    assert.equal(removed.summary.deleted, 1);

    const events = fixture.repo.listEvents({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: removed.item.id,
    });
    assert.deepEqual(events.events.map((event) => event.type), ["item_deleted", "item_created"]);
    assert.equal(events.events[0]?.payload?.reason, "清单评审后确认不适用");

    const page = fixture.repo.list({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      includeDeleted: true,
      limit: 1,
    });
    assert.equal(page.items.length, 1);
    assert.equal(page.hasMore, true);
    assert.ok(page.nextCursor);
  } finally {
    fixture.close();
  }
});

test("OrchNodeWorkItemRepo keeps one node board across execution attempts", () => {
  const fixture = createFixture();
  try {
    const created = fixture.repo.createMany({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      actorAttemptId: "attempt-1",
      items: [{ clientKey: "asset:stable", title: "生成稳定资产", outputPath: "docs/stable.md" }],
    });
    const started = fixture.repo.update({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: created.items[0]!.id,
      expectedVersion: 1,
      patch: { status: "in_progress" },
      actorAttemptId: "attempt-2",
    });
    const completed = fixture.repo.complete({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: started.item.id,
      expectedVersion: started.item.version,
      resultSummary: "稳定资产详情已生成",
      evidence: ["docs/stable.md"],
      actorAttemptId: "attempt-3",
    });

    assert.equal(completed.summary.completed, 1);
    assert.equal(completed.nextItem, null);
    const events = fixture.repo.listEvents({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: completed.item.id,
    });
    assert.deepEqual(
      events.events.map((event) => event.payload?.actorAttemptId),
      ["attempt-3", "attempt-2", "attempt-1"],
      "Attempt 只记录审计来源，不应创建新的工作项清单",
    );
  } finally {
    fixture.close();
  }
});

test("OrchNodeWorkItemRepo atomically reopens selected and fixed items across node boards", () => {
  const fixture = createFixture();
  try {
    completeBoard(fixture, "details", [
      { clientKey: "owner:a", title: "生成 A", sourceKey: "a", sortOrder: 1000 },
      { clientKey: "owner:b", title: "生成 B", sourceKey: "b", sortOrder: 2000 },
      { clientKey: "owner:finalize", title: "详情收口", sourceKey: "detail-report", sortOrder: 3000 },
    ]);
    completeBoard(fixture, "review", [
      { clientKey: "review:machine-gate", title: "机器门禁", sourceKey: "validation", sortOrder: 0 },
      { clientKey: "review:a", title: "评审 A", sourceKey: "a", sortOrder: 1000 },
      { clientKey: "review:b", title: "评审 B", sourceKey: "b", sortOrder: 2000 },
      { clientKey: "review:finalize", title: "评审收口", sourceKey: "review-report", sortOrder: 3000 },
    ]);
    const ownerBefore = fixture.repo.getSummary(fixture.instanceId, "details");
    const reviewBefore = fixture.repo.getSummary(fixture.instanceId, "review");
    const scopes = [
      { nodeId: "details", mode: "selected" as const, sourceKeys: ["b"], alwaysClientKeys: ["owner:finalize"] },
      { nodeId: "review", mode: "selected" as const, sourceKeys: ["b"], alwaysClientKeys: ["review:machine-gate", "review:finalize"] },
    ];

    assert.deepEqual(fixture.repo.validateReopenMany({ instanceId: fixture.instanceId, scopes }), [
      { nodeId: "details", selectedCount: 2, completedCount: 2, pendingCount: 0 },
      { nodeId: "review", selectedCount: 3, completedCount: 3, pendingCount: 0 },
    ]);
    const reopened = fixture.repo.reopenMany({
      instanceId: fixture.instanceId,
      scopes,
      reason: "B 的同类问题需要定向返工",
      actorAttemptId: "attempt-review",
      batchId: "batch-selected",
    });
    assert.equal(reopened.batchId, "batch-selected");
    assert.deepEqual(reopened.nodes.map((node) => [node.nodeId, node.reopenedClientKeys]), [
      ["details", ["owner:b", "owner:finalize"]],
      ["review", ["review:machine-gate", "review:b", "review:finalize"]],
    ]);
    assert.equal(reopened.nodes[0]?.summary.boardVersion, ownerBefore.boardVersion + 1);
    assert.equal(reopened.nodes[1]?.summary.boardVersion, reviewBefore.boardVersion + 1);

    const ownerItems = fixture.repo.list({ instanceId: fixture.instanceId, nodeId: "details" }).items;
    const reviewItems = fixture.repo.list({ instanceId: fixture.instanceId, nodeId: "review" }).items;
    assert.deepEqual(ownerItems.map((item) => [item.clientKey, item.status]), [
      ["owner:a", "completed"],
      ["owner:b", "pending"],
      ["owner:finalize", "pending"],
    ]);
    assert.deepEqual(reviewItems.map((item) => [item.clientKey, item.status]), [
      ["review:machine-gate", "pending"],
      ["review:a", "completed"],
      ["review:b", "pending"],
      ["review:finalize", "pending"],
    ]);
    assert.equal(ownerItems[1]?.resultSummary, null);
    assert.deepEqual(ownerItems[1]?.evidence, []);
    assert.deepEqual(ownerItems[1]?.completionChecks, []);
    assert.equal(ownerItems[1]?.outputSha256, null);
    const ownerReopenEvents = fixture.repo.listEvents({
      instanceId: fixture.instanceId,
      nodeId: "details",
      limit: 100,
    }).events.filter((event) => event.type === "item_reopened");
    assert.equal(ownerReopenEvents.length, 2);
    assert.ok(ownerReopenEvents.every((event) => event.payload?.batchId === "batch-selected"));

    const ownerVersionAfterSelected = fixture.repo.getSummary(fixture.instanceId, "details").boardVersion;
    fixture.repo.reopenMany({
      instanceId: fixture.instanceId,
      scopes: [{ nodeId: "details", mode: "all" }],
      reason: "领域整体失效",
      batchId: "batch-all",
    });
    const ownerAfterAll = fixture.repo.list({ instanceId: fixture.instanceId, nodeId: "details" }).items;
    assert.ok(ownerAfterAll.every((item) => item.status === "pending"));
    assert.equal(
      fixture.repo.getSummary(fixture.instanceId, "details").boardVersion,
      ownerVersionAfterSelected + 1,
      "同一看板批量重开多个工作项也只能递增一次版本",
    );
  } finally {
    fixture.close();
  }
});

test("OrchNodeWorkItemRepo rolls back every board when any reopen scope is invalid", () => {
  const fixture = createFixture();
  try {
    completeBoard(fixture, "details", [
      { clientKey: "owner:a", title: "生成 A", sourceKey: "a" },
      { clientKey: "owner:finalize", title: "详情收口", sourceKey: "detail-report" },
    ]);
    completeBoard(fixture, "review", [
      { clientKey: "review:a", title: "评审 A", sourceKey: "a" },
      { clientKey: "review:finalize", title: "评审收口", sourceKey: "review-report" },
    ]);
    const ownerBefore = fixture.repo.getSummary(fixture.instanceId, "details");
    const reviewBefore = fixture.repo.getSummary(fixture.instanceId, "review");

    assert.throws(
      () => fixture.repo.reopenMany({
        instanceId: fixture.instanceId,
        reason: "第二个节点范围无效",
        scopes: [
          { nodeId: "details", mode: "selected", sourceKeys: ["a"], alwaysClientKeys: ["owner:finalize"] },
          { nodeId: "review", mode: "selected", sourceKeys: ["missing"], alwaysClientKeys: ["review:finalize"] },
        ],
      }),
      /找不到返工 sourceKey：missing/,
    );
    assert.throws(
      () => fixture.repo.validateReopenMany({
        instanceId: fixture.instanceId,
        scopes: [{ nodeId: "details", mode: "selected", sourceKeys: ["a"], alwaysClientKeys: ["missing-finalize"] }],
      }),
      /找不到固定返工项：missing-finalize/,
    );
    assert.equal(fixture.repo.getSummary(fixture.instanceId, "details").boardVersion, ownerBefore.boardVersion);
    assert.equal(fixture.repo.getSummary(fixture.instanceId, "review").boardVersion, reviewBefore.boardVersion);
    assert.ok(fixture.repo.list({ instanceId: fixture.instanceId, nodeId: "details" }).items.every((item) => item.status === "completed"));
    assert.ok(fixture.repo.list({ instanceId: fixture.instanceId, nodeId: "review" }).items.every((item) => item.status === "completed"));
  } finally {
    fixture.close();
  }
});

test("OrchNodeWorkItemRepo only lets the Host reopen an interrupted in-progress item", () => {
  const fixture = createFixture();
  try {
    const created = fixture.repo.createMany({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      items: [
        { clientKey: "asset:active", title: "处理中资产", sourceKey: "active" },
        { clientKey: "asset:pending", title: "待处理资产", sourceKey: "pending" },
      ],
    });
    const started = fixture.repo.update({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: created.items[0]!.id,
      expectedVersion: created.items[0]!.version,
      patch: { status: "in_progress" },
    });
    const boardBefore = fixture.repo.getSummary(fixture.instanceId, fixture.nodeId);

    assert.throws(
      () => fixture.repo.reopenMany({
        instanceId: fixture.instanceId,
        scopes: [{ nodeId: fixture.nodeId, mode: "all" }],
        reason: "模型不得重开仍在执行的工作项",
      }),
      /仍在进行中，不能批量重开/,
    );
    const reopened = fixture.repo.reopenMany({
      instanceId: fixture.instanceId,
      scopes: [{ nodeId: fixture.nodeId, mode: "all" }],
      reason: "人工重跑前平台已中断节点执行",
      allowInProgress: true,
      batchId: "batch-manual-rerun",
    });
    assert.deepEqual(reopened.nodes[0]?.reopenedClientKeys, ["asset:active"]);
    assert.deepEqual(reopened.nodes[0]?.unchangedClientKeys, ["asset:pending"]);
    assert.equal(reopened.nodes[0]?.summary.boardVersion, boardBefore.boardVersion + 1);
    const items = fixture.repo.list({ instanceId: fixture.instanceId, nodeId: fixture.nodeId }).items;
    assert.ok(items.every((item) => item.status === "pending"));
    assert.equal(items[0]?.version, started.item.version + 1);
    const event = fixture.repo.listEvents({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      itemId: started.item.id,
    }).events.find((candidate) => candidate.type === "item_reopened");
    assert.equal(event?.payload?.previousStatus, "in_progress");
  } finally {
    fixture.close();
  }
});

test("OrchNodeWorkItemRepo searches the full board before applying pagination", () => {
  const fixture = createFixture();
  try {
    fixture.repo.createMany({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      items: [
        { clientKey: "asset:account", title: "账号详情", sourceKey: "account.ts", outputPath: "docs/account.md" },
        { clientKey: "asset:broker", title: "请求代理", sourceKey: "apps/desktop/client/src/ApiBroker.ts", outputPath: "docs/broker.md" },
        { clientKey: "asset:database", title: "数据库实体", sourceKey: "billing.ts", outputPath: "docs/database/billing.md" },
        { clientKey: "asset:percent", title: "100% 进度资产", sourceKey: "progress.ts", outputPath: "docs/progress.md" },
      ],
    });

    const sourceMatch = fixture.repo.list({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      search: "ApiBroker",
    });
    assert.deepEqual(sourceMatch.items.map((item) => item.clientKey), ["asset:broker"]);
    assert.equal(sourceMatch.summary.total, 4, "搜索不应改变看板总进度");

    const literalWildcard = fixture.repo.list({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      search: "%",
    });
    assert.deepEqual(literalWildcard.items.map((item) => item.clientKey), ["asset:percent"]);

    const firstPage = fixture.repo.list({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      search: "asset:",
      limit: 2,
    });
    const secondPage = fixture.repo.list({
      instanceId: fixture.instanceId,
      nodeId: fixture.nodeId,
      search: "asset:",
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    assert.equal(firstPage.hasMore, true);
    assert.deepEqual(
      [...firstPage.items, ...secondPage.items].map((item) => item.clientKey),
      ["asset:account", "asset:broker", "asset:database", "asset:percent"],
    );
  } finally {
    fixture.close();
  }
});

/** 创建并按顺序完成指定节点的整份测试看板。 */
function completeBoard(
  fixture: ReturnType<typeof createFixture>,
  nodeId: string,
  items: Array<{ clientKey: string; title: string; sourceKey: string; sortOrder?: number }>,
): void {
  const created = fixture.repo.createMany({
    instanceId: fixture.instanceId,
    nodeId,
    items,
  });
  for (const item of created.items) {
    const started = fixture.repo.update({
      instanceId: fixture.instanceId,
      nodeId,
      itemId: item.id,
      expectedVersion: item.version,
      patch: { status: "in_progress" },
    });
    fixture.repo.complete({
      instanceId: fixture.instanceId,
      nodeId,
      itemId: started.item.id,
      expectedVersion: started.item.version,
      resultSummary: `${started.item.clientKey} 已完成`,
      evidence: [`evidence/${started.item.sourceKey}.ts`],
    });
  }
}

/** 创建带最小工作区和编排实例外键的临时数据库。 */
function createFixture(): {
  instanceId: OrchestrationId;
  nodeId: string;
  db: ReturnType<typeof openSqliteDb>;
  repo: OrchNodeWorkItemRepo;
  close: () => void;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-orch-work-items-"));
  const db = openSqliteDb(path.join(tempDir, "client.db"));
  migrateClientDb(db);
  const instanceId = "orch-work-items-test" as OrchestrationId;
  db.prepare(`
    INSERT INTO workspaces (id, title, path, is_deleted, created_at, updated_at)
    VALUES ('workspace-work-items-test', 'Work Item Test', ?, 0, 1, 1)
  `).run(tempDir);
  db.prepare(`
    INSERT INTO orch_instances (
      id, workspace_id, workflow_id, workflow_snapshot_json, proposal_id, intake_snapshot_json,
      role_snapshots_json, toolset_snapshots_json, runtime_config_json, artifact_index_json,
      master_thread_id, status, node_states_json, created_at, updated_at
    ) VALUES (?, 'workspace-work-items-test', 'workflow-work-items-test', ?, NULL, ?, '{}', '{}', NULL, '{}', NULL, 'running', '{}', 1, 1)
  `).run(
    instanceId,
    JSON.stringify({ id: "workflow-work-items-test", nodes: [], edges: [] }),
    JSON.stringify({ id: "intake-work-items-test", workspaceId: "workspace-work-items-test", goal: "test" }),
  );
  return {
    instanceId,
    nodeId: "details",
    db,
    repo: new OrchNodeWorkItemRepo(db),
    close: () => {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
