import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import * as vue from "vue";

const { parse, compileScript } = createRequire(import.meta.url)("vue/compiler-sfc") as typeof import("vue/compiler-sfc");

/** 执行真实 SFC setup，替换宿主生命周期并注入桌面桥。 */
function setupComponent(t: test.TestContext, api: Record<string, unknown>) {
  const script = compileScript(parse(readFileSync(new URL("../src/features/settings/components/desktop-quit-confirm-modal.vue", import.meta.url), "utf8")).descriptor, { id: "quit-ui" }).content;
  const compiled = ts.transpileModule(script, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const unmount: Array<() => void> = [];
  const module = { exports: {} as { default: { setup: (props: object, context: object) => Record<string, any> } } };
  new Function("require", "module", "exports", compiled)((id: string) => {
    if (id === "vue") return { ...vue, onBeforeUnmount: (callback: () => void) => unmount.push(callback) };
    throw new Error(`unexpected component import: ${id}`);
  }, module, module.exports);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: api } });
  t.after(() => {
    unmount.forEach(callback => callback());
    if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window");
  });
  const scope = vue.effectScope();
  const bindings = scope.run(() => module.exports.default.setup({}, { expose() {} }))!;
  t.after(() => scope.stop());
  return bindings;
}

test("有运行中会话时显示应用内退出确认并回传选择", async t => {
  let listener: (() => void) | null = null;
  const responses: boolean[] = [];
  const f = setupComponent(t, {
    onQuitConfirmRequested: (next: () => void) => { listener = next; return () => {}; },
    respondQuitConfirm: async (confirmed: boolean) => { responses.push(confirmed); },
  });
  assert.equal(f.pending.value, false);
  listener!();
  assert.equal(f.pending.value, true);
  await f.respond(false);
  assert.deepEqual(responses, [false]);
  assert.equal(f.pending.value, false);
  listener!();
  await f.respond(true);
  assert.deepEqual(responses, [false, true]);
  assert.equal(f.pending.value, false);
});

test("回传失败保留确认框并记录可检索原因", async t => {
  const captured: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { captured.push(args); };
  t.after(() => { console.error = originalError; });
  let listener: (() => void) | null = null;
  const f = setupComponent(t, {
    onQuitConfirmRequested: (next: () => void) => { listener = next; return () => {}; },
    respondQuitConfirm: async () => { throw new Error("BRIDGE_CLOSED"); },
  });
  listener!();
  await f.respond(true);
  assert.equal(f.pending.value, true);
  const call = captured.at(-1);
  assert.equal(call?.[0], "[desktop_quit_confirm_failed]");
  assert.deepEqual((call?.[1] as { code: string; rootCause: string }), { code: "DESKTOP_QUIT_CONFIRM_FAILED", rootCause: "BRIDGE_CLOSED" });
});

test("旧壳缺少退出确认能力时不注册也不报错", async t => {
  const f = setupComponent(t, {});
  assert.equal(f.pending.value, false);
  await f.respond(true);
  assert.equal(f.pending.value, false);
});
