import assert from "node:assert/strict";
import test from "node:test";

import {
  clearAnalyticsAccountContext,
  installBaiduTracking,
  setAnalyticsAccountContext,
  trackProductEvent,
  trackProductEventWithEmail,
} from "../src/analytics/analytics.ts";

const SITE_ID = "0123456789abcdef0123456789abcdef";

type TestCommand = [command: string, ...args: unknown[]];
type TestScript = {
  id: string;
  src: string;
  async: boolean;
  defer: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  remove: () => void;
  triggerError: () => void;
};

/** 构造百度统计安装所需的最小浏览器环境。 */
function installBrowserFixture(): {
  scripts: TestScript[];
  restore: () => void;
} {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const scripts: TestScript[] = [];
  const fakeDocument = {
    getElementById(id: string) {
      return scripts.find((script) => script.id === id) ?? null;
    },
    createElement(tag: string) {
      assert.equal(tag, "script");
      const listeners = new Map<string, () => void>();
      const script: TestScript = {
        id: "",
        src: "",
        async: false,
        defer: false,
        addEventListener(type, listener) {
          listeners.set(type, listener);
        },
        remove() {
          const index = scripts.indexOf(script);
          if (index >= 0) scripts.splice(index, 1);
        },
        triggerError() {
          listeners.get("error")?.();
        },
      };
      return script;
    },
    addEventListener() {},
    head: {
      appendChild(script: TestScript) {
        scripts.push(script);
      },
    },
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { pathname: "/initial" } },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: fakeDocument,
  });

  return {
    scripts,
    restore() {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
      else delete (globalThis as { window?: unknown }).window;
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else delete (globalThis as { document?: unknown }).document;
    },
  };
}

test("百度统计按配置安装并映射页面、事件及隐私字段", () => {
  const fixture = installBrowserFixture();
  try {
    installBaiduTracking("");
    assert.equal(fixture.scripts.length, 0);
    const originalConsoleError = console.error;
    const analyticsErrors: unknown[] = [];
    console.error = (...args: unknown[]) => analyticsErrors.push(args);
    installBaiduTracking("invalid-site-id");
    console.error = originalConsoleError;
    assert.equal(fixture.scripts.length, 0);
    assert.match(JSON.stringify(analyticsErrors), /BAIDU_SITE_ID_INVALID/u);

    installBaiduTracking(SITE_ID);
    installBaiduTracking(SITE_ID);
    assert.equal(fixture.scripts.length, 1);
    assert.equal(fixture.scripts[0]?.id, "codeflowai-baidu-tracker");
    assert.equal(fixture.scripts[0]?.src, `https://hm.baidu.com/hm.js?${SITE_ID}`);
    assert.equal(fixture.scripts[0]?.async, true);
    assert.equal(fixture.scripts[0]?.defer, true);

    const queue = (globalThis.window as unknown as { _hmt: TestCommand[] })._hmt;
    assert.deepEqual(queue, [["_setAutoPageview", false]]);

    setAnalyticsAccountContext({
      email: "account@example.test",
      accountRole: "personal_normal",
      enterpriseId: "enterprise-secret-id",
      accessContext: { identityType: "PERSONAL", enterpriseId: "enterprise-secret-id" },
    });
    trackProductEvent("page_view", { path: "/pricing?sku=secret#buy" });
    trackProductEvent("workspace_saved", {
      action: "create",
      workspace_type: "local",
      email: "payload@example.test",
      access_token_value: "nested-secret-token",
      token: "secret-token",
      count: 2,
    });
    trackProductEventWithEmail("auth_success", "login@example.test", { mode: "login" });
    clearAnalyticsAccountContext();
    trackProductEvent("count_only", { image_count: 3 });
    trackProductEvent("sensitive_label", { label: "person@example.test" });

    assert.deepEqual(queue[1], ["_trackPageview", "/pricing"]);
    assert.deepEqual(queue[2], [
      "_trackEvent",
      "codeflow",
      "workspace_saved",
      "action=create|workspace_type=local|account_role=personal_normal|identity_type=PERSONAL",
      2,
    ]);
    assert.deepEqual(queue[3], [
      "_trackEvent",
      "codeflow",
      "auth_success",
      "mode=login|account_role=personal_normal|identity_type=PERSONAL",
    ]);
    assert.deepEqual(queue[4], ["_trackEvent", "codeflow", "count_only", "", 3]);
    assert.deepEqual(queue[5], ["_trackEvent", "codeflow", "sensitive_label"]);
    assert.doesNotMatch(JSON.stringify(queue), /example\.test|secret-token|enterprise-secret-id|nested-secret-token/u);

    const originalErrorForLoad = console.error;
    const loadErrors: unknown[] = [];
    console.error = (...args: unknown[]) => loadErrors.push(args);
    fixture.scripts[0]?.triggerError();
    console.error = originalErrorForLoad;
    assert.equal(fixture.scripts.length, 0);
    assert.match(JSON.stringify(loadErrors), /BAIDU_SCRIPT_LOAD_FAILED/u);
    installBaiduTracking(SITE_ID);
    assert.equal(fixture.scripts.length, 1);
  } finally {
    fixture.restore();
  }
});
