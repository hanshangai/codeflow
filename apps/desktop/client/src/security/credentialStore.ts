import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveCreateRequireBase } from "../utils/createRequireBase.js";

const SERVICE_NAME = "codeflowai-client";
const STORE_MODE_ENV = "CODEFLOWAI_CLIENT_CREDENTIAL_STORE";
const STORE_FILE_ENV = "CODEFLOWAI_CLIENT_CREDENTIAL_STORE_FILE";

type KeyringEntry = {
  getPassword: () => string | null;
  setPassword: (password: string) => void;
  deletePassword: () => void;
};

export type CredentialStore = {
  get: (key: string) => string | null;
  set: (key: string, value: string) => void;
  delete: (key: string) => void;
};

/** Minimal OS credential store wrapper; unavailable storage must fail explicitly. */
export class OsCredentialStore implements CredentialStore {
  private readonly Entry: new (service: string, account: string) => KeyringEntry;

  /** Loads the native keyring module lazily so file mode does not require it. */
  constructor() {
    const require = createRequire(resolveCreateRequireBase());
    const mod = require("@napi-rs/keyring") as { Entry?: new (service: string, account: string) => KeyringEntry };
    if (!mod.Entry) throw new Error("@napi-rs/keyring Entry export missing");
    this.Entry = mod.Entry;
  }

  /** Reads one credential key and lets native storage errors bubble up. */
  get(key: string): string | null {
    const value = this.entry(key).getPassword();
    return typeof value === "string" && value.trim() ? value : null;
  }

  /** Writes one credential key; empty values indicate caller state corruption. */
  set(key: string, value: string): void {
    const text = String(value ?? "");
    if (!text) throw new Error(`credential value is empty: ${key}`);
    this.entry(key).setPassword(text);
  }

  /** Deletes one credential key for rotation or recovery flows. */
  delete(key: string): void {
    this.entry(key).deletePassword();
  }

  /** Builds a stable service/account pair for the OS keyring entry. */
  private entry(key: string): KeyringEntry {
    const account = normalizeCredentialKey(key);
    return new this.Entry(SERVICE_NAME, account);
  }
}

/** Explicit headless file store; enabled only by CODEFLOWAI_CLIENT_CREDENTIAL_STORE=file. */
export class FileCredentialStore implements CredentialStore {
  constructor(private readonly filePath = resolveCredentialStoreFilePath()) {}

  /** Reads one credential from JSON; a missing file means an empty store. */
  get(key: string): string | null {
    const value = this.readValues()[normalizeCredentialKey(key)];
    return typeof value === "string" && value.trim() ? value : null;
  }

  /** Writes one credential into a 0600 JSON file and rejects empty values. */
  set(key: string, value: string): void {
    const account = normalizeCredentialKey(key);
    const text = String(value ?? "");
    if (!text) throw new Error(`credential value is empty: ${account}`);
    const values = this.readValues();
    values[account] = text;
    this.writeValues(values);
  }

  /** Deletes one credential and fails if the backing file is invalid. */
  delete(key: string): void {
    const account = normalizeCredentialKey(key);
    const values = this.readValues();
    if (!(account in values)) return;
    delete values[account];
    this.writeValues(values);
  }

  /** Parses and validates the JSON file instead of treating corruption as empty. */
  private readValues(): Record<string, string> {
    if (!fs.existsSync(this.filePath)) return {};
    const raw = fs.readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid credential store file: ${this.filePath}`);
    }
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") throw new Error(`Invalid credential value in ${this.filePath}: ${key}`);
      values[key] = value;
    }
    return values;
  }

  /** Writes JSON atomically and restricts POSIX file permissions. */
  private writeValues(values: Record<string, string>): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(values, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
    if (process.platform !== "win32") fs.chmodSync(this.filePath, 0o600);
  }
}

/** Creates the configured store; default remains OS keyring, file mode is explicit. */
export function createCredentialStore(options: { requireOs?: boolean } = {}): CredentialStore {
  const mode = readCredentialStoreMode();
  if (options.requireOs && mode !== 'os') throw new Error('OS Credential Store required for built-in relay credentials');
  if (mode === "file") return new FileCredentialStore();
  try {
    return new OsCredentialStore();
  } catch (error) {
    throw new Error(`OS Credential Store unavailable; secure client startup cannot continue: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

/** Reads the store mode and fails on unknown values to avoid silent downgrade. */
function readCredentialStoreMode(): "os" | "file" {
  const raw = String(process.env[STORE_MODE_ENV] ?? "").trim().toLowerCase();
  if (!raw || raw === "os" || raw === "keyring" || raw === "system") return "os";
  if (raw === "file" || raw === "local_file" || raw === "headless") return "file";
  throw new Error(`Unsupported ${STORE_MODE_ENV}: ${raw}`);
}

/** Resolves the file store path; the default stays under the CodeFlow home. */
function resolveCredentialStoreFilePath(): string {
  const configured = String(process.env[STORE_FILE_ENV] ?? "").trim();
  return configured || path.join(os.homedir(), ".codeflowai", "credential-store.json");
}

/** Normalizes credential keys and fails on empty keys. */
function normalizeCredentialKey(key: string): string {
  const account = String(key ?? "").trim();
  if (!account) throw new Error("credential key is empty");
  return account;
}
