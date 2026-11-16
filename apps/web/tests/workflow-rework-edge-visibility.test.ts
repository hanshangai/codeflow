import assert from "node:assert/strict";
import test from "node:test";
import { effectScope, ref, type EffectScope } from "vue";

import { useWorkflowReworkEdgeVisibility } from "../src/features/orchestration/composables/useWorkflowReworkEdgeVisibility.ts";

const scopes: EffectScope[] = [];
let environment: ReturnType<typeof installWindow>;

/** 用可注入失败的存储和真实事件分发验证同页、跨页签同步。 */
function installWindow() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const stored = new Map<string, string>();
  const failures = { read: null as Error | null, write: null as Error | null };
  let reads = 0;
  const target = Object.assign(new EventTarget(), {
    localStorage: {
      getItem(key: string): string | null {
        reads += 1;
        if (failures.read) throw failures.read;
        return stored.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        if (failures.write) throw failures.write;
        stored.set(key, value);
      },
    },
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  return {
    target, stored, failures,
    readCount: () => reads,
    restore: () => {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    },
  };
}

/** 每个画布使用独立作用域，卸载后必须停止监听和偏好跟踪。 */
function bindPreference(workspaceId = ref("ws-a"), workflowId = ref("tdd")) {
  const scope = effectScope();
  scopes.push(scope);
  const preference = scope.run(() => useWorkflowReworkEdgeVisibility(() => workspaceId.value, () => workflowId.value))!;
  return { ...preference, scope };
}

/** 使用既有存储键验证兼容性，避免测试跟随实现一起换键而漏掉历史偏好。 */
function key(workspaceId = "ws-a", workflowId = "tdd"): string {
  return `codeflow-orch-rework-edges:${workspaceId}:${workflowId}`;
}

/** 模拟其他页签事件；newValue 可以比当前存储更旧。 */
function storageEvent(storageKey: string | null, newValue: string | null): void {
  const event = new Event("storage");
  Object.defineProperties(event, { key: { value: storageKey }, newValue: { value: newValue } });
  environment.target.dispatchEvent(event);
}

test.beforeEach(() => {
  environment = installWindow();
});
test.afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  environment.restore();
});

test("资产库已有隐藏设置在新开的实例、预览及重新挂载后仍生效", () => {
  environment.stored.set(key(), "0");
  const first = bindPreference();
  const second = bindPreference();
  assert.equal(first.showReworkEdges.value, false);
  assert.equal(second.showReworkEdges.value, false);
  first.scope.stop();
  assert.equal(bindPreference().showReworkEdges.value, false);
});

test("缺省显示；任一画布切换后同流程画布立即同步，且存储保留结果", () => {
  const editor = bindPreference();
  const instance = bindPreference();
  assert.equal(editor.showReworkEdges.value, true);
  assert.equal(editor.setReworkEdgeVisibility(false), true);
  assert.equal(instance.showReworkEdges.value, false);
  assert.equal(environment.stored.get(key()), "0");
  assert.equal(instance.setReworkEdgeVisibility(true), true);
  assert.equal(editor.showReworkEdges.value, true);
  assert.equal(environment.stored.get(key()), "1");
});

test("切换工作流和工作区立即读取对应偏好，不把原流程设置写到新流程", () => {
  environment.stored.set(key("ws-a", "tdd"), "0");
  environment.stored.set(key("ws-b", "loop"), "0");
  const workspaceId = ref("ws-a");
  const workflowId = ref("tdd");
  const graph = bindPreference(workspaceId, workflowId);
  const oldGraph = bindPreference();
  workflowId.value = "loop";
  assert.equal(graph.showReworkEdges.value, true);
  workspaceId.value = "ws-b";
  assert.equal(graph.showReworkEdges.value, false);
  graph.setReworkEdgeVisibility(true);
  assert.equal(environment.stored.get(key("ws-b", "loop")), "1");
  assert.equal(environment.stored.get(key()), "0");
  assert.equal(oldGraph.showReworkEdges.value, false);
});

