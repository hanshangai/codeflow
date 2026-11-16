import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrateClientDb } from "../../apps/desktop/client/src/db/migrateClientDb.ts";
import { EngineKeyRepo } from "../../apps/desktop/client/src/db/repos/engineKeyRepo.ts";
import { openSqliteDb } from "../../apps/desktop/client/src/db/sqliteDb.ts";

for (const source of ['unknown', 'builtin'] as const) {
  test(`schema repair preserves the explicit zero-active provider group for ${source} after reopen`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-inactive-reopen-')), dbPath = path.join(root, 'client.db');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const db = openSqliteDb(dbPath);
    try {
      migrateClientDb(db); const repo = new EngineKeyRepo(db);
      const key = source === 'builtin'
        ? repo.saveBuiltIn({ label: 'builtin', engine: 'claude', providerId: 'anthropic', baseUrl: 'https://relay.example', serverOrigin: 'https://server.example', ownerUserId: 'owner', keyId: 'key', secretRef: 'ref' })
        : repo.insert({ label: 'legacy', engine: 'claude', providerId: 'anthropic', apiKey: 'legacy-secret' });
      if (source === 'unknown') db.prepare("UPDATE engine_keys SET source='unknown' WHERE id=?").run(key.id);
      else repo.activate(key.id);
      repo.insert({ label: 'standby', engine: 'claude', providerId: 'anthropic', apiKey: 'standby-secret' });
      if (source === 'unknown') repo.delete(key.id); else repo.deactivate(key.id);
      assert.equal(repo.getActive('claude', 'anthropic'), null);
    } finally { db.close(); }
    const reopened = openSqliteDb(dbPath);
    try { migrateClientDb(reopened); assert.equal(new EngineKeyRepo(reopened).getActive('claude', 'anthropic'), null); }
    finally { reopened.close(); }
  });
}

test('automatic defaults after custom delete or provider move never select builtin rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeflow-key-default-scope-')), db = openSqliteDb(path.join(root, 'client.db'));
  try {
    migrateClientDb(db); const repo = new EngineKeyRepo(db);
    for (const action of ['delete', 'move'] as const) {
      const custom = repo.insert({ label: action, engine: 'claude', providerId: 'anthropic', apiKey: 'custom-secret' });
      const builtin = repo.saveBuiltIn({ label: 'builtin', engine: 'claude', providerId: 'anthropic', baseUrl: 'https://relay.example/v1', serverOrigin: 'https://server.example', ownerUserId: 'owner-a', keyId: 'server-key', secretRef: 'managed-ref' });
      if (action === 'delete') repo.delete(custom.id);
      else repo.update(custom.id, { providerId: 'deepseek', baseUrl: 'https://api.deepseek.example/anthropic' });
      assert.equal(repo.get(builtin.id)?.isActive, false, action); assert.equal(repo.getActive('claude', 'anthropic'), null, action);
      repo.deleteBuiltIn(builtin.id);
    }
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("EngineKeyRepo allows provider changes while preserving per-provider active defaults", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-engine-key-repo-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);
    const repo = new EngineKeyRepo(db as any);

    const anthropic = repo.insert({
      label: "Claude",
      engine: "claude",
      providerId: "anthropic",
      apiKey: "sk-ant",
      baseUrl: null,
    });
    const deepseek = repo.insert({
      label: "DeepSeek",
      engine: "claude",
      providerId: "deepseek",
      apiKey: "sk-ds",
      baseUrl: "https://api.deepseek.com/anthropic",
    });

    assert.equal(repo.getActive("claude", "anthropic")?.id, anthropic.id);
    assert.equal(repo.getActive("claude", "deepseek")?.id, deepseek.id);

    repo.update(anthropic.id, {
      label: "Claude moved",
      providerId: "deepseek",
      apiKey: "sk-ant-as-ds",
      baseUrl: "https://api.deepseek.com/anthropic",
    });

    const moved = repo.get(anthropic.id);
    assert.equal(moved?.providerId, "deepseek");
    assert.equal(moved?.isActive, true);
    assert.equal(repo.getActive("claude", "deepseek")?.id, anthropic.id);
    assert.equal(repo.getActive("claude", "anthropic"), null);
    assert.equal(repo.get(deepseek.id)?.isActive, false);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("EngineKeyRepo allows deactivating the only key for a provider", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-engine-key-repo-"));
  const dbPath = path.join(tempDir, "client.db");
  const db = openSqliteDb(dbPath);

  try {
    migrateClientDb(db as any);
    const repo = new EngineKeyRepo(db as any);

    const deepseek = repo.insert({
      label: "DeepSeek",
      engine: "claude",
      providerId: "deepseek",
      apiKey: "sk-ds",
      baseUrl: "https://api.deepseek.com/anthropic",
    });

    assert.equal(repo.getActive("claude", "deepseek")?.id, deepseek.id);
    assert.equal(repo.hasActiveKeysForEngine("claude"), true);

    const deactivated = repo.deactivate(deepseek.id);

    assert.equal(deactivated.isActive, false);
    assert.equal(repo.getActive("claude", "deepseek"), null);
    assert.equal(repo.get(deepseek.id)?.isActive, false);
    assert.equal(repo.hasKeysForEngine("claude"), true);
    assert.equal(repo.hasActiveKeysForEngine("claude"), false);
  } finally {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
