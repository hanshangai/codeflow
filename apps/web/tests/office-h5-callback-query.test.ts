import test from "node:test";
import assert from "node:assert/strict";

import { hasOfficeH5CallbackQuery, stripOfficeH5CallbackQuery } from "../src/features/office-h5/officeH5CallbackQuery.ts";

test("office h5 callback query strips one-time auth parameters and keeps business query", () => {
  const query = {
    corpId: "wwa9d1e168840c53aa",
    redirect: "/chat?threadId=thread-1",
    workspaceId: "workspace-a",
    code: "auth-code",
    authCode: "auth-code-alt",
    auth_code: "auth-code-legacy",
    state: "office-state",
  };

  assert.equal(hasOfficeH5CallbackQuery(query), true);
  assert.deepEqual(stripOfficeH5CallbackQuery(query), {
    corpId: "wwa9d1e168840c53aa",
    redirect: "/chat?threadId=thread-1",
    workspaceId: "workspace-a",
  });
});

test("office h5 callback query helper is a no-op for clean routes", () => {
  const query = {
    corpId: "wwa9d1e168840c53aa",
    redirect: "/chat",
    threadId: "thread-1",
  };

  assert.equal(hasOfficeH5CallbackQuery(query), false);
  assert.deepEqual(stripOfficeH5CallbackQuery(query), query);
});
