import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

test("chat entry navigates while another page transition holds the general navigation lock", () => {
  const source = fs.readFileSync(new URL("../src/layouts/mobile/mobile-layout.vue", import.meta.url), "utf8");
  const start = source.indexOf("function pushChatPage(");
  const end = source.indexOf("function clearThreadIdQuery(", start);
  assert.ok(start >= 0 && end > start);
  const calls: unknown[] = [];
  const context = {
    navigating: true,
    pageTransition: { value: "slide-right" },
    clearThreadIdQuery: () => calls.push("clear"),
    buildThreadUrl: (id: string) => `/chat?threadId=${id}`,
    ui: { pushMobilePage: (entry: unknown, options: unknown) => calls.push({ entry, options }) },
    chat: { syncPrimaryThreadUrl: (id: string, options: unknown) => calls.push({ id, options }) },
    setTimeout: () => calls.push("timer"),
  };
  const script = ts.transpileModule(source.slice(start, end) + '\npushChatPage("thread-test");', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(script, context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    "clear",
    { entry: { type: "chat" }, options: { url: "/chat?threadId=thread-test" } },
    { id: "thread-test", options: { mode: "replace" } },
  ]);
  assert.equal(context.pageTransition.value, "slide-left");
  assert.equal(context.navigating, true);
});
