import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import crypto from "node:crypto";
import { execFile, spawn, spawnSync } from "node:child_process";

const source = new URL("../src/shellUpdateFileCoordinator.ts", import.meta.url);
const implementation = existsSync(fileURLToPath(source)) ? await import(source.href) : {};

/** A gate represents real physical work still holding its resources. */
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}

/** Each test binds an actual directory identity to a distinct pipe. */
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cf-file-coordinator-")));
  const stat = await fs.lstat(root, { bigint: true });
  const entry = (implementation as Record<string, unknown>).coordinateShellUpdateFile;
  assert.equal(typeof entry, "function", "coordinateShellUpdateFile must own the shared physical queue");
  return { root: { root, dev: stat.dev.toString(), ino: stat.ino.toString() },
    run: entry as <T>(root: unknown, request: unknown, execute: (request: any) => Promise<T>) => Promise<T> };
}

/** Acquire a real owner; tests assert externally visible admission and cleanup behavior. */
async function acquireOwner(root: unknown, execute: (request: any) => Promise<unknown>, timeoutMs = 10_000) {
  return await (implementation as Record<string, any>).acquireShellUpdateFileOwner(root, execute, timeoutMs);
}

/** Inspect or alter only this test's ACL using a real Windows token and literal encoded path. */
async function aclScript(target: string, script: string): Promise<string> {
  const input = Buffer.from(target, "utf8").toString("base64");
  const source = "$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + input + "'));" + script;
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  return await new Promise((resolve, reject) => execFile(executable,
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")],
    { windowsHide: true, timeout: 10_000, encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
}

test("authentication key is private to the OS account before its first write", async t => {
  const { root, run } = await fixture(), open = fs.open;
  let checked = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (path.basename(String(args[0])) === "key" && args[1] === "wx+") {
      const result = await aclScript(path.dirname(String(args[0])),
        "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=Get-Acl -LiteralPath $p;"
        + "$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));"
        + "if(-not $acl.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid){throw 'KEY_DIRECTORY_NOT_PRIVATE'};'private'");
      assert.equal(result, "private"); checked = true;
    }
    return await open(...args);
  });
  assert.equal(await run(root, { kind: "read" }, async () => "ok"), "ok");
  assert.equal(checked, true);
});

test("an explicit foreign auth ACL is rejected before business work", async () => {
  const { root, run } = await fixture();
  await run(root, { kind: "read" }, async () => "initialize");
  await aclScript(path.join(root.root, ".shell-update-file-auth", "key"),
    "$acl=[IO.File]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access);$sid=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545');"
    + "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow'));[IO.File]::SetAccessControl($p,$acl)");
  let executed = false;
  await assert.rejects(run(root, { kind: "read" }, async () => { executed = true; }), error =>
    (error as { code?: unknown }).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_AUTH_PERMISSION_UNAVAILABLE");
  assert.equal(executed, false);
});

test("a root replaced during attempt preflight is rejected before creating a probe", async t => {
  const { root, run } = await fixture(), lstat = fs.lstat;
  let replaced = false, executed = false;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === path.join(root.root, "shell-update-attempt.json") && !replaced) {
      replaced = true;
      await fs.rename(root.root, root.root + ".retained");
      await fs.mkdir(root.root);
    }
    return await lstat(...args);
  });
  await assert.rejects(run(root, { kind: "read" }, async () => { executed = true; }), error =>
    (error as { code?: unknown }).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_MISMATCH");
  assert.equal(replaced, true);
  assert.equal(executed, false);
  assert.deepEqual(await fs.readdir(root.root), []);
});

