import assert from "node:assert/strict";
import test from "node:test";
import type { DesktopUpdateProgress } from "@codeflowai/shared";
import * as desktop from "../src/services/desktop.ts";

/** 只替换 preload 进度通道，验证 Web 侧载荷校验与退订。 */
function fixture(t: test.TestContext, onUpdateProgress?: (listener: (progress: DesktopUpdateProgress) => void) => () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { codeflowDesktop: {
    getState: async () => ({}), request: async () => { throw new Error("unexpected request"); }, ...(onUpdateProgress ? { onUpdateProgress } : {}),
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else Reflect.deleteProperty(globalThis, "window"); });
}

test("下载进度只透传安全整数且不超过总量，null 表示离开下载阶段", t => {
  let emit!: (progress: DesktopUpdateProgress) => void;
  let unsubscribed = 0;
  fixture(t, listener => { emit = listener; return () => { unsubscribed++; }; });
  const received: DesktopUpdateProgress[] = [];
  const unsubscribe = desktop.subscribeDesktopUpdateProgress(progress => { received.push(progress); });
  emit({ received: 3, total: 10 });
  emit(null);
  emit({ received: 11, total: 10 });
  emit({ received: 1.5, total: 10 });
  emit({ received: 0, total: 0 });
  assert.deepEqual(received, [{ received: 3, total: 10 }, null]);
  unsubscribe();
  assert.equal(unsubscribed, 1);
});

test("旧壳缺少进度通道时不启用订阅", t => {
  fixture(t);
  const received: DesktopUpdateProgress[] = [];
  const unsubscribe = desktop.subscribeDesktopUpdateProgress(progress => { received.push(progress); });
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
  assert.deepEqual(received, []);
});
