import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCredentialStore, FileCredentialStore } from "../src/security/credentialStore.ts";

function tempFile(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeflow-credential-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "credentials.json");
}

test("FileCredentialStore persists, reads, and deletes credentials", (t) => {
  const filePath = tempFile(t);
  const store = new FileCredentialStore(filePath);

  store.set("device-id:http://127.0.0.1:39280", "dev_test");
  assert.equal(store.get("device-id:http://127.0.0.1:39280"), "dev_test");

  store.delete("device-id:http://127.0.0.1:39280");
  assert.equal(store.get("device-id:http://127.0.0.1:39280"), null);
});

test("FileCredentialStore fails on invalid persisted JSON", (t) => {
  const filePath = tempFile(t);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "[]", "utf8");

  const store = new FileCredentialStore(filePath);
  assert.throws(() => store.get("device-id"), /Invalid credential store file/);
});

test("createCredentialStore uses explicit file mode", (t) => {
  const previousMode = process.env.CODEFLOWAI_CLIENT_CREDENTIAL_STORE;
  const previousFile = process.env.CODEFLOWAI_CLIENT_CREDENTIAL_STORE_FILE;
  const filePath = tempFile(t);
  t.after(() => {
    restoreEnv("CODEFLOWAI_CLIENT_CREDENTIAL_STORE", previousMode);
    restoreEnv("CODEFLOWAI_CLIENT_CREDENTIAL_STORE_FILE", previousFile);
  });
  process.env.CODEFLOWAI_CLIENT_CREDENTIAL_STORE = "file";
  process.env.CODEFLOWAI_CLIENT_CREDENTIAL_STORE_FILE = filePath;

  const store = createCredentialStore();
  store.set("device-private-key:http://127.0.0.1:39280", "secret");

  assert.equal(store.get("device-private-key:http://127.0.0.1:39280"), "secret");
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('builtin credentials cannot use the explicit headless file mode', t => {
  const previous = process.env.CODEFLOWAI_CLIENT_CREDENTIAL_STORE;
  t.after(() => restoreEnv('CODEFLOWAI_CLIENT_CREDENTIAL_STORE', previous));
  process.env.CODEFLOWAI_CLIENT_CREDENTIAL_STORE = 'file';
  assert.throws(() => createCredentialStore({ requireOs: true }), /OS Credential Store required/);
});
