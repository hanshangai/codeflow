import assert from "node:assert/strict";
import { KnowledgeAssetStore } from "../../src/knowledge/knowledgeAssetStore.js";
import { KnowledgeGenerationService } from "../../src/knowledge/knowledgeGenerationService.js";
import path from "node:path";
import { openClientDb } from "../../src/db/clientDb.js";

const [root, runId] = process.argv.slice(2) as [string, string];
const store = new KnowledgeAssetStore(root);
const db = openClientDb({ dbPath: path.join(root, "worker.db") });
db.workspaces.upsert({ id: "worker" as any, title: "子进程", path: root });
let unblock!: () => void;
const gate = new Promise<void>(resolve => { unblock = resolve; });
const service = new KnowledgeGenerationService(store, "worker", async input => {
  if (input.title === "b") { process.send!({ event: "blocked" }); await gate; }
  const result = await input.execute({ toolId: "knowledge.asset.submit", toolInput: {
    content: `# ${input.title}`, summary: "test", sources: [{ kind: "requirement", requirement: "test", relation: "test" }],
  }, accessMode: "read-only" });
  assert.equal(result.ok, true, JSON.stringify(result));
}, "worker-request", () => ({ nodeId: null, activationVersion: 1 }), db);
let snapshot = store.readRun(runId);

/** IPC 让父进程控制真实 worker 的结束与旧快照写回，不依赖模型或固定长等待。 */
process.on("message", async (message: { id: number; command: string }) => {
  try {
    if (message.command === "finish") {
      unblock();
      const deadline = Date.now() + 8000;
      while (service.view(runId).active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(service.view(runId).active, false);
      snapshot = store.readRun(runId);
      db.close();
    } else if (message.command === "save-stale") store.saveRun(snapshot);
    else throw new Error(`Unknown command: ${message.command}`);
    if (process.connected) process.send!({ id: message.id, ok: true });
  } catch (error) {
    process.send!({ id: message.id, ok: false, error: error instanceof Error ? error.stack : String(error) });
  }
});
service.startAsync(runId);
process.send!({ event: "reserved" });
