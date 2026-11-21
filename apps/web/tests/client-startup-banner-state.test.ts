import assert from "node:assert/strict";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";

import { useClientStartupBanner } from "../src/components/app-shell/useClientStartupBanner.ts";
import type { ActiveWorkspaceRuntimeState } from "../src/store/presence.ts";
import { useConfigStore } from "../src/store/config.ts";
import { useWorkspacesStore } from "../src/store/workspaces.ts";

/** 构造共享工作区的最小状态，覆盖角色和运行态变化。 */
function fixture() {
  setActivePinia(createPinia());
  const config = useConfigStore();
  const workspaces = useWorkspacesStore();
  config.workspaceId = "shared:ws";
  config.desktopRuntime = { status: "failed", requestId: "local", releaseId: null, errorCode: "CLIENT_BOOT_FAILED" };
  config.desktopError = "CLIENT_BOOT_FAILED";
  workspaces.workspaces = [{
    id: "shared:ws", title: "Shared", path: "/shared", kind: "shared",
    shared: { currentUserRole: "member" }, createdAt: 1, updatedAt: 1,
  }] as any;
  const runtimeState = ref<ActiveWorkspaceRuntimeState>({ kind: "shared", status: "offline" });
  return { config, workspaces, runtimeState };
}

test("关闭状态跨视图实例共享，角色或运行态变化后重新显示", () => {
  const f = fixture();
  const first = useClientStartupBanner(f.runtimeState);
  const second = useClientStartupBanner(f.runtimeState);
  assert.equal(first.visible.value, true);
  assert.equal(first.canManageSharedWorkspace.value, false);

  first.dismiss();
  assert.equal(first.visible.value, false);
  assert.equal(second.visible.value, false, "不同视图实例共享关闭状态");

  f.workspaces.workspaces = [{
    id: "shared:ws", title: "Shared", path: "/shared", kind: "shared",
    shared: { currentUserRole: "workspace_admin" }, createdAt: 1, updatedAt: 1,
  }] as any;
  assert.equal(first.currentSharedRole.value, "workspace_admin");
  assert.equal(first.canManageSharedWorkspace.value, true);
  assert.equal(first.visible.value, true, "角色变化后重新提示");

  first.dismiss();
  f.runtimeState.value = { kind: "shared", status: "unknown" };
  assert.equal(first.visible.value, true, "运行态变化后重新提示");
});