test("writer precedes queued readers after the active reader closes, with FIFO writers", async () => {
  const { root, run } = await fixture(), started = gate(), close = gate(), events: string[] = [];
  const active = run(root, { kind: "read" }, async () => {
    events.push("read-open"); started.release(); await close.promise; events.push("read-close"); return 0;
  });
  await started.promise;
  const earlyReader = run(root, { kind: "read" }, async () => { events.push("queued-read"); return 1; });
  const first = run(root, { kind: "replace", expected: null, next: {} }, async () => { events.push("writer-1"); return 2; });
  const second = run(root, { kind: "checkExpected", expected: {} }, async () => { events.push("writer-2"); return 3; });
  const lateReader = run(root, { kind: "read" }, async () => { events.push("late-read"); return 4; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["read-open"]);
  close.release();
  assert.deepEqual(await Promise.all([active, earlyReader, first, second, lateReader]), [0, 1, 2, 3, 4]);
  assert.deepEqual(events, ["read-open", "read-close", "writer-1", "writer-2", "queued-read", "late-read"]);
});

test("ordinary local failure keeps its Error reference and releases the next physical operation", async () => {
  const { root, run } = await fixture(), failure = new Error("physical read failed"), started = gate(), finish = gate();
  const failed = run(root, { kind: "read" }, async () => { started.release(); await finish.promise; throw failure; });
  const observed = assert.rejects(failed, error => error === failure);
  await started.promise;
  const following = run(root, { kind: "checkExpected", expected: {} }, async () => "checked");
  finish.release(); await observed;
  assert.equal(await following, "checked");
});

test("publishes one immutable authentication key before physical work and reuses its identity", async () => {
  const { root, run } = await fixture();
  const execute = async () => {
    const key = await fs.lstat(path.join(root.root, ".shell-update-file-auth", "key"), { bigint: true });
    assert.equal(key.size, 32n); assert.equal(key.nlink, 1n); assert.equal(key.isFile(), true);
    return key.ino.toString();
  };
  const first = await run(root, { kind: "read" }, execute);
  assert.equal(await run(root, { kind: "read" }, execute), first);
  assert.deepEqual(await fs.readdir(path.join(root.root, ".shell-update-file-auth")), ["key"]);
});

test("rejects before ready when an existing attempt is not writable by the current account", async () => {
  const { root, run } = await fixture(), target = path.join(root.root, "shell-update-attempt.json");
  await fs.writeFile(target, "existing", "utf8");
  await fs.chmod(target, 0o444);
  try {
    await assert.rejects(run(root, { kind: "read" }, async () => "must-not-run"), error => {
      assert.equal((error as { code?: unknown }).code, "DESKTOP_SHELL_UPDATE_COORDINATOR_CAPABILITY_WRITE_RENAME_UNAVAILABLE");
      return true;
    });
  } finally { await fs.chmod(target, 0o666); }
});

/** Fault injection precedes a fresh module import so the real capability I/O remains observable. */
async function freshCoordinator() {
  return (await import(`${source.href}?test=${crypto.randomUUID()}`)).coordinateShellUpdateFile;
}

/** Retain falsy exceptions when traversing wrappers and aggregate causes. */
function containsCause(error: unknown, cause: unknown): boolean {
  return error === cause || error instanceof Error && (Object.hasOwn(error, "cause") && containsCause(error.cause, cause)
    || error instanceof AggregateError && error.errors.some(item => containsCause(item, cause)));
}

for (const primary of [null, false]) test(`capability verification preserves a thrown ${String(primary)}`, async t => {
  const { root } = await fixture(), open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).includes(".shell-update-file-capability-")) t.mock.method(file, "read", async () => { throw primary; });
    return file;
  });
  const run = await freshCoordinator(); let executed = false;
  await assert.rejects(run(root, { kind: "read" }, async () => { executed = true; }), error => containsCause(error, primary));
  assert.equal(executed, false);
});

test("capability mkdir collision never deletes the unowned directory", async t => {
  const { root } = await fixture(), mkdir = fs.mkdir; let foreign: string | undefined;
  t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
    if (String(args[0]).includes(".shell-update-file-capability-")) {
      foreign = String(args[0]); await mkdir(...args);
      throw Object.assign(new Error("foreign probe directory"), { code: "EEXIST" });
    }
    return await mkdir(...args);
  });
  const run = await freshCoordinator();
  await assert.rejects(run(root, { kind: "read" }, async () => "must-not-run"));
  assert.ok(foreign); assert.equal((await fs.lstat(foreign)).isDirectory(), true);
});

test("capability cleanup throwing false blocks ready and preserves its cause", async t => {
  const { root } = await fixture(), unlink = fs.unlink;
  t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => {
    if (String(args[0]).includes(".shell-update-file-capability-")) throw false;
    return await unlink(...args);
  });
  const run = await freshCoordinator(); let executed = false;
  await assert.rejects(run(root, { kind: "read" }, async () => { executed = true; }), error => containsCause(error, false));
  assert.equal(executed, false);
});

test("capability readback close failure poisons the root before any business operation", async t => {
  const { root } = await fixture(), open = fs.open, closeFailure = new Error("readback close ownership unknown");
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).includes(".shell-update-file-capability-") && args[1] === 0) {
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => { await close(); throw closeFailure; });
    }
    return file;
  });
  const run = await freshCoordinator();
  await assert.rejects(run(root, { kind: "read" }, async () => "must-not-run"), error =>
    (error as { code?: unknown }).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_POISONED" && containsCause(error, closeFailure));
  await assert.rejects(run(root, { kind: "replace", expected: null, next: {} }, async () => "must-not-run"), error =>
    (error as { code?: unknown }).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_POISONED");
});

for (const timing of ["before-open", "during-read"] as const) test(`capability readback rejects extra bytes added ${timing}`, async t => {
  const { root } = await fixture(), open = fs.open;
  let injected = false, executed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const target = String(args[0]), readback = target.includes(".shell-update-file-capability-") && args[1] === 0;
    if (readback && timing === "before-open") { await fs.appendFile(target, "extra"); injected = true; }
    const file = await open(...args);
    if (readback && timing === "during-read") {
      const read = file.read.bind(file);
      t.mock.method(file, "read", async (...input: any[]) => {
        const result = await (read as any)(...input);
        if (!injected) { await fs.appendFile(target, "extra"); injected = true; }
        return result;
      });
    }
    return file;
  });
  const run = await freshCoordinator();
  await assert.rejects(run(root, { kind: "read" }, async () => { executed = true; }), error =>
    (error as { code?: unknown }).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_CAPABILITY_WRITE_RENAME_UNAVAILABLE");
  assert.equal(injected, true);
  assert.equal(executed, false);
  assert.deepEqual(await fs.readdir(root.root), [".shell-update-file-auth"]);
});

