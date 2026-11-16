import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { createCancelledRequestError, isCancelledRequestError } from "../src/api/request.ts";
import { watch } from "vue";

const shellSource = fs.readFileSync(new URL("../src/composables/useAppShell.ts", import.meta.url), "utf8");
const monitorSource = fs.readFileSync(
  new URL("../src/features/orchestration/components/orchestration-monitor.vue", import.meta.url),
  "utf8",
);
const intakePanelSource = fs.readFileSync(
  new URL("../src/features/orchestration/components/task-intake-panel.vue", import.meta.url),
  "utf8",
);

test("logout closes reconnect gates before disconnecting the websocket", () => {
  assert.match(
    shellSource,
    /logoutInProgress\.value = true;[\s\S]*?cancelWorkspaceActivationTask\("disconnect"\);[\s\S]*?cancelRuntimeReads\("disconnect"\);[\s\S]*?ws\.disconnect\(\);/u,
  );
  assert.match(shellSource, /async function connect\(\) \{[\s\S]*?if \(logoutInProgress\.value\) return;/u);
  assert.match(
    shellSource,
    /\[config\.canConnectServer, config\.connected, isPaymentVerificationRoute\.value, logoutInProgress\.value\]/u,
  );
  assert.match(shellSource, /\(nextToken, previousToken\) => \{\s*if \(logoutInProgress\.value\) return;/u);
  assert.match(shellSource, /await account\.logout\(\);[\s\S]*?catch \(error\) \{[\s\S]*?message\.error\(error instanceof Error \? error\.message : String\(error\)\);[\s\S]*?throw error;/u);
});

test("instance navigation reuses cached snapshots instead of refetching full instances", () => {
  assert.match(
    monitorSource,
    /orch\.loadInstance\(ctx\.value, props\.workspaceId, instanceId, \{ force: false \}\)/u,
  );
  assert.match(
    monitorSource,
    /requestMonitorInstanceHydration\(id, \{ refreshRuntimePatch: true \}\)/u,
  );
  assert.match(
    intakePanelSource,
    /async function changeMonitorInstance[\s\S]*?orch\.loadInstance\(ctx\.value, props\.workspaceId, nextId, \{ force: false \}\)/u,
  );
});

/** 执行实际 Shell 注销函数，传输失败外的门禁、清理和导航保持可观察。 */
function shellLogout(options: { failure?: Error; desktop?: boolean; takeoverAt?: "account" | "runtime" | "workspaces" }) {
  const start = shellSource.indexOf("  async function logout()");
  const end = shellSource.indexOf("  function hasAccountSession", start);
  assert.ok(start >= 0 && end > start);
  const events: string[] = [];
  const gate = { value: false };
  const config = {
    serverWsOrigin: "wss://cloud.example", sessionToken: null as string | null, isDesktop: options.desktop ?? false,
    setLogoutInProgress: (value: boolean) => events.push(`gate:${value}`),
    refreshDesktopRuntime: async () => { if (options.takeoverAt === "runtime") config.sessionToken = "session-B"; },
  };
  const code = ts.transpile(shellSource.slice(start, end), { target: ts.ScriptTarget.ES2022 });
  const logout = new Function("logoutInProgress", "config", "cancelWorkspaceActivationTask", "cancelRuntimeReads", "ws",
    "account", "resetAllStores", "message", "isCancelledRequestError", "createCancelledRequestError", "workspaces", "ctx", "router", "pushLoginRoute", "watch", code + "\nreturn logout;")(
    gate, config, () => events.push("cancel-workspace"), () => events.push("cancel-reads"), { disconnect: () => events.push("disconnect") },
    { logout: async () => {
      if (options.failure) throw options.failure;
      if (options.takeoverAt === "account") queueMicrotask(() => { config.sessionToken = "session-B"; });
    } }, () => events.push("reset"),
    { error: (text: string) => events.push(`error:${text}`) }, isCancelledRequestError, createCancelledRequestError,
    { refresh: async () => { events.push("workspaces"); if (options.takeoverAt === "workspaces") config.sessionToken = "session-B"; } },
    { value: {} }, { currentRoute: { value: { name: "chat" } }, push: async () => { events.push("chat-navigation"); } },
    async () => { events.push("login-navigation"); }, watch,
  ) as () => Promise<void>;
  return { logout, events, gate, config };
}

test("Shell keeps owner-change cancellation explicit without a stale logout error or success cleanup", async () => {
  const failure = createCancelledRequestError("scope-change");
  const fixture = shellLogout({ failure });
  await assert.rejects(fixture.logout(), (error) => error === failure);
  assert.deepEqual(fixture.events, ["gate:true", "cancel-workspace", "cancel-reads", "disconnect", "gate:false"]);
  assert.equal(fixture.gate.value, false);
});

test("Shell shows a current logout failure and releases its reconnect gate", async () => {
  const failure = new Error("Server logout failed");
  const fixture = shellLogout({ failure });
  await assert.rejects(fixture.logout(), (error) => error === failure);
  assert.deepEqual(fixture.events, ["gate:true", "cancel-workspace", "cancel-reads", "disconnect", "error:Server logout failed", "gate:false"]);
  assert.equal(fixture.gate.value, false);
});

test("Shell shows a disconnect cancellation while keeping logout rejected", async () => {
  const failure = createCancelledRequestError("disconnect");
  const fixture = shellLogout({ failure });
  await assert.rejects(fixture.logout(), (error) => error === failure);
  assert.deepEqual(fixture.events, ["gate:true", "cancel-workspace", "cancel-reads", "disconnect", `error:${failure.message}`, "gate:false"]);
});

for (const desktop of [false, true]) {
  test(`${desktop ? "desktop" : "browser"} Shell completes navigation when logout keeps the account empty`, async () => {
    const fixture = shellLogout({ desktop });
    await fixture.logout();
    assert.deepEqual(fixture.events, ["gate:true", "cancel-workspace", "cancel-reads", "disconnect", "reset",
      ...(desktop ? ["workspaces", "chat-navigation"] : ["login-navigation"]), "gate:false"]);
  });

  test(`${desktop ? "desktop" : "browser"} Shell cannot clear or navigate B when ownership changes after account logout resolves`, async () => {
    const fixture = shellLogout({ desktop, takeoverAt: "account" });
    await assert.rejects(fixture.logout(), isCancelledRequestError);
    assert.equal(fixture.config.sessionToken, "session-B");
    assert.deepEqual(fixture.events, ["gate:true", "cancel-workspace", "cancel-reads", "disconnect", "gate:false"]);
  });
}

for (const takeoverAt of ["runtime", "workspaces"] as const) {
  test(`desktop Shell stops remaining logout work after ownership changes during ${takeoverAt} refresh`, async () => {
    const fixture = shellLogout({ desktop: true, takeoverAt });
    await assert.rejects(fixture.logout(), isCancelledRequestError);
    assert.equal(fixture.config.sessionToken, "session-B");
    assert.equal(fixture.events.includes("chat-navigation"), false);
    assert.equal(fixture.events.includes("login-navigation"), false);
    assert.equal(fixture.events.includes("workspaces"), takeoverAt === "workspaces");
    assert.equal(fixture.events.at(-1), "gate:false");
  });
}
