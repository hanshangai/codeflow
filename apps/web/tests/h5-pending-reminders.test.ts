import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import type { ReminderItem } from "@codeflowai/shared";

import { selectOfficeH5ChatReminderItems } from "../src/features/office-h5/pendingItems.ts";

const pendingPanelSource = fs.readFileSync("apps/web/src/features/office-h5/components/H5PendingPanel.vue", "utf8");

function reminder(id: string, sourceType: ReminderItem["sourceType"], updatedAt: number): ReminderItem {
  return {
    id,
    sourceType,
    workspaceId: "client-a:workspace-a" as any,
    title: id,
    statusLabel: "unread",
    tone: "success",
    summary: null,
    updatedAt,
    isActionRequired: false,
    readState: "unread",
    primaryActionKind: "open_chat_thread",
    primaryActionLabel: "open",
    ignoreMarker: id,
    routeTarget: { workspaceId: "client-a:workspace-a" as any, threadId: ("thread-" + id) as any },
  };
}

test("H5 pending filters chat reminders and sorts newest first", () => {
  const items = selectOfficeH5ChatReminderItems([
    reminder("chat-old", "chat", 100),
    reminder("orch", "orchestration", 300),
    reminder("chat-new", "chat", 200),
  ]);

  assert.deepEqual(items.map((item) => item.id), ["chat-new", "chat-old"]);
  assert.ok(items.every((item) => item.sourceType === "chat"));
});

test("H5 pending groups workflow items by requirement and removes the old hero copy", () => {
  assert.match(pendingPanelSource, /const pendingRequirementGroups = computed<PendingRequirementGroup\[\]>/u);
  assert.match(pendingPanelSource, /item\.intake\.id \?\? item\.reminder\.routeTarget\.intakeId/u);
  assert.match(pendingPanelSource, /v-for="group in pendingRequirementGroups"/u);
  assert.match(pendingPanelSource, /class="h5-pending-panel__refresh"/u);
  assert.doesNotMatch(pendingPanelSource, /在手机上处理流程与查收会话/u);
  assert.doesNotMatch(pendingPanelSource, /同时展示流程审核事项和电脑端会话完成后的待查收提醒/u);
});

test("H5 pending detail loads the canonical instance and artifact context", () => {
  assert.match(pendingPanelSource, /getOfficeH5OrchInstance/u);
  assert.match(pendingPanelSource, /listOfficeH5OrchArtifacts/u);
  for (const label of ["当前原因", "业务结论", "关联结果", "验收检查", "补充意见"]) {
    assert.match(pendingPanelSource, new RegExp(label, "u"));
  }
  assert.match(pendingPanelSource, /resolveNodeWorkbenchDescriptor\(selectedNodeState\.value\)/u);
  assert.match(pendingPanelSource, /else \{\s*closePendingDetail\(\);\s*successMessage\.value = "该待办已处理，已返回列表。";/u);
  assert.match(
    pendingPanelSource,
    /async function refreshVisiblePending\(\): Promise<void> \{\s*await refreshPending\(\{ focusDeepLink: false \}\);\s*if \(selectedPendingItem\.value\) await openPendingDetail\(selectedPendingItem\.value\);/u,
  );
});

test("H5 pending detail exposes confirmed terminate skip and submit actions", () => {
  assert.match(pendingPanelSource, /\{ key: "terminate", label: "终止", tone: "danger" \}/u);
  assert.match(pendingPanelSource, /\{ key: "skip", label: "跳过", tone: "neutral" \}/u);
  assert.match(pendingPanelSource, /\{ key: "request_changes", label: "要求修改", tone: "warning" \}/u);
  assert.match(pendingPanelSource, /\{ key: "submit", label: "提交", tone: "primary" \}/u);
  assert.match(pendingPanelSource, /if \(action === "terminate"\) return "abort";/u);
  assert.match(pendingPanelSource, /if \(action === "submit"\) return "resume_with_input";/u);
  assert.match(pendingPanelSource, /Modal\.confirm\(\{[\s\S]+确认终止本次流程/u);
  assert.match(pendingPanelSource, /确认跳过节点/u);
});

test("H5 pending recovery only continues the existing session", () => {
  assert.doesNotMatch(pendingPanelSource, /recoveryChoiceRequired/u);
  assert.doesNotMatch(pendingPanelSource, /retry-existing/u);
  assert.doesNotMatch(pendingPanelSource, /action === "new-thread"/u);
});

test("H5 pending detail gives each mobile action a distinct semantic color", () => {
  for (const tone of ["danger", "neutral", "warning", "primary"]) {
    assert.match(pendingPanelSource, new RegExp(`h5-pending-detail__action--${tone}`, "u"));
  }
  assert.match(pendingPanelSource, /action--danger[\s\S]*var\(--app-danger\)/u);
  assert.match(pendingPanelSource, /action--warning[\s\S]*var\(--app-warning\)/u);
  assert.match(pendingPanelSource, /action--neutral[\s\S]*var\(--app-muted\)/u);
  assert.match(pendingPanelSource, /action--primary[\s\S]*background: #2c6b58;/u);
  assert.match(pendingPanelSource, /\.h5-pending-detail__actions button \{[\s\S]*appearance: none;/u);
  assert.match(pendingPanelSource, /\.h5-pending-detail__actions button:focus-visible/u);
});

test("H5 pending polling pauses in detail and keeps the mobile controls stable", () => {
  assert.match(pendingPanelSource, /if \(document\.hidden \|\| selectedPendingItem\.value\) return;/u);
  assert.match(pendingPanelSource, /void refreshPending\(\{ focusDeepLink: false \}\);\s*\}, 60_000\);/u);
  assert.match(
    pendingPanelSource,
    /<header class="h5-pending-panel__toolbar">[\s\S]*class="h5-pending-panel__summary"[\s\S]*class="h5-pending-panel__refresh"[\s\S]*<\/header>/u,
  );
  assert.match(pendingPanelSource, /grid-template-columns: repeat\(auto-fit, minmax\(64px, 1fr\)\);/u);
  assert.match(pendingPanelSource, /\.h5-pending-detail__actions button \{[\s\S]*min-height: 44px;/u);
});