test("a real attempt write deny ACL blocks readiness without changing file bytes", async () => {
  const { root, run } = await fixture(), target = path.join(root.root, "shell-update-attempt.json");
  await fs.writeFile(target, "unchanged", "utf8");
  await aclScript(target, "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;"
    + "$acl=[IO.File]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access);"
    + "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'WriteData','Deny'));[IO.File]::SetAccessControl($p,$acl)");
  try {
    await assert.rejects(run(root, { kind: "read" }, async () => "must-not-run"), error =>
      (error as { code?: unknown }).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_CAPABILITY_WRITE_RENAME_UNAVAILABLE");
    assert.equal(await fs.readFile(target, "utf8"), "unchanged");
  } finally {
    await aclScript(target, "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;"
      + "$acl=[IO.File]::GetAccessControl($p,[Security.AccessControl.AccessControlSections]::Access);"
      + "$acl.RemoveAccessRuleSpecific([Security.AccessControl.FileSystemAccessRule]::new($sid,'WriteData','Deny'));[IO.File]::SetAccessControl($p,$acl)");
  }
});

test("environment account labels cannot change the authenticated OS principal", async () => {
  const { root, run } = await fixture(), user = process.env.USERNAME, domain = process.env.USERDOMAIN;
  try {
    process.env.USERNAME = "D13-nonexistent-account"; process.env.USERDOMAIN = "D13-nonexistent-domain";
    assert.equal(await run(root, { kind: "read" }, async () => "ok"), "ok");
  } finally {
    if (user === undefined) delete process.env.USERNAME; else process.env.USERNAME = user;
    if (domain === undefined) delete process.env.USERDOMAIN; else process.env.USERDOMAIN = domain;
  }
});

for (const defect of ["empty", "wrong-length", "extra-file", "hardlink"] as const) {
  test(`rejects an existing ${defect} authentication directory before physical work`, async () => {
    const { root, run } = await fixture(), directory = path.join(root.root, ".shell-update-file-auth");
    await fs.mkdir(directory);
    if (defect !== "empty") await fs.writeFile(path.join(directory, "key"), Buffer.alloc(defect === "wrong-length" ? 31 : 32));
    if (defect === "extra-file") await fs.writeFile(path.join(directory, "other"), "unexpected");
    if (defect === "hardlink") await fs.link(path.join(directory, "key"), path.join(root.root, "key-link"));
    let executed = false;
    await assert.rejects(run(root, { kind: "read" }, async () => { executed = true; return "invalid"; }));
    assert.equal(executed, false);
  });
}

/** Observe the real request arrival without changing frame bytes or coordinator behavior. */
function requestArrival(t: test.TestContext) {
  const arrived = gate(), emit = net.Server.prototype.emit;
  t.mock.method(net.Server.prototype, "emit", function (this: net.Server, event: string | symbol, ...args: any[]) {
    if (event === "connection") {
      const socket = args[0] as net.Socket; let buffer = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4 && buffer.length >= buffer.readUInt32BE() + 4) {
          const length = buffer.readUInt32BE(), frame = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
          buffer = buffer.subarray(length + 4);
          if (frame.kind === "request") arrived.release();
        }
      });
    }
    return emit.call(this, event, ...args);
  });
  return arrived.promise;
}

/** A fresh Node calls the actual coordinator once or sequentially; local fallback visibly fails. */
async function remote(root: unknown, directory: string, request: unknown) {
  const script = path.join(directory, `remote-${crypto.randomUUID()}.mjs`);
  await fs.writeFile(script, `import {coordinateShellUpdateFile} from ${JSON.stringify(source.href)};
try {const values=[];for(const request of ${JSON.stringify(Array.isArray(request) ? request : [request])}){values.push(await coordinateShellUpdateFile(${JSON.stringify(root)},request,async()=>{throw new Error('REMOTE_EXECUTOR_MUST_NOT_RUN')}));}process.send({ok:true,value:${Array.isArray(request) ? "values" : "values[0]"}});}
catch(error){const encode=e=>e instanceof Error?{message:e.message,code:e.code,phase:e.phase,syscall:e.syscall,stateReplaced:e.stateReplaced,commitStatus:e.commitStatus,cause:encode(e.cause),errors:e instanceof AggregateError?e.errors.map(encode):undefined}:e;process.send({ok:false,error:encode(error)});}
finally{process.disconnect();}`, "utf8");
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", script], { cwd: process.cwd(), env: process.env,
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = ""; child.stdout!.on("data", value => { output += value; }); child.stderr!.on("data", value => { output += value; });
  const result = new Promise<any>((resolve, reject) => { child.once("message", resolve); child.once("error", reject); });
  const exit = new Promise<void>((resolve, reject) => {
    child.once("error", reject); child.once("exit", code => { if (code === 0) resolve(); else reject(new Error(`remote exit ${code}: ${output}`)); });
  });
  return { result, exit };
}

