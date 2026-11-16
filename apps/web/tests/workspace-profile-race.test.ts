import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { computed, effectScope, reactive, ref, watch, type Ref } from "vue";
import type { WorkspaceExecutionProfile, WorkspaceId, WorkspaceSummary } from "@codeflowai/shared";

type Pending = { workspaceId: WorkspaceId; text?: string; resolve(value: WorkspaceExecutionProfile): void; reject(error: unknown): void };
type Actions = {
  openEdit(workspace: WorkspaceSummary): void;
  loadWorkspaceProfile(workspaceId: WorkspaceId): Promise<boolean | void>;
  onProfileSave(text: string): Promise<boolean | void>;
  refreshProfile(): void;
  editOpen: Ref<boolean>; profileWorkspaceId: Ref<WorkspaceId | null>;
  profileValue: Ref<WorkspaceExecutionProfile | null>; profileLoading: Ref<boolean>;
  profileSaving: Ref<boolean>; profileError: Ref<string | null>;
};

/** 运行整个真实 SFC script，只替换服务、提示和组件生命周期注册边界。 */
function fixture(t: TestContext) {
  const source = readFileSync(new URL("../src/features/workspaces/components/workspace-manager.vue", import.meta.url), "utf8");
  const script = source.slice(source.indexOf(">") + 1, source.indexOf("</script>"));
  const ast = ts.createSourceFile("workspace-manager.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const code = ast.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getText(ast)).join("\n");
  const reads: Pending[] = [], writes: Pending[] = [], errors: string[] = [], successes: string[] = [];
  const logs: Record<string, unknown>[] = [], unmount: Array<() => void> = [];
  const scope = effectScope();
  t.after(() => scope.stop());
  const config = reactive({ canManageWorkspaces: true, isDesktop: true, connected: true });
  const sandbox: Record<string, any> = {
    Error, computed, ref, watch, onBeforeUnmount: (callback: () => void) => unmount.push(callback),
    defineOptions() {}, defineProps: () => ({ active: false, surface: "default" }),
    withDefaults: (props: unknown) => props, defineEmits: () => () => {},
    useConfigStore: () => config,
    usePresenceStore: () => ({ availableClients: [], clientForWorkspace: () => ({ clientId: "client" }) }),
    useApiContext: () => ({ ctx: ref({ serverWsOrigin: "ws://test", sessionToken: "test-account" }) }),
    useWorkspacesStore: () => ({
      workspaces: [], byId: new Map(),
      getExecutionProfile: (_ctx: unknown, workspaceId: WorkspaceId) => new Promise<WorkspaceExecutionProfile>((resolve, reject) => reads.push({ workspaceId, resolve, reject })),
      updateExecutionProfile: (_ctx: unknown, workspaceId: WorkspaceId, text: string) => new Promise<WorkspaceExecutionProfile>((resolve, reject) => writes.push({ workspaceId, text, resolve, reject })),
    }),
    message: { error: (text: string) => errors.push(text), success: (text: string) => successes.push(text) },
    console: { error: (_label: string, context: Record<string, unknown>) => logs.push(context) },
    isSharedWorkspaceDirectoryMigrationEntry: () => false, isSharedWorkspaceSelectionId: () => false,
  };
  scope.run(() => vm.runInNewContext(ts.transpileModule(`${code}\nglobalThis.actions = {
    openEdit, loadWorkspaceProfile, onProfileSave, refreshProfile, editOpen, profileWorkspaceId,
    profileValue, profileLoading, profileSaving, profileError,
  };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, sandbox));
  return { actions: sandbox.actions as Actions, reads, writes, errors, successes, logs, config,
    logging: sandbox.console as { error(label: string, context: Record<string, unknown>): void },
    unmount: () => unmount.forEach(callback => callback()) };
}

/** 提供两个不同物理工作区和可识别的 Profile 文本。 */
function workspace(id: string): WorkspaceSummary {
  return { id, title: id, path: `D:/${id}` } as WorkspaceSummary;
}

/** 响应形状沿原共享 Profile，文本由用例独立指定。 */
function profile(text: string): WorkspaceExecutionProfile {
  return { profileText: text, source: "workspace", updatedAt: 1 } as WorkspaceExecutionProfile;
}

/** 只排空确定的 Promise 续体，不依赖实际网络或计时器。 */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

test("late workspace A read cannot become workspace B text or its saved payload", async t => {
  const f = fixture(t), a = workspace("client:a"), b = workspace("client:b");
  f.actions.openEdit(a);
  f.actions.editOpen.value = false;
  f.actions.openEdit(b);
  f.reads[1]!.resolve(profile("B文本")); await settle();
  f.reads[0]!.resolve(profile("A文本")); await settle();
  assert.equal(f.actions.profileWorkspaceId.value, b.id);
  assert.equal(f.actions.profileValue.value?.profileText, "B文本");
  const saved = f.actions.onProfileSave(f.actions.profileValue.value!.profileText);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]!.workspaceId, b.id);
  assert.equal(f.writes[0]!.text, "B文本");
  f.writes[0]!.resolve(profile("B文本")); await saved;
});

test("closing and reopening the same workspace invalidates its previous read", async t => {
  const f = fixture(t), a = workspace("client:a");
  f.actions.openEdit(a); f.actions.editOpen.value = false; f.actions.openEdit(a);
  f.reads[1]!.resolve(profile("新文本")); await settle();
  f.reads[0]!.resolve(profile("旧文本")); await settle();
  assert.equal(f.actions.profileValue.value?.profileText, "新文本");
});

test("an older refresh cannot clear the newer request loading state", async t => {
  const f = fixture(t), a = workspace("client:a");
  f.actions.openEdit(a); f.actions.refreshProfile();
  f.reads[0]!.resolve(profile("旧读取")); await settle();
  assert.equal(f.actions.profileLoading.value, true);
  assert.equal(Boolean(f.actions.profileValue.value), false);
  f.reads[1]!.resolve(profile("新读取")); await settle();
  assert.equal(f.actions.profileLoading.value, false);
  assert.equal(f.actions.profileValue.value?.profileText, "新读取");
});

test("a stale read failure remains visible for its own workspace without poisoning the new panel", async t => {
  const f = fixture(t), a = workspace("client:a"), b = workspace("client:b");
  f.actions.openEdit(a); f.actions.openEdit(b);
  f.reads[1]!.resolve(profile("B文本")); await settle();
  const failure = Object.assign(new Error("A读取失败"), { code: "UNAVAILABLE", requestId: "request-a" });
  f.reads[0]!.reject(failure); await settle();
  assert.equal(f.actions.profileValue.value?.profileText, "B文本");
  assert.equal(f.actions.profileError.value, null);
  assert.equal(f.actions.profileLoading.value, false);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0]!.workspaceId, a.id);
  assert.equal(f.logs[0]!.requestId, "request-a");
  assert.match(f.errors[0]!, /client:a.*A读取失败/);
});

for (const close of ["close", "unmount"] as const) {
  test(`${close} clears the target and prevents late panel state resurrection`, async t => {
    const f = fixture(t);
    f.actions.openEdit(workspace("client:a"));
    if (close === "close") f.actions.editOpen.value = false;
    else f.unmount();
    f.reads[0]!.resolve(profile("已失效")); await settle();
    assert.equal(f.actions.profileWorkspaceId.value, null);
    assert.equal(f.actions.profileValue.value, null);
    assert.equal(f.actions.profileLoading.value, false);
  });
}

test("a previous workspace save cannot change the current workspace or release its pending save", async t => {
  const f = fixture(t), a = workspace("client:a"), b = workspace("client:b");
  f.actions.openEdit(a); f.reads[0]!.resolve(profile("A文本")); await settle();
  const savedA = f.actions.onProfileSave("A保存");
  f.actions.editOpen.value = false; f.actions.openEdit(b);
  f.reads[1]!.resolve(profile("B文本")); await settle();
  const savedB = f.actions.onProfileSave("B保存");
  f.writes[0]!.resolve(profile("A保存")); await savedA;
  assert.equal(f.actions.profileValue.value?.profileText, "B文本");
  assert.equal(f.actions.profileSaving.value, true);
  assert.match(f.successes[0]!, /client:a/);
  f.writes[1]!.resolve(profile("B保存")); await savedB;
  assert.equal(f.actions.profileSaving.value, false);
  assert.equal(f.actions.profileValue.value?.profileText, "B保存");
});

test("saving prevents refresh and duplicate writes until the original request settles", async t => {
  const f = fixture(t);
  f.actions.openEdit(workspace("client:a")); f.reads[0]!.resolve(profile("原文")); await settle();
  const saved = f.actions.onProfileSave("保存内容");
  f.actions.refreshProfile();
  const duplicate = f.actions.onProfileSave("重复保存");
  assert.equal(f.reads.length, 1);
  assert.equal(f.writes.length, 1);
  f.writes[0]!.resolve(profile("保存内容")); await saved;
  await duplicate;
  assert.equal(f.actions.profileValue.value?.profileText, "保存内容");
});

test("loading and failed reads cannot dispatch an empty or stale save", async t => {
  const f = fixture(t);
  f.actions.openEdit(workspace("client:a"));
  void f.actions.onProfileSave("不可保存");
  assert.equal(f.writes.length, 0);
  f.reads[0]!.reject(new Error("读取失败")); await settle();
  void f.actions.onProfileSave("不可保存");
  assert.equal(f.writes.length, 0);
  assert.equal(f.actions.profileError.value, "读取失败");
  assert.equal(f.actions.profileLoading.value, false);
});

test("the current save failure returns failure, reports once and keeps the draft source", async t => {
  const f = fixture(t);
  f.actions.openEdit(workspace("client:a")); f.reads[0]!.resolve(profile("原文")); await settle();
  const saved = f.actions.onProfileSave("未保存内容");
  f.writes[0]!.reject(Object.assign(new Error("写入失败"), { requestId: "save-a" }));
  assert.equal(await saved, false);
  assert.equal(f.actions.profileValue.value?.profileText, "原文");
  assert.equal(f.actions.profileSaving.value, false);
  assert.equal(f.successes.length, 0);
  assert.equal(f.errors.length, 1);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0]!.requestId, "save-a");
  assert.doesNotMatch(JSON.stringify(f.logs), /未保存内容/);
});

test("a previous save failure reports its target without clearing the current save", async t => {
  const f = fixture(t), a = workspace("client:a"), b = workspace("client:b");
  f.actions.openEdit(a); f.reads[0]!.resolve(profile("A文本")); await settle();
  const savedA = f.actions.onProfileSave("A保存");
  f.actions.editOpen.value = false; f.actions.openEdit(b);
  f.reads[1]!.resolve(profile("B文本")); await settle();
  const savedB = f.actions.onProfileSave("B保存");
  f.writes[0]!.reject(new Error("A保存失败"));
  assert.equal(await savedA, false);
  assert.equal(f.actions.profileSaving.value, true);
  assert.equal(f.actions.profileError.value, null);
  assert.equal(f.actions.profileValue.value?.profileText, "B文本");
  assert.match(f.errors[0]!, /client:a.*A保存失败/);
  assert.equal(f.logs[0]!.workspaceId, a.id);
  f.writes[1]!.resolve(profile("B保存")); await savedB;
});

test("a current read failure exposes the error and a successful refresh restores saving", async t => {
  const f = fixture(t), a = workspace("client:a");
  f.actions.openEdit(a); f.reads[0]!.reject(new Error("读取失败")); await settle();
  assert.equal(f.actions.profileError.value, "读取失败");
  assert.equal(f.actions.profileLoading.value, false);
  assert.equal(f.logs.length, 1);
  f.actions.refreshProfile();
  assert.equal(f.actions.profileError.value, null);
  f.reads[1]!.resolve(profile("已恢复")); await settle();
  const saved = f.actions.onProfileSave("可保存");
  assert.equal(f.writes.length, 1);
  f.writes[0]!.resolve(profile("可保存"));
  assert.equal(await saved, true);
});

test("logging failure retains the request error and releases only its own saving state", async t => {
  const f = fixture(t), primary = Object.freeze(new Error("保存失败")), loggingError = new Error("日志失败");
  f.actions.openEdit(workspace("client:a")); f.reads[0]!.resolve(profile("原文")); await settle();
  t.mock.method(f.logging, "error", () => { throw loggingError; });
  const saved = f.actions.onProfileSave("未保存");
  f.writes[0]!.reject(primary);
  await assert.rejects(saved, error => {
    assert.equal((error as AggregateError).errors[0], primary);
    assert.equal((error as AggregateError).errors[1], loggingError);
    assert.equal((error as Error).cause, primary);
    return true;
  });
  assert.equal(f.actions.profileSaving.value, false);
  assert.equal(f.actions.profileValue.value?.profileText, "原文");
  assert.equal(f.successes.length, 0);
});