test("跨页签更新读取最新存储，迟到事件、其他流程、删除和清空不会串用偏好", () => {
  const graph = bindPreference();
  environment.stored.set(key(), "0");
  storageEvent(key("ws-b"), "0");
  assert.equal(graph.showReworkEdges.value, true);
  storageEvent(key(), "1");
  assert.equal(graph.showReworkEdges.value, false);
  environment.stored.delete(key());
  storageEvent(key(), null);
  assert.equal(graph.showReworkEdges.value, true);
  graph.setReworkEdgeVisibility(false);
  environment.stored.clear();
  storageEvent(null, null);
  assert.equal(graph.showReworkEdges.value, true);
});

test("异步到达工作流定义时读取隐藏设置，无定义时不写存储", () => {
  environment.stored.set(key(), "0");
  const workflowId = ref("");
  const graph = bindPreference(ref("ws-a"), workflowId);
  assert.equal(graph.setReworkEdgeVisibility(false), false);
  workflowId.value = "tdd";
  assert.equal(graph.showReworkEdges.value, false);
});

test("画布卸载后不响应全局通知，也不保留旧流程监听", () => {
  const graph = bindPreference();
  const other = bindPreference();
  graph.scope.stop();
  const reads = environment.readCount();
  other.setReworkEdgeVisibility(false);
  assert.equal(graph.showReworkEdges.value, true);
  assert.equal(environment.readCount(), reads + 1);
  other.scope.stop();
  const finalReads = environment.readCount();
  storageEvent(key(), "1");
  assert.equal(environment.readCount(), finalReads);
});

test("读取失败显式报错，切换流程不沿用旧状态，重试成功后恢复", (context) => {
  const logs: unknown[][] = [];
  context.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  const workflowId = ref("tdd");
  const graph = bindPreference(ref("ws-a"), workflowId);
  environment.stored.set(key("ws-a", "loop"), "0");
  environment.failures.read = new Error("storage disabled");
  workflowId.value = "loop";
  assert.equal(graph.showReworkEdges.value, false);
  assert.equal(graph.preferenceError.value, "读取退回线显示设置失败，请重试");
  assert.equal(graph.setReworkEdgeVisibility(true), false);
  assert.equal(logs.length, 1);
  assert.equal((logs[0]![1] as { errorCode: string }).errorCode, "WORKFLOW_REWORK_PREFERENCE_READ_FAILED");
  environment.failures.read = null;
  assert.equal(graph.reloadVisibility(), true);
  assert.equal(graph.preferenceError.value, null);
  assert.equal(graph.showReworkEdges.value, false);
});

test("保存失败不改变任何画布或持久化结果，恢复后可以再次切换", (context) => {
  const logs: unknown[][] = [];
  context.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  const editor = bindPreference();
  const instance = bindPreference();
  environment.failures.write = new Error("quota exceeded");
  assert.equal(editor.setReworkEdgeVisibility(false), false);
  assert.equal(editor.showReworkEdges.value, true);
  assert.equal(instance.showReworkEdges.value, true);
  assert.equal(environment.stored.has(key()), false);
  assert.equal(editor.preferenceError.value, "保存退回线显示设置失败，请重试");
  assert.equal(logs.length, 1);
  const log = logs[0]![1] as { errorCode: string; requestId: unknown; workspaceId: string; workflowId: string; error: unknown };
  assert.equal(log.errorCode, "WORKFLOW_REWORK_PREFERENCE_WRITE_FAILED");
  assert.equal(log.requestId, null);
  assert.equal(log.workspaceId, "ws-a");
  assert.equal(log.workflowId, "tdd");
  assert.equal(log.error, environment.failures.write);
  environment.failures.write = null;
  assert.equal(editor.reloadVisibility(), true);
  assert.equal(editor.setReworkEdgeVisibility(false), true);
  assert.equal(instance.showReworkEdges.value, false);
});
