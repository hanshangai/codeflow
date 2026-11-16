import assert from "node:assert/strict";
import test from "node:test";

import { canLoadSoftwareUpdateStatus, resolveSoftwareUpdateWorkspaceId } from "../src/features/settings/softwareUpdateScope.ts";

/** 桌面本机 CLI 安装是全局能力；只有 Web 或无本机 Client 时才依赖 Server 与工作区。 */
test("desktop local runtime loads CLI status without login or workspace", () => {
  const scope = { connected: false, isDesktop: true, localRuntimeReady: true, workspaceId: "" };
  assert.equal(canLoadSoftwareUpdateStatus(scope), true);
  assert.equal(resolveSoftwareUpdateWorkspaceId(scope), "");
  assert.equal(resolveSoftwareUpdateWorkspaceId({ ...scope, workspaceId: "stale:ws" }), "");
  assert.equal(resolveSoftwareUpdateWorkspaceId({ ...scope, workspaceId: "local-data:ws", workspaceIsLocal: true }), "local-data:ws");
});

/** 连接 Server 时保持原工作区作用域，避免改变云端 Client 路由。 */
test("connected scope keeps the selected workspace", () => {
  const scope = { connected: true, isDesktop: true, localRuntimeReady: true, workspaceId: "local-data:ws" };
  assert.equal(canLoadSoftwareUpdateStatus(scope), true);
  assert.equal(resolveSoftwareUpdateWorkspaceId(scope), "local-data:ws");
});

/** 浏览器或本机 Client 未就绪时仍保持原有登录/工作区门禁。 */
test("web and unavailable local runtime keep the existing gates", () => {
  for (const scope of [
    { connected: false, isDesktop: false, localRuntimeReady: false, workspaceId: "" },
    { connected: false, isDesktop: true, localRuntimeReady: false, workspaceId: "stale:ws" },
  ]) {
    assert.equal(canLoadSoftwareUpdateStatus(scope), false);
    assert.equal(resolveSoftwareUpdateWorkspaceId(scope), scope.workspaceId);
  }
});
