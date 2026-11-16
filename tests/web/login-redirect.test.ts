import assert from "node:assert/strict";
import test from "node:test";

import { buildLoginRouteLocation, resolvePostLoginTarget } from "../../apps/web/src/features/account/loginRedirect.ts";

test("login redirect preserves thread deep links for protected chat routes", () => {
  assert.deepEqual(
    buildLoginRouteLocation("/chat?threadId=thread_123"),
    {
      path: "/auth/login/",
      query: {
        redirect: "/chat?threadId=thread_123",
      },
    },
  );
});

test("login redirect does not preserve non-protected landing routes", () => {
  assert.deepEqual(
    buildLoginRouteLocation("/about"),
    {
      path: "/auth/login/",
    },
  );
});

test("H5 redirects stay on the standard login surface unless explicitly selected", () => {
  assert.deepEqual(
    buildLoginRouteLocation("/h5?workspaceId=ws-a"),
    {
      path: "/auth/login/",
      query: { redirect: "/h5?workspaceId=ws-a" },
    },
  );
});

test("retired H5 login surface uses CodeFlow login", () => {
  assert.deepEqual(
    buildLoginRouteLocation("/h5?workspaceId=ws-a", undefined, "h5"),
    {
      path: "/auth/login/",
      query: { redirect: "/h5?workspaceId=ws-a" },
    },
  );
});

test("knowledge deep links survive the login round trip", () => {
  const target = "/knowledge?tab=candidates&candidateId=candidate-123";
  assert.deepEqual(
    buildLoginRouteLocation(target),
    {
      path: "/auth/login/",
      query: { redirect: target },
    },
  );
  assert.deepEqual(
    resolvePostLoginTarget("/chat", { redirect: target }),
    {
      path: "/knowledge",
      query: {
        tab: "candidates",
        candidateId: "candidate-123",
      },
    },
  );
});

test("post-login target restores threadId", () => {
  assert.deepEqual(
    resolvePostLoginTarget("/chat", {
      redirect: "/chat?threadId=thread_123",
    }),
    {
      path: "/chat",
      query: {
        threadId: "thread_123",
      },
    },
  );
});

test("register success preserves the email without protected redirect", () => {
  assert.deepEqual(
    buildLoginRouteLocation("/auth/register", {
      email: "new-user@example.test",
    }),
    {
      path: "/auth/login/",
      query: {
        email: "new-user@example.test",
      },
    },
  );
});

test("post-login target restores top-level threadId from unencoded chat redirect", () => {
  assert.deepEqual(
    resolvePostLoginTarget("/chat", {
      redirect: "/chat",
      threadId: "thread_123",
    }),
    {
      path: "/chat",
      query: {
        threadId: "thread_123",
      },
    },
  );
});

test("post-login target falls back to default path for non-protected redirects", () => {
  assert.deepEqual(
    resolvePostLoginTarget("/chat", {
      redirect: "/guide",
    }),
    {
      path: "/chat",
    },
  );
});

test("login redirect preserves enterprise purchase query", () => {
  assert.deepEqual(
    buildLoginRouteLocation("/payment/enterprise?skuCode=ENTERPRISE_STANDARD_MONTH&source=PRICING"),
    {
      path: "/auth/login/",
      query: {
        redirect: "/payment/enterprise?skuCode=ENTERPRISE_STANDARD_MONTH&source=PRICING",
      },
    },
  );
});

test("post-login target restores enterprise purchase query", () => {
  assert.deepEqual(
    resolvePostLoginTarget("/chat", {
      redirect: "/payment/enterprise?skuCode=ENTERPRISE_STANDARD_MONTH&source=PRICING",
    }),
    {
      path: "/payment/enterprise",
      query: {
        skuCode: "ENTERPRISE_STANDARD_MONTH",
        source: "PRICING",
      },
    },
  );
});
