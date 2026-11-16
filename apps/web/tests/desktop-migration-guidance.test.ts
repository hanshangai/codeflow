import assert from "node:assert/strict";
import test from "node:test";
import { getDesktopMigrationRedirect, markDesktopMigrationShown, shouldShowDesktopMigration } from "../src/features/desktop/desktopMigrationGuidance.ts";

/** 提供真实 Storage 合同的内存实现，不共享账号或浏览器测试状态。 */
function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const base = { serverOrigin: "wss://example.test", userId: "a", desktop: false, mobile: false,
  userAgent: "Desktop browser", to: "/chat?threadId=t#last", from: "/auth/login", now: new Date(2026, 10, 7, 9) };

test("研发入口按 Server、账号、浏览器本地日期隔离，每天最多一次", () => {
  const state = storage();
  assert.equal(shouldShowDesktopMigration(base, state), true);
  markDesktopMigrationShown(base, state);
  assert.equal(shouldShowDesktopMigration(base, state), false);
  assert.equal(shouldShowDesktopMigration({ ...base, userId: "b" }, state), true);
  assert.equal(shouldShowDesktopMigration({ ...base, serverOrigin: "wss://other.test" }, state), true);
  assert.equal(shouldShowDesktopMigration({ ...base, now: new Date(2026, 10, 8, 9) }, state), true);
  assert.equal(shouldShowDesktopMigration({ ...base, from: "/chat", to: "/orchestration/workspace" }, state), false);
});

test("桌面、移动、办公浏览器、后台、支付、未登录及研发内部导航均不强制引导", () => {
  for (const input of [{ desktop: true }, { mobile: true }, { userAgent: "Mozilla Android" }, { userAgent: "wxwork" },
    { to: "/admin" }, { to: "/payment/verification" }, { userId: "" }, { from: "/knowledge", to: "/chat" }]) {
    assert.equal(shouldShowDesktopMigration({ ...base, ...input }, storage()), false);
  }
});

test("安全回跳保留完整查询与锚点，外部和不相关地址回到工作台", () => {
  assert.equal(getDesktopMigrationRedirect("/chat?tag=a&tag=b#last"), "/chat?tag=a&tag=b#last");
  for (const target of ["https://evil.test/chat", "//evil.test/chat", "/desktop-migration", "/admin", "/chat/../admin", "/chat\\evil", "%2Fchat"]) {
    assert.equal(getDesktopMigrationRedirect(target), "/chat");
  }
});

test("存储失败明确抛错，不伪造已展示记录", () => {
  assert.throws(() => shouldShowDesktopMigration(base, { getItem() { throw new Error("read failed"); } }), /read failed/u);
  assert.throws(() => markDesktopMigrationShown(base, { getItem() { return null; }, setItem() { throw new Error("write failed"); } }), /write failed/u);
});
