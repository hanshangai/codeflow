import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { makeWorkspaceIdFromPathDigest, normalizeWorkspacePathForDerivedId } from "@codeflowai/shared";

import { clearDesktopConfigApiKey, normalizeClientApiKeyInput, readClientConfig, readDesktopConfigForMaintenance, saveConfigFile } from "../src/config.ts";
import { openClientDb } from "../src/db/clientDb.ts";
import { ensureStableClientId } from "../src/startup/clientStartupGuards.ts";

test('desktop uninstall config cleanup ignores inherited environment and retains every nonsecret field', t => {
  const home = createTempHome(t), file = path.join(home, 'config.json');
  withClientEnv(t, { CODEFLOWAI_API_KEY: 'inherited-secret', CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(home, 'wrong-config.json') });
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'old-secret', clientId: 'stable', serverWs: 'wss://server/ws/client', custom: ['保留'] }), 'utf8');
  clearDesktopConfigApiKey({ configPath: file, clientId: 'stable' });
  assert.deepEqual(readDesktopConfigForMaintenance(file, 'stable'), { apiKey: '', clientId: 'stable', serverWs: 'wss://server/ws/client', custom: ['保留'] });
  assert.equal(fs.existsSync(path.join(home, 'wrong-config.json')), false);
});

test('desktop uninstall config cleanup rejects absent, malformed and mismatched config without replacing it', t => {
  const home = createTempHome(t), file = path.join(home, 'config.json');
  assert.throws(() => clearDesktopConfigApiKey({ configPath: file, clientId: 'stable' }), { code: 'ENOENT' });
  assert.equal(fs.existsSync(file), false);
  for (const content of ['{broken', '[]', '{"clientId":"other","apiKey":"keep"}', '{"clientId":"stable","apiKey":42}']) {
    fs.writeFileSync(file, content, 'utf8');
    assert.throws(() => clearDesktopConfigApiKey({ configPath: file, clientId: 'stable' }));
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});

for (const phase of ['write', 'fsync', 'write-and-close', 'rename-and-unlink'] as const) {
  test(`desktop uninstall config ${phase} failure preserves original file and error causes`, t => {
    const home = createTempHome(t), file = path.join(home, 'config.json');
    const content = '{"clientId":"stable","apiKey":"keep","custom":"保留"}';
    fs.writeFileSync(file, content, 'utf8');
    const primary = new Error(`injected ${phase}`), secondary = new Error('injected cleanup');
    if (phase === 'fsync') t.mock.method(fs, 'fsyncSync', () => { throw primary; });
    if (phase.startsWith('write')) t.mock.method(fs, 'writeFileSync', () => { throw primary; });
    if (phase === 'write-and-close') {
      const close = fs.closeSync;
      t.mock.method(fs, 'closeSync', (fd: number) => { close(fd); throw secondary; });
    }
    if (phase === 'rename-and-unlink') {
      t.mock.method(fs, 'renameSync', () => { throw primary; });
      t.mock.method(fs, 'unlinkSync', () => { throw secondary; });
    }
    assert.throws(() => clearDesktopConfigApiKey({ configPath: file, clientId: 'stable' }), error => {
      if (phase.includes('-and-')) { assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [primary, secondary]); }
      else assert.equal(error, primary);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    if (phase !== 'rename-and-unlink') assert.deepEqual(fs.readdirSync(home), ['config.json']);
  });
}

test("readClientConfig prefers persisted clientId from config.json", (t) => {
  const tempHome = createTempHome(t);
  withClientEnv(t, {});
  t.mock.method(os, "homedir", () => tempHome);

  writeConfig(tempHome, {
    apiKey: "api-key",
    serverWs: "ws://server/ws/client",
    clientId: "stable-client",
  });

  const config = readClientConfig();
  assert.equal(config.clientId, "stable-client");
  assert.equal(config.clientIdSource, "config");
  assert.equal(config.serverWsUrl, "ws://server/ws/client");
});

test("readClientConfig migrates missing clientId from plain local DB meta", (t) => {
  const tempHome = createTempHome(t);
  withClientEnv(t, {});
  t.mock.method(os, "homedir", () => tempHome);

  writeConfig(tempHome, {
    apiKey: "api-key",
    serverWs: "ws://server/ws/client",
  });
  const db = openClientDb({ dbPath: path.join(tempHome, ".codeflowai", "codeflowai.db") });
  try {
    ensureStableClientId(db, "old-host-client");
  } finally {
    db.close();
  }

  const config = readClientConfig();
  assert.equal(config.clientId, "old-host-client");
  assert.equal(config.clientIdSource, "db-meta");
});

test("saveConfigFile persists clientId and preserves unrelated fields", (t) => {
  const tempHome = createTempHome(t);
  withClientEnv(t, {});
  t.mock.method(os, "homedir", () => tempHome);

  writeConfig(tempHome, {
    apiKey: "old-api-key",
    serverWs: "ws://old/ws/client",
    customFlag: "keep-me",
  });

  saveConfigFile({
    apiKey: "new-api-key",
    serverWs: "ws://new/ws/client",
    clientId: "stable-client",
  });

  const saved = JSON.parse(fs.readFileSync(configPath(tempHome), "utf8")) as Record<string, unknown>;
  assert.equal(saved.apiKey, "new-api-key");
  assert.equal(saved.serverWs, "ws://new/ws/client");
  assert.equal(saved.clientId, "stable-client");
  assert.equal(saved.customFlag, "keep-me");
});

test("client config reads and writes an explicit isolated path", (t) => {
  const tempHome = createTempHome(t);
  const isolatedPath = path.join(tempHome, "local-client", "config.json");
  withClientEnv(t, { CODEFLOWAI_CLIENT_CONFIG_PATH: isolatedPath });
  t.mock.method(os, "homedir", () => tempHome);

  writeConfig(tempHome, {
    apiKey: "installed-api-key",
    serverWs: "ws://installed/ws/client",
    clientId: "installed-client",
  });
  fs.mkdirSync(path.dirname(isolatedPath), { recursive: true });
  fs.writeFileSync(isolatedPath, JSON.stringify({
    apiKey: "local-api-key",
    serverWs: "ws://local/ws/client",
    clientId: "local-client",
  }), "utf8");

  const config = readClientConfig();
  assert.equal(config.clientId, "local-client");
  assert.equal(config.serverWsUrl, "ws://local/ws/client");

  saveConfigFile({
    apiKey: "updated-local-api-key",
    serverWs: "ws://updated-local/ws/client",
    clientId: "updated-local-client",
  });

  const isolated = JSON.parse(fs.readFileSync(isolatedPath, "utf8")) as Record<string, unknown>;
  const installed = JSON.parse(fs.readFileSync(configPath(tempHome), "utf8")) as Record<string, unknown>;
  assert.equal(isolated.clientId, "updated-local-client");
  assert.equal(installed.clientId, "installed-client");
});

test("normalizeClientApiKeyInput extracts a key from pasted startup commands", () => {
  const key = "codeflowai_1234567890ABCDEFGHIJKLMNOPQRSTUV";

  assert.equal(normalizeClientApiKeyInput(`$env:CODEFLOWAI_API_KEY="${key}"; codeflow`), key);
  assert.equal(normalizeClientApiKeyInput(`export CODEFLOWAI_API_KEY=${key} && codeflow`), key);
  assert.equal(normalizeClientApiKeyInput(`"${key}"`), key);
});

test("normalizeClientApiKeyInput rejects ambiguous or malformed key input", () => {
  const keyA = "codeflowai_1234567890ABCDEFGHIJKLMNOPQRSTUV";
  const keyB = "codeflowai_ABCDEFGHIJKLMNOPQRSTUV1234567890";

  assert.throws(() => normalizeClientApiKeyInput(`${keyA} ${keyB}`), /多个 Client Key/u);
  assert.throws(() => normalizeClientApiKeyInput(`${keyA} extra`), /不要混入其他文本/u);
  assert.throws(() => normalizeClientApiKeyInput("codeflowai_short"), /Client Key 应为/u);
  assert.throws(() => normalizeClientApiKeyInput("codeflow"), /不要粘贴完整启动命令/u);
});

test("saveConfigFile persists normalized apiKey", (t) => {
  const tempHome = createTempHome(t);
  const key = "codeflowai_1234567890ABCDEFGHIJKLMNOPQRSTUV";
  withClientEnv(t, {});
  t.mock.method(os, "homedir", () => tempHome);

  saveConfigFile({
    apiKey: ` $env:CODEFLOWAI_API_KEY="${key}"; codeflow `,
    serverWs: "ws://new/ws/client",
    clientId: "stable-client",
  });

  const saved = JSON.parse(fs.readFileSync(configPath(tempHome), "utf8")) as Record<string, unknown>;
  assert.equal(saved.apiKey, key);
});

test("readClientConfig lets env apiKey override malformed persisted apiKey", (t) => {
  const tempHome = createTempHome(t);
  const key = "codeflowai_1234567890ABCDEFGHIJKLMNOPQRSTUV";
  withClientEnv(t, { CODEFLOWAI_API_KEY: key });
  t.mock.method(os, "homedir", () => tempHome);

  writeConfig(tempHome, {
    apiKey: "codeflowai_short",
    serverWs: "ws://server/ws/client",
    clientId: "stable-client",
  });

  const config = readClientConfig();
  assert.equal(config.apiKey, key);
  assert.equal(config.apiKeySource, "env");
});

test("readClientConfig prefers explicit CLI key over env and config", (t) => {
  const tempHome = createTempHome(t);
  const cliKey = "codeflowaiclioverridetestvalue1234";
  withClientEnv(t, { CODEFLOWAI_API_KEY: "env-api-key" });
  t.mock.method(os, "homedir", () => tempHome);
  writeConfig(tempHome, {
    apiKey: "config-api-key",
    serverWs: "ws://server/ws/client",
    clientId: "stable-client",
  });

  const config = readClientConfig({ apiKeyOverride: cliKey });
  assert.equal(config.apiKey, cliKey);
  assert.equal(config.apiKeySource, "cli");
});

test("readClientConfig rejects an explicit empty CLI key without env fallback", (t) => {
  const tempHome = createTempHome(t);
  const configPayload = {
    apiKey: "persisted-api-key",
    serverWs: "ws://server/ws/client",
    clientId: "stable-client",
  };
  withClientEnv(t, { CODEFLOWAI_API_KEY: "env-api-key" });
  t.mock.method(os, "homedir", () => tempHome);
  writeConfig(tempHome, configPayload);
  const before = fs.readFileSync(configPath(tempHome), "utf8");

  assert.throws(() => readClientConfig({ apiKeyOverride: "" }), /--key 不能为空/u);
  assert.equal(fs.readFileSync(configPath(tempHome), "utf8"), before);
});

test("readClientConfig does not create ws-demo when workspace config is absent", (t) => {
  const tempHome = createTempHome(t);
  withClientEnv(t, {});
  t.mock.method(os, "homedir", () => tempHome);

  writeConfig(tempHome, {
    apiKey: "api-key",
    serverWs: "ws://server/ws/client",
    clientId: "stable-client",
  });

  const config = readClientConfig();
  assert.deepEqual(config.workspaces, []);
});

test("readClientConfig derives workspace id from CODEFLOWAI_WORKSPACE_PATH when id is omitted", (t) => {
  const tempHome = createTempHome(t);
  const workspacePath = path.join(tempHome, "workspace");
  withClientEnv(t, { CODEFLOWAI_WORKSPACE_PATH: workspacePath });
  t.mock.method(os, "homedir", () => tempHome);

  writeConfig(tempHome, {
    apiKey: "api-key",
    serverWs: "ws://server/ws/client",
    clientId: "stable-client",
  });

  const digest = crypto.createHash("sha256").update(normalizeWorkspacePathForDerivedId(workspacePath)).digest("hex");
  const config = readClientConfig();
  assert.equal(config.workspaces[0]?.id, makeWorkspaceIdFromPathDigest(digest));
  assert.equal(config.workspaces[0]?.path, workspacePath);
});

test("readClientConfig derives workspace id for workspaces.json entry without id", (t) => {
  const tempHome = createTempHome(t);
  const workspacePath = path.join(tempHome, ".codeflowai", "workspace");
  withClientEnv(t, { CODEFLOWAI_WORKSPACES_JSON: JSON.stringify([{ path: workspacePath, label: "默认工作区" }]) });
  t.mock.method(os, "homedir", () => tempHome);

  writeConfig(tempHome, {
    apiKey: "api-key",
    serverWs: "ws://server/ws/client",
    clientId: "stable-client",
  });

  const digest = crypto.createHash("sha256").update(normalizeWorkspacePathForDerivedId(workspacePath)).digest("hex");
  const config = readClientConfig();
  assert.equal(config.workspaces[0]?.id, makeWorkspaceIdFromPathDigest(digest));
  assert.equal(config.workspaces[0]?.path, workspacePath);
  assert.equal(config.workspaces[0]?.label, "默认工作区");
});

test("readClientConfig reads workspace path index max entries from env", (t) => {
  const tempHome = createTempHome(t);
  withClientEnv(t, {
    CODEFLOWAI_API_KEY: "api-key",
    CODEFLOWAI_WORKSPACE_PATH_INDEX_MAX_ENTRIES: "450000",
  });
  t.mock.method(os, "homedir", () => tempHome);

  const config = readClientConfig();
  assert.equal(config.workspacePathIndex.maxEntries, 450_000);
});

test("Client config exposes no database encryption mode", (t) => {
  const tempHome = createTempHome(t);
  withClientEnv(t, { CODEFLOWAI_API_KEY: "api-key" });
  t.mock.method(os, "homedir", () => tempHome);

  const config = readClientConfig();
  assert.equal(Object.hasOwn(config, "dbSecurityMode"), false);
});

test("desktop config starts without a cloud key and persists a random stable data identity", (t) => {
  const tempHome = createTempHome(t);
  withClientEnv(t, {
    CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(tempHome, "desktop", "config.json"),
    CODEFLOWAI_CLIENT_DB_PATH: path.join(tempHome, "desktop", "codeflowai.db"),
  });
  t.mock.method(os, "homedir", () => tempHome);
  const first = readClientConfig({ desktop: true });
  assert.equal(first.apiKey, "");
  assert.match(first.clientId, /^local_[0-9a-f-]{36}$/);
  assert.equal(readClientConfig({ desktop: true }).clientId, first.clientId);
  assert.throws(() => readClientConfig(), /未配置 API Key/);
  assert.throws(() => saveConfigFile({ apiKey: "", serverWs: first.serverWsUrl, clientId: first.clientId }), /不能为空/);
});

test("desktop config requires isolated paths and keeps malformed persisted config explicit", (t) => {
  const tempHome = createTempHome(t);
  withClientEnv(t, {});
  t.mock.method(os, "homedir", () => tempHome);
  assert.throws(() => readClientConfig({ desktop: true }), /DESKTOP_STORAGE_PATH_REQUIRED/);
  process.env.CODEFLOWAI_CLIENT_CONFIG_PATH = path.join(tempHome, "desktop", "config.json");
  process.env.CODEFLOWAI_CLIENT_DB_PATH = path.join(tempHome, "desktop", "codeflowai.db");
  fs.mkdirSync(path.dirname(process.env.CODEFLOWAI_CLIENT_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(process.env.CODEFLOWAI_CLIENT_CONFIG_PATH, "{broken", "utf8");
  assert.throws(() => readClientConfig({ desktop: true }), SyntaxError);
  fs.writeFileSync(process.env.CODEFLOWAI_CLIENT_CONFIG_PATH, JSON.stringify({ clientId: 123 }), "utf8");
  assert.throws(() => readClientConfig({ desktop: true }), /DESKTOP_CONFIG_INVALID/);
});

test("desktop first install does not import implicit legacy workspaces", (t) => {
  const tempHome = createTempHome(t);
  withClientEnv(t, {
    CODEFLOWAI_CLIENT_CONFIG_PATH: path.join(tempHome, "desktop", "config.json"),
    CODEFLOWAI_CLIENT_DB_PATH: path.join(tempHome, "desktop", "codeflowai.db"),
  });
  t.mock.method(os, "homedir", () => tempHome);
  const legacy = [{ id: "ws_legacy", path: path.join(tempHome, "old-private-project"), label: undefined }];
  writeConfig(tempHome, { apiKey: "legacy-key", clientId: "legacy-client" });
  fs.writeFileSync(path.join(tempHome, ".codeflowai", "workspaces.json"), JSON.stringify(legacy), "utf8");
  assert.deepEqual(readClientConfig({ desktop: true }).workspaces, []);
  process.env.CODEFLOWAI_API_KEY = "remote-key";
  assert.deepEqual(readClientConfig().workspaces, legacy, "ordinary Client keeps its existing source");
  process.env.CODEFLOWAI_WORKSPACES_JSON = JSON.stringify(legacy);
  assert.deepEqual(readClientConfig({ desktop: true }).workspaces, legacy, "explicit isolated bootstrap remains supported");
});

function createTempHome(t: TestContext): string {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codeflowai-client-config-"));
  t.after(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });
  return tempHome;
}

function writeConfig(tempHome: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath(tempHome)), { recursive: true });
  fs.writeFileSync(configPath(tempHome), JSON.stringify(payload, null, 2), "utf8");
}

function configPath(tempHome: string): string {
  return path.join(tempHome, ".codeflowai", "config.json");
}

function withClientEnv(t: TestContext, values: Record<string, string | undefined>): void {
  const keys = [
    "CODEFLOWAI_API_KEY",
    "CODEFLOWAI_SERVER_WS",
    "CODEFLOWAI_CLIENT_ID",
    "CODEFLOWAI_CLIENT_CONFIG_PATH",
    "CODEFLOWAI_CLIENT_DB_PATH",
    "CODEFLOWAI_WORKSPACES_JSON",
    "CODEFLOWAI_WORKSPACES_FILE",
    "CODEFLOWAI_WORKSPACE_PATH",
    "CODEFLOWAI_WORKSPACE_ID",
    "CODEFLOWAI_WORKSPACE_PATH_INDEX_MAX_ENTRIES",
    "CODEFLOWAI_FILE_INDEX_MAX_ENTRIES",
    "CODEFLOWAI_ALLOW_CLIENT_ID_OVERRIDE",
  ];
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      const value = values[key];
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    } else {
      delete process.env[key];
    }
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}