test("an idle owner scope keeps fresh processes on its executor across physical operations", { timeout: 15_000 }, async () => {
  const { root, run } = await fixture();
  const acquire = (implementation as Record<string, any>).acquireShellUpdateFileOwner;
  const execute = async (request: any) => request.kind === "read" ? { schemaVersion: 5 } : "written";
  const owner = typeof acquire === "function" ? await acquire(root, execute, 10_000) : undefined;
  try {
    assert.deepEqual(await run(root, { kind: "read" }, execute), { schemaVersion: 5 });
    const child = await remote(root, root.root, [{ kind: "read" }, { kind: "replace", expected: null, next: {} }, { kind: "read" }]);
    const result = await child.result; await child.exit;
    assert.deepEqual(result, { ok: true, value: [{ schemaVersion: 5 }, "written", { schemaVersion: 5 }] });
  } finally { await owner?.release(); }
});

test("scoped physical operations close their handles before idle waits and retain writer priority", async t => {
  const { root, run } = await fixture(), started = gate(), finish = gate(), events: string[] = [];
  const target = path.join(root.root, "physical-handle");
  await fs.writeFile(target, "physical", "utf8");
  let handles = 0;
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]) === target) {
      handles++;
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => { await close(); handles--; });
    }
    return file;
  });
  const owner = await acquireOwner(root, async () => "owner");
  try {
    const active = run(root, { kind: "read" }, async () => {
      const file = await fs.open(target, "r");
      try { events.push("read-open"); started.release(); await finish.promise; return "closed"; }
      finally { await file.close(); events.push("read-close"); }
    });
    await started.promise;
    const reader = run(root, { kind: "read" }, async () => { events.push("reader"); return 1; });
    const writer = run(root, { kind: "replace", expected: null, next: {} }, async () => { events.push("writer"); return 2; });
    await new Promise(resolve => setImmediate(resolve)); finish.release();
    assert.deepEqual(await Promise.all([active, reader, writer]), ["closed", 1, 2]);
    assert.deepEqual(events, ["read-open", "read-close", "writer", "reader"]);
    assert.equal(handles, 0); owner.assertActive();
  } finally { finish.release(); await owner.release(); }
});

