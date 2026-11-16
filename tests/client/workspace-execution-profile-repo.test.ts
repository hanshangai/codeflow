import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateWorkspaceExecutionProfileText } from "../../packages/shared/src/utils/workspaceExecutionProfile.ts";
import { migrateClientDb } from "../../apps/desktop/client/src/db/migrateClientDb.ts";
import { openSqliteDb } from "../../apps/desktop/client/src/db/sqliteDb.ts";
import { WorkspaceExecutionProfileRepo } from "../../apps/desktop/client/src/db/repos/workspaceExecutionProfileRepo.ts";

test("validateWorkspaceExecutionProfileText rejects obvious secrets", () => {
  const tokenResult = validateWorkspaceExecutionProfileText("access_token=abc123");
  assert.equal(tokenResult.ok, false);
  if (!tokenResult.ok) assert.equal(tokenResult.code, "PROFILE_SENSITIVE_CONTENT");

  const keyResult = validateWorkspaceExecutionProfileText("-----BEGIN OPENSSH PRIVATE KEY-----");
  assert.equal(keyResult.ok, false);
  if (!keyResult.ok) assert.equal(keyResult.code, "PROFILE_SENSITIVE_CONTENT");
});

test("WorkspaceExecutionProfileRepo isolates profile by scope and user", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-workspace-profile-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);
    const repo = new WorkspaceExecutionProfileRepo(db as any);
    const localScope = { scopeType: "local_workspace" as const, scopeId: "client-a:ws-demo" };
    const sharedScope = { scopeType: "shared_workspace" as const, scopeId: "shared-demo" };

    const localProfile = repo.upsert({
      scope: localScope,
      userId: "user-a",
      profileText: "  Git author: A <a@example.test>  ",
    });
    repo.upsert({
      scope: sharedScope,
      userId: "user-a",
      profileText: "Shared workspace preference",
    });

    assert.equal(localProfile.profileText, "Git author: A <a@example.test>");
    assert.equal(localProfile.source, "workspace");
    assert.ok(localProfile.profileHash);
    assert.equal(repo.get(localScope, "user-a")?.profileText, "Git author: A <a@example.test>");
    assert.equal(repo.get(sharedScope, "user-a")?.profileText, "Shared workspace preference");
    assert.equal(repo.get(localScope, "user-b"), null);

    repo.upsert({ scope: localScope, userId: "user-a", profileText: "   " });
    const cleared = repo.get(localScope, "user-a");
    assert.equal(cleared?.source, "missing");
    assert.equal(cleared?.profileText, "");
    assert.equal(cleared?.profileHash, null);

    const statuses = repo.listStatuses(sharedScope, ["user-a", "user-b"]);
    assert.deepEqual(statuses.map((item) => ({
      userId: item.userId,
      hasProfile: item.hasProfile,
      source: item.source,
      profileHash: item.profileHash ? "present" : null,
    })), [
      { userId: "user-a", hasProfile: true, source: "workspace", profileHash: "present" },
      { userId: "user-b", hasProfile: false, source: "missing", profileHash: null },
    ]);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
