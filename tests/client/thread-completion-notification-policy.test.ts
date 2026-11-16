import test from "node:test";
import assert from "node:assert/strict";

import { shouldSendThreadCompletionNotification } from "../../apps/desktop/client/src/notifications/threadCompletionNotificationPolicy.ts";

test("thread completion notification policy skips orchestration scoped threads", () => {
  assert.equal(shouldSendThreadCompletionNotification({ threadType: "chat", threadSubtype: null }), true);
  assert.equal(shouldSendThreadCompletionNotification({ threadType: "orchestration", threadSubtype: "node" }), false);
  assert.equal(shouldSendThreadCompletionNotification({ threadType: "chat", threadSubtype: "node-discussion" }), false);
  assert.equal(shouldSendThreadCompletionNotification({ threadType: "chat", threadSubtype: "requirement-analysis" }), false);
});