test("a live owner or ordinary job rejects nested acquisition without changing remote execution", async () => {
  const { root, run } = await fixture(), started = gate(), finish = gate();
  const active = run(root, { kind: "read" }, async () => { started.release(); await finish.promise; return "ordinary"; });
  await started.promise;
  await assert.rejects(acquireOwner(root, async () => "stolen"), error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_BUSY");
  finish.release(); assert.equal(await active, "ordinary");
  const owner = await acquireOwner(root, async () => "owner");
  try {
    await assert.rejects(acquireOwner(root, async () => "stolen"), error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_BUSY");
    const child = await remote(root, root.root, { kind: "read" });
    assert.deepEqual(await child.result, { ok: true, value: "owner" }); await child.exit;
    const other = await fixture();
    assert.equal(await other.run(other.root, { kind: "read" }, async () => "independent"), "independent");
  } finally { await owner.release(); }
  await owner.release();
  assert.throws(() => owner.assertActive(), error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_SCOPE_RELEASED");
  assert.equal(await run(root, { kind: "read" }, async () => "successor"), "successor");
});

test("scope expiry rejects every same-root entry until explicit release completes", async () => {
  const { root, run } = await fixture(), owner = await acquireOwner(root, async () => "owner", 30);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.throws(() => owner.assertActive(), error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_SCOPE_EXPIRED");
  let ran = false;
  await assert.rejects(run(root, { kind: "read" }, async () => { ran = true; }), error =>
    (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_SCOPE_EXPIRED");
  await assert.rejects(acquireOwner(root, async () => "stolen"), error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_BUSY");
  assert.equal(ran, false);
  await assert.rejects(owner.release(), error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_SCOPE_EXPIRED");
  assert.equal(await run(root, { kind: "read" }, async () => "successor"), "successor");
});

test("expiry and release wait for real active cleanup and do not execute queued side effects", async () => {
  const { root, run } = await fixture(), started = gate(), finish = gate();
  const owner = await acquireOwner(root, async () => "owner", 50);
  const active = run(root, { kind: "read" }, async () => { started.release(); await finish.promise; return "physically-closed"; });
  await started.promise;
  let queuedRan = false, released = false;
  const queued = assert.rejects(run(root, { kind: "replace", expected: null, next: {} }, async () => { queuedRan = true; }), error =>
    (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_SCOPE_EXPIRED");
  await new Promise(resolve => setTimeout(resolve, 80));
  const release = assert.rejects(owner.release(), error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_SCOPE_EXPIRED")
    .then(() => { released = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(released, false);
  finish.release();
  assert.equal(await active, "physically-closed"); await queued; await release;
  assert.equal(queuedRan, false); assert.equal(released, true);
});

test("invalid scope lifetimes fail before listener or executor side effects", async t => {
  const { root } = await fixture(); let listened = false;
  const listen = net.Server.prototype.listen;
  t.mock.method(net.Server.prototype, "listen", function (this: net.Server, ...args: any[]) { listened = true; return (listen as any).apply(this, args); });
  for (const timeout of [0, -1, Infinity, NaN]) {
    await assert.rejects(acquireOwner(root, async () => "unsafe", timeout), error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_OWNER_TIMEOUT_INVALID");
  }
  assert.equal(listened, false);
});

test("owner acquisition failure waits for listener cleanup and preserves authentication and close errors", async t => {
  const { root, run } = await fixture(), directory = path.join(root.root, ".shell-update-file-auth");
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, "extra"), "invalid", "utf8");
  const close = net.Server.prototype.close, closeFailure = new Error("listener close failed");
  t.mock.method(net.Server.prototype, "close", function (this: net.Server, callback?: (error?: Error) => void) {
    return close.call(this, () => callback?.(closeFailure));
  });
  await assert.rejects(acquireOwner(root, async () => "unsafe"), error => containsCause(error, closeFailure)
    && containsCode(error, "DESKTOP_SHELL_UPDATE_COORDINATOR_AUTH_KEY_INVALID"));
  await assert.rejects(run(root, { kind: "read" }, async () => "unsafe"), error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_POISONED");
});

/** Preserve the error contract through local aggregates without depending on internal state. */
function containsCode(error: unknown, code: string): boolean {
  return error instanceof Error && ((error as any).code === code || containsCode(error.cause, code)
    || error instanceof AggregateError && error.errors.some(item => containsCode(item, code)));
}

test("release close failure retains root poison and leaves other roots available", async t => {
  const { root, run } = await fixture(), owner = await acquireOwner(root, async () => "owner");
  const close = net.Server.prototype.close, failure = new Error("scope listener close failed");
  const mock = t.mock.method(net.Server.prototype, "close", function (this: net.Server, callback?: (error?: Error) => void) {
    return close.call(this, () => callback?.(failure));
  });
  await assert.rejects(owner.release(), error => containsCause(error, failure)); mock.mock.restore();
  await assert.rejects(owner.release(), error => containsCause(error, failure));
  await assert.rejects(run(root, { kind: "read" }, async () => "unsafe"), error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_POISONED");
  const other = await fixture(); assert.equal(await other.run(other.root, { kind: "read" }, async () => "available"), "available");
});

test("a replaced scoped root fails before physical work and release reports the mismatch", async () => {
  const { root, run } = await fixture(), owner = await acquireOwner(root, async () => "owner");
  await fs.rename(root.root, root.root + ".retained"); await fs.mkdir(root.root);
  let executed = false;
  await assert.rejects(run(root, { kind: "read" }, async () => { executed = true; }), error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_MISMATCH");
  assert.equal(executed, false);
  await assert.rejects(owner.release(), error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_MISMATCH");
});

test("a physical unknown-close error remains the primary error and release separately reports poison", async () => {
  const { root, run } = await fixture(), owner = await acquireOwner(root, async () => "owner");
  const physical = Object.assign(new AggregateError([new Error("business failed"), new Error("handle close failed")], "physical failed"), { resourcesReleased: false });
  await assert.rejects(run(root, { kind: "replace", expected: null, next: {} }, async () => { throw physical; }), error => error === physical);
  await assert.rejects(owner.release(), error => containsCause(error, physical)
    && containsCode(error, "DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_POISONED"));
});

test("ordinary completion closes the listener before a synchronous child elects its executor", async () => {
  const { root, run } = await fixture(), script = path.join(root.root, "sync-successor.mjs");
  assert.equal(await run(root, { kind: "read" }, async () => "parent"), "parent");
  await fs.writeFile(script, `import {coordinateShellUpdateFile} from ${JSON.stringify(source.href)};
const result=await coordinateShellUpdateFile(${JSON.stringify(root)},{kind:'read'},async()=> 'sync-child');
process.stdout.write(result);`, "utf8");
  const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", script], {
    cwd: process.cwd(), env: process.env, windowsHide: true, encoding: "utf8", timeout: 10_000
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 0); assert.equal(result.stdout, "sync-child");
});

test("a scoped remote disconnect cannot release physical work early or block later operations", { timeout: 10_000 }, async t => {
  const { root, run } = await fixture(), started = gate(), close = gate(), events: string[] = [], logs: string[] = [];
  t.mock.method(console, "error", (message: string) => { logs.push(message); });
  const owner = await acquireOwner(root, async () => { events.push("remote-open"); started.release(); await close.promise; events.push("remote-close"); return "closed"; });
  const script = path.join(root.root, "disconnect-reader.mjs");
  await fs.writeFile(script, `import {coordinateShellUpdateFile} from ${JSON.stringify(source.href)};
await coordinateShellUpdateFile(${JSON.stringify(root)},{kind:'read'},async()=>{throw new Error('UNEXPECTED_LOCAL')});`, "utf8");
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", script], {
    cwd: process.cwd(), env: process.env, windowsHide: true, stdio: "ignore"
  });
  const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
  try {
    await started.promise; child.kill(); await exited;
    const next = run(root, { kind: "replace", expected: null, next: {} }, async () => { events.push("writer"); return "written"; });
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ["remote-open"]);
    close.release(); assert.equal(await next, "written");
    await owner.release();
    assert.deepEqual(events, ["remote-open", "remote-close", "writer"]);
    assert.ok(logs.some(message => JSON.parse(message).requestId));
  } finally { child.kill(); close.release(); await owner.release(); }
});

test("a bind error fails acquisition explicitly and a later owner can still be elected", async t => {
  const { root } = await fixture(), listen = net.Server.prototype.listen, cause = Object.assign(new Error("bind denied"), { code: "EACCES" });
  const mock = t.mock.method(net.Server.prototype, "listen", function (this: net.Server) {
    queueMicrotask(() => this.emit("error", cause)); return this;
  });
  await assert.rejects(acquireOwner(root, async () => "unsafe"), error => containsCause(error, cause)
    && containsCode(error, "DESKTOP_SHELL_UPDATE_COORDINATOR_LISTEN_FAILED"));
  mock.mock.restore();
  assert.equal(net.Server.prototype.listen, listen);
  const owner = await acquireOwner(root, async () => "owner"); await owner.release();
});

test("acquisition cannot take another listener and fails when its original bind budget elapses", async t => {
  const { root } = await fixture();
  const pipe = `\\\\.\\pipe\\codeflowai-shell-update-attempt-${crypto.createHash("sha256").update(`${root.dev}:${root.ino}`).digest("hex")}`;
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipe, resolve); });
  const now = Date.now(), emit = net.Server.prototype.emit; let elapsed = 0;
  t.mock.method(Date, "now", () => now + elapsed);
  t.mock.method(net.Server.prototype, "emit", function (this: net.Server, event: string | symbol, ...args: any[]) {
    if (event === "error" && args[0]?.code === "EADDRINUSE") elapsed = 30_001;
    return emit.call(this, event, ...args);
  });
  try {
    await assert.rejects(acquireOwner(root, async () => "stolen"), error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_DEADLINE_EXCEEDED");
    assert.equal(server.listening, true);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("release budget expiry retains an active operation until its actual cleanup and keeps poison", async t => {
  const { root, run } = await fixture(), owner = await acquireOwner(root, async () => "owner"), started = gate(), close = gate();
  const active = run(root, { kind: "read" }, async () => { started.release(); await close.promise; return "physically-closed"; });
  await started.promise;
  const nativeTimer = globalThis.setTimeout; let expireClose!: () => void;
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, timeout: number, ...args: any[]) => {
    if (timeout === 30_000) expireClose = callback;
    return (nativeTimer as any)(callback, timeout, ...args);
  }) as typeof setTimeout);
  let released = false;
  const release = assert.rejects(owner.release(), error => containsCode(error, "DESKTOP_SHELL_UPDATE_COORDINATOR_CLOSE_TIMEOUT"))
    .then(() => { released = true; });
  expireClose(); await new Promise(resolve => setImmediate(resolve)); assert.equal(released, false);
  close.release(); assert.equal(await active, "physically-closed"); await release;
  await assert.rejects(run(root, { kind: "read" }, async () => "unsafe"), error => containsCode(error, "DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_POISONED"));
});

test("ordinary business and listener close errors remain separately observable", async t => {
  const { root, run } = await fixture(), business = new Error("business read failed"), closeFailure = new Error("listener close failed");
  const close = net.Server.prototype.close;
  t.mock.method(net.Server.prototype, "close", function (this: net.Server, callback?: (error?: Error) => void) {
    return close.call(this, () => callback?.(closeFailure));
  });
  await assert.rejects(run(root, { kind: "read" }, async () => { throw business; }), error =>
    containsCause(error, business) && containsCause(error, closeFailure));
});

test("an unconfirmed acquisition close fails within its budget and retains root poison", async t => {
  const { root, run } = await fixture(), directory = path.join(root.root, ".shell-update-file-auth"), closed = gate();
  await fs.mkdir(directory); await fs.writeFile(path.join(directory, "extra"), "invalid", "utf8");
  const close = net.Server.prototype.close, nativeTimer = globalThis.setTimeout;
  t.mock.method(net.Server.prototype, "close", function (this: net.Server) {
    return close.call(this, () => closed.release());
  });
  t.mock.method(globalThis, "setTimeout", ((callback: (...args: any[]) => void, timeout: number, ...args: any[]) =>
    (nativeTimer as any)(callback, timeout === 30_000 ? 1 : timeout, ...args)) as typeof setTimeout);
  const acquiring = acquireOwner(root, async () => "unsafe");
  await closed.promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(Promise.race([acquiring, new Promise<never>((_, reject) => {
      timer = nativeTimer(() => reject(new Error("ACQUIRE_CLOSE_BUDGET_EXCEEDED")), 200);
    })]), error => containsCode(error, "DESKTOP_SHELL_UPDATE_COORDINATOR_CLOSE_TIMEOUT")
      && containsCode(error, "DESKTOP_SHELL_UPDATE_COORDINATOR_AUTH_KEY_INVALID"));
    await assert.rejects(run(root, { kind: "read" }, async () => "unsafe"), error => containsCode(error, "DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_POISONED"));
  } finally { clearTimeout(timer); }
});

test("authenticated fresh Node executes on the owner and receives nested physical error context", { timeout: 10_000 }, async t => {
  const { root, run } = await fixture(), started = gate(), close = gate(), arrived = requestArrival(t);
  const native = Object.assign(new Error("native context"), { code: "EIO", syscall: "read" });
  const physical = Object.assign(new Error("physical failure", { cause: new AggregateError([native, undefined], "combined") }),
    { code: "PHYSICAL_FAILED", requestId: "request-1", phase: "check-expected", stateReplaced: false });
  const active = run(root, { kind: "read" }, async request => {
    if (request.kind === "read") { started.release(); await close.promise; return "active"; }
    throw physical;
  });
  await started.promise;
  const child = await remote(root, root.root, { kind: "checkExpected", expected: {} });
  await arrived; close.release();
  const result = await child.result; await child.exit; assert.equal(await active, "active");
  assert.equal(result.ok, false); assert.equal(result.error.code, "PHYSICAL_FAILED");
  assert.equal(result.error.phase, "check-expected"); assert.equal(result.error.stateReplaced, false);
  assert.equal(result.error.cause.errors[0].code, "EIO"); assert.equal(result.error.cause.errors[0].syscall, "read");
});

test("an unauthenticated pipe owner cannot obtain a business request or invent a successful result", async () => {
  const { root, run } = await fixture();
  await run(root, { kind: "read" }, async () => "initialize");
  const pipe = `\\\\.\\pipe\\codeflowai-shell-update-attempt-${crypto.createHash("sha256").update(`${root.dev}:${root.ino}`).digest("hex")}`;
  let requests = 0;
  const server = net.createServer(socket => {
    socket.on("error", () => { socket.destroy(); });
    socket.once("data", chunk => {
      const hello = JSON.parse((chunk as Buffer).subarray(4).toString("utf8"));
      const body = Buffer.from(JSON.stringify({ kind: "challenge", id: hello.id, epoch: crypto.randomUUID(), nonce: "1".repeat(64), proof: "0".repeat(64) }));
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(body.length);
      socket.write(Buffer.concat([prefix, body]));
      socket.on("data", () => { requests++; });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(pipe, resolve); });
  try {
    await assert.rejects(run(root, { kind: "replace", expected: null, next: {} }, async () => "forged"),
      error => (error as { code?: unknown }).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_AUTH_FAILED");
    assert.equal(requests, 0);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("a close ownership failure poisons only its root, rejects waiting writes and retains election ownership", async () => {
  const { root, run } = await fixture(), started = gate(), close = gate(); let writes = 0;
  const cause = Object.assign(new Error("close ownership unknown"), { resourcesReleased: false });
  const active = run(root, { kind: "read" }, async () => { started.release(); await close.promise; throw cause; });
  const failed = assert.rejects(active, error => error === cause); await started.promise;
  const writing = run(root, { kind: "replace", expected: null, next: {} }, async () => { writes++; return 1; });
  const rejected = assert.rejects(writing, error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_POISONED");
  close.release(); await failed; await rejected;
  await assert.rejects(run(root, { kind: "read" }, async () => "unsafe"), error => (error as any).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_ROOT_POISONED");
  assert.equal(writes, 0);
  const pipe = `\\\\.\\pipe\\codeflowai-shell-update-attempt-${crypto.createHash("sha256").update(`${root.dev}:${root.ino}`).digest("hex")}`;
  const competing = net.createServer();
  await assert.rejects(new Promise<void>((resolve, reject) => { competing.once("error", reject); competing.listen(pipe, resolve); }), error => (error as any).code === "EADDRINUSE");
  const other = await fixture(); assert.equal(await other.run(other.root, { kind: "read" }, async () => "available"), "available");
});

test("authenticated remote success completes before local epoch closure without abandoning its response", { timeout: 10_000 }, async t => {
  const { root, run } = await fixture(), started = gate(), close = gate(), arrived = requestArrival(t); let calls = 0;
  const active = run(root, { kind: "read" }, async () => {
    if (calls++ === 0) { started.release(); await close.promise; return "local"; }
    return { snapshot: 42 };
  });
  await started.promise;
  const child = await remote(root, root.root, { kind: "read" });
  await arrived; close.release();
  assert.deepEqual(await child.result, { ok: true, value: { snapshot: 42 } });
  await child.exit; assert.equal(await active, "local");
});

test("owner exits after committing a sent write: report unknown without replay, then elect a fresh owner", { timeout: 10_000 }, async () => {
  const { root, run } = await fixture(), script = path.join(root.root, "exit-owner.mjs"), marker = path.join(root.root, "commits");
  await fs.writeFile(script, `import net from 'node:net';import fs from 'node:fs/promises';import {coordinateShellUpdateFile} from ${JSON.stringify(source.href)};
process.on('message',()=>{throw new Error('UNEXPECTED_OWNER_MESSAGE')});
let release;const held=new Promise(resolve=>release=resolve),emit=net.Server.prototype.emit;
net.Server.prototype.emit=function(event,...args){if(event==='connection'){let buffer=Buffer.alloc(0);args[0].on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length>=4&&buffer.length>=buffer.readUInt32BE()+4){const length=buffer.readUInt32BE(),frame=JSON.parse(buffer.subarray(4,length+4));buffer=buffer.subarray(length+4);if(frame.kind==='request')release();}});}return emit.call(this,event,...args);};
await coordinateShellUpdateFile(${JSON.stringify(root)},{kind:'read'},async request=>{if(request.kind==='read'){process.send('ready');await held;return null;}await fs.appendFile(${JSON.stringify(marker)},'committed\\n','utf8');process.exit(0);});`, "utf8");
  const child = spawn(process.execPath, ["--conditions=development", "--import", "tsx", script], { cwd: process.cwd(), env: process.env,
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let stderr = ""; child.stderr!.on("data", value => { stderr += value; });
  const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr))); });
  await new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); });
  let localExecutions = 0;
  await assert.rejects(run(root, { kind: "replace", expected: null, next: {} }, async () => { localExecutions++; return "replayed"; }), error => {
    assert.equal((error as any).code, "DESKTOP_SHELL_UPDATE_COORDINATOR_COMMIT_UNKNOWN");
    assert.equal((error as any).commitStatus, "unknown"); assert.notEqual((error as any).stateReplaced, false); return true;
  });
  await exited; assert.equal(localExecutions, 0); assert.equal(await fs.readFile(marker, "utf8"), "committed\n");
  assert.equal(await run(root, { kind: "read" }, async () => "new-owner"), "new-owner");
});

test("oversized local requests fail before executing physical work", async () => {
  const { root, run } = await fixture(); let executed = false;
  await assert.rejects(run(root, { kind: "replace", expected: null, next: { text: "x".repeat(4 * 1024 * 1024) } }, async () => { executed = true; return 1; }));
  assert.equal(executed, false);
});

test("draining rejects a new incomplete handshake so it cannot retain local completion", async t => {
  const { root, run } = await fixture(), firstStarted = gate(), firstClose = gate(), secondStarted = gate(), secondClose = gate();
  const first = run(root, { kind: "read" }, async () => { firstStarted.release(); await firstClose.promise; return 1; });
  await firstStarted.promise;
  const second = run(root, { kind: "read" }, async () => { secondStarted.release(); await secondClose.promise; return 2; });
  firstClose.release(); await secondStarted.promise;
  const connected = gate(), emit = net.Server.prototype.emit;
  t.mock.method(net.Server.prototype, "emit", function (this: net.Server, event: string | symbol, ...args: any[]) {
    const result = emit.call(this, event, ...args); if (event === "connection") connected.release(); return result;
  });
  const pipe = `\\\\.\\pipe\\codeflowai-shell-update-attempt-${crypto.createHash("sha256").update(`${root.dev}:${root.ino}`).digest("hex")}`;
  const socket = net.connect(pipe);
  socket.on("error", () => socket.destroy());
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  await connected.promise;
  await new Promise(resolve => setImmediate(resolve)); secondClose.release();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([Promise.all([first, second]), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("NEW_HANDSHAKE_RETAINED_DRAIN")), 500);
    })]);
    assert.deepEqual(result, [1, 2]);
  } finally { clearTimeout(timer); socket.destroy(); }
});

test("authentication initialization failure rejects a local operation and closes an already connected peer", async t => {
  const { root, run } = await fixture(), auth = path.join(root.root, ".shell-update-file-auth"), authStarted = gate(), releaseAuth = gate();
  await fs.rm(auth, { recursive: true, force: true });
  await fs.mkdir(auth); await fs.writeFile(path.join(auth, "key"), Buffer.alloc(32)); await fs.writeFile(path.join(auth, "extra"), "invalid");
  const readdir = fs.readdir;
  t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    if (String(args[0]) === auth) { authStarted.release(); await releaseAuth.promise; }
    return readdir(...args);
  });
  const local = run(root, { kind: "read" }, async () => "must-not-run");
  await authStarted.promise;
  const pipe = `\\\\.\\pipe\\codeflowai-shell-update-attempt-${crypto.createHash("sha256").update(`${root.dev}:${root.ino}`).digest("hex")}`;
  const socket = net.connect(pipe); socket.on("error", () => socket.destroy());
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const closed = new Promise<void>((resolve, reject) => { socket.once("close", () => resolve()); socket.once("error", reject); });
  releaseAuth.release();
  await assert.rejects(local, error => (error as { code?: unknown }).code === "DESKTOP_SHELL_UPDATE_COORDINATOR_AUTH_KEY_INVALID");
  await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("AUTH_PEER_NOT_CLOSED")), 1000))]);
  assert.equal(socket.destroyed, true);
});
