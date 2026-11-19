import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseShellLaunchState, readShellLaunchState, serializeShellLaunchState } from "../src/shellLaunchState.js";
import * as shellLaunchState from "../src/shellLaunchState.js";

const VALID_TEXT = "[shell]\r\nschema=1\r\nactive=shell-new\r\nprevious=shell-old\r\nbaseline=installation\r\n";
const VALID_STATE = { activeShellId: "shell-new", previousShellId: "shell-old", baselineShellId: "installation" };
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cf-d13-shell-state-"));
after(() => { process.stdout.write(`D13 shell state evidence: ${root}\n`); });

/** 创建独占安装布局；保留现场供主线程复核，不启动任何程序。 */
async function fixture(): Promise<string> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(root, "installation-")));
  for (const id of ["shell-new", "shell-old", "installation"]) {
    await fs.mkdir(path.join(directory, "shells", id), { recursive: true });
    await fs.writeFile(path.join(directory, "shells", id, "CodeFlowAI.exe"), "fixture executable", "utf8");
  }
  for (const entry of ["web/index.html", "client/dist/index.cjs", "release-trust.json"]) {
    const file = path.join(directory, "shells", "installation", "resources", entry);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "fixture resource", "utf8");
  }
  await fs.writeFile(path.join(directory, "shell-launch.ini"), VALID_TEXT, "ascii");
  return directory;
}

/** 只接受固定领域错误，避免把未知系统失败误判为预期拒绝。 */
function hasCode(code: string): (error: unknown) => boolean {
  return error => error instanceof Error && error.message === code && "code" in error && error.code === code;
}

type ReplacementInput = { installationDir: string; expectedState: unknown; nextState: unknown; restoreOriginal?: unknown };
const NEXT_STATE = { activeShellId: "shell-old", previousShellId: "shell-new", baselineShellId: "installation" };

/** 缺入口时给出合同 RED；正常调用不添加等待，保留生产入口同步复制边界。 */
function replace(input: ReplacementInput): Promise<Awaited<ReturnType<typeof readShellLaunchState>>> {
  const entry = (shellLaunchState as unknown as Record<string, unknown>).replaceShellLaunchState;
  assert.equal(typeof entry, "function", "replaceShellLaunchState must exist");
  return (entry as (input: ReplacementInput) => Promise<Awaited<ReturnType<typeof readShellLaunchState>>>)(input);
}

/** 检查替换失败的固定外层事实，系统和清理原对象仍从 cause 链核对。 */
function replacementFailure(error: unknown, phase: string, stateReplaced = false): asserts error is Error & {
  phase: string; stateReplaced: boolean; observedState?: typeof VALID_STATE;
} {
  assert.ok(hasCode("DESKTOP_SHELL_LAUNCH_STATE_REPLACE_FAILED")(error));
  assert.equal((error as { phase: unknown }).phase, phase);
  assert.equal((error as { stateReplaced: unknown }).stateReplaced, stateReplaced);
}

/** 只展开错误对象，保留原对象身份，不靠错误正文判断故障类型。 */
function errorObjects(error: unknown): unknown[] {
  return [error, ...(error instanceof AggregateError ? error.errors.flatMap(errorObjects) : []),
    ...(error instanceof Error && error.cause !== undefined ? errorObjects(error.cause) : [])];
}

const RESTORE_ORIGINAL = { originalState: { activeShellId: "shell-old", previousShellId: "shell-older", baselineShellId: "installation" },
  candidateState: VALID_STATE, admission: null };

/** 使用正式 reader 的可选恢复合同，不另造原字节读取。 */
function readRestore(directory: string, restoreOriginal: unknown = RESTORE_ORIGINAL) {
  return readShellLaunchState(directory, { restoreOriginal });
}

/** 移开本夹具候选路径，保留缺件现场；S0所有引用仍完整。 */
async function missingCandidateFixture(mode: "exe" | "directory" = "exe") {
  const directory = await fixture(), candidate = path.join(directory, "shells", "shell-new");
  await fs.mkdir(path.join(directory, "shells", "shell-older"));
  await fs.writeFile(path.join(directory, "shells", "shell-older", "CodeFlowAI.exe"), "retained original previous", "ascii");
  if (mode === "exe") await fs.unlink(path.join(candidate, "CodeFlowAI.exe"));
  else await fs.rename(candidate, candidate + "-retained");
  return directory;
}

for (const mode of ["exe", "directory"] as const) test(`original restoration accepts missing candidate ${mode} but default startup and replacement stay strict`, async () => {
  const directory = await missingCandidateFixture(mode), before = await fs.readFile(path.join(directory, "shell-launch.ini"));
  assert.deepEqual((await readRestore(directory)).state, VALID_STATE);
  assert.deepEqual(await fs.readFile(path.join(directory, "shell-launch.ini")), before);
  await assert.rejects(readShellLaunchState(directory), hasCode("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID"));
  await assert.rejects(shellLaunchState.resolveVersionedShellStartup(path.join(directory, "shells", "shell-old", "CodeFlowAI.exe")), hasCode("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID"));
  await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE, nextState: RESTORE_ORIGINAL.originalState }), error => {
    replacementFailure(error, "read-current"); return true;
  });
  const result = await replace({ installationDir: directory, expectedState: VALID_STATE, nextState: RESTORE_ORIGINAL.originalState, restoreOriginal: RESTORE_ORIGINAL });
  assert.deepEqual(result.state, { activeShellId: "shell-old", previousShellId: "shell-older", baselineShellId: "installation" });
  assert.deepEqual((await readShellLaunchState(directory)).state, result.state);
  assert.deepEqual((await readRestore(directory)).state, result.state);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["shell-launch.ini", "shells"]);
});

test("original restoration copies its scope before await and rejects invalid scope before filesystem access", async t => {
  const directory = await missingCandidateFixture(), scope = structuredClone(RESTORE_ORIGINAL);
  const reading = readRestore(directory, scope); scope.originalState.activeShellId = "changed"; scope.candidateState.previousShellId = "changed";
  assert.deepEqual((await reading).state, VALID_STATE);
  const replacementScope = structuredClone(RESTORE_ORIGINAL);
  const replacing = replace({ installationDir: directory, expectedState: VALID_STATE, nextState: replacementScope.originalState, restoreOriginal: replacementScope });
  replacementScope.originalState.previousShellId = "changed"; replacementScope.candidateState.activeShellId = "changed";
  assert.deepEqual((await replacing).state, RESTORE_ORIGINAL.originalState);
  let accesses = 0, getterReads = 0;
  t.mock.method(fs, "realpath", async () => { accesses++; throw new Error("unexpected filesystem access"); });
  const accessor = { candidateState: VALID_STATE, admission: null, get originalState() { getterReads++; return RESTORE_ORIGINAL.originalState; } };
  for (const invalid of [null, {}, { ...RESTORE_ORIGINAL, admission: {} }, { ...RESTORE_ORIGINAL, extra: true },
    Object.create(RESTORE_ORIGINAL), accessor, { ...RESTORE_ORIGINAL, originalState: { ...RESTORE_ORIGINAL.originalState, baselineShellId: "other" } },
    { ...RESTORE_ORIGINAL, candidateState: { ...VALID_STATE, previousShellId: null } },
    { ...RESTORE_ORIGINAL, candidateState: RESTORE_ORIGINAL.originalState }]) {
    await assert.rejects(readRestore(directory, invalid), hasCode("DESKTOP_SHELL_LAUNCH_STATE_INVALID"));
    await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE, nextState: RESTORE_ORIGINAL.originalState, restoreOriginal: invalid }), error => {
      replacementFailure(error, "input"); return true;
    });
  }
  assert.equal(accesses, 0); assert.equal(getterReads, 0);
});

test("original restoration only replaces the complete scoped S1 with the exact S0", async () => {
  const directory = await fixture(), before = await fs.readFile(path.join(directory, "shell-launch.ini"));
  for (const [expectedState, nextState] of [[VALID_STATE, NEXT_STATE], [NEXT_STATE, RESTORE_ORIGINAL.originalState],
    [RESTORE_ORIGINAL.originalState, VALID_STATE], [VALID_STATE, { ...RESTORE_ORIGINAL.originalState, previousShellId: null }]]) {
    await assert.rejects(replace({ installationDir: directory, expectedState, nextState, restoreOriginal: RESTORE_ORIGINAL }), error => {
      replacementFailure(error, "input"); return true;
    });
  }
  assert.deepEqual(await fs.readFile(path.join(directory, "shell-launch.ini")), before);
});

test("original restoration rejects a third physical state or corrupt INI without replacing it", async () => {
  for (const text of [serializeShellLaunchState({ ...VALID_STATE, previousShellId: "installation" }), "broken\n"]) {
    const directory = await fixture(), statePath = path.join(directory, "shell-launch.ini"); await fs.writeFile(statePath, text, "ascii");
    await assert.rejects(readRestore(directory), hasCode("DESKTOP_SHELL_LAUNCH_STATE_INVALID"));
    await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE, nextState: RESTORE_ORIGINAL.originalState, restoreOriginal: RESTORE_ORIGINAL }));
    assert.equal(await fs.readFile(statePath, "ascii"), text); assert.deepEqual((await fs.readdir(directory)).sort(), ["shell-launch.ini", "shells"]);
  }
});

test("original restoration still requires the executable it will actually run", async () => {
  for (const relative of ["shells/shell-old/CodeFlowAI.exe"]) {
    const directory = await missingCandidateFixture(); await fs.unlink(path.join(directory, relative));
    await assert.rejects(readRestore(directory), hasCode("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID"));
    await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE, nextState: RESTORE_ORIGINAL.originalState, restoreOriginal: RESTORE_ORIGINAL }));
    assert.equal(await fs.readFile(path.join(directory, "shell-launch.ini"), "ascii"), VALID_TEXT);
  }
});

for (const conflict of ["third-state", "missing-original"] as const) test(`original restoration rechecks ${conflict} after preparing its temporary file`, async t => {
  const directory = await missingCandidateFixture(), open = fs.open, statePath = path.join(directory, "shell-launch.ini");
  const third = { ...VALID_STATE, previousShellId: "installation" };
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => { await close();
        if (conflict === "third-state") await fs.writeFile(statePath, serializeShellLaunchState(third), "ascii");
        else await fs.unlink(path.join(directory, "shells", "shell-old", "CodeFlowAI.exe")); });
    }
    return file;
  });
  await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE, nextState: RESTORE_ORIGINAL.originalState, restoreOriginal: RESTORE_ORIGINAL }), error => {
    replacementFailure(error, "check-expected"); return true;
  });
  assert.equal(await fs.readFile(statePath, "ascii"), conflict === "third-state" ? serializeShellLaunchState(third) : VALID_TEXT);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["shell-launch.ini", "shells"]);
});

test("original restoration preserves unknown rename outcome and the original thrown value", async t => {
  const directory = await missingCandidateFixture(), rename = fs.rename; let renames = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { await rename(...args); renames++; throw undefined; });
  await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE, nextState: RESTORE_ORIGINAL.originalState, restoreOriginal: RESTORE_ORIGINAL }), error => {
    replacementFailure(error, "replace"); assert.ok(error.cause instanceof AggregateError); assert.equal(error.cause.errors[0], undefined); return true;
  });
  assert.equal(renames, 1); assert.deepEqual((await readShellLaunchState(directory)).state, RESTORE_ORIGINAL.originalState);
});

for (const closeFails of [false, true]) test(`original restoration retains undefined read cause with close failure ${closeFails}`, async t => {
  const directory = await missingCandidateFixture(), open = fs.open, additional = new Error("restoration reader close failed");
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args), close = file.close.bind(file);
    t.mock.method(file, "read", async () => { throw undefined; });
    if (closeFails) t.mock.method(file, "close", async () => { await close(); throw additional; });
    return file;
  });
  await assert.rejects(readRestore(directory), error => {
    assert.ok(hasCode("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID")(error)); assert.ok(error instanceof Error);
    assert.equal(Object.hasOwn(error, "cause"), true);
    if (closeFails) { assert.ok(error.cause instanceof AggregateError); assert.deepEqual(error.cause.errors, [undefined, additional]); }
    else assert.equal(error.cause, undefined);
    return true;
  });
});

test("replacement commits and restores the complete original state without changing the baseline", async () => {
  const directory = await fixture();
  const result = await replace({ installationDir: directory, expectedState: VALID_STATE, nextState: NEXT_STATE });
  assert.deepEqual(result, { state: NEXT_STATE, executablePath: path.join(directory, "shells/shell-old/CodeFlowAI.exe"),
    initialReleaseDir: path.join(directory, "shells/installation/resources") });
  assert.equal(await fs.readFile(path.join(directory, "shell-launch.ini"), "ascii"), serializeShellLaunchState(NEXT_STATE));
  const restored = await replace({ installationDir: directory, expectedState: NEXT_STATE, nextState: VALID_STATE });
  assert.deepEqual(restored.state, VALID_STATE);
  assert.equal(await fs.readFile(path.join(directory, "shell-launch.ini"), "ascii"), VALID_TEXT);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["shell-launch.ini", "shells"]);
});

test("replacement validates and copies both state inputs before its first asynchronous step", async t => {
  const directory = await fixture(), expected = { ...VALID_STATE }, next = { ...NEXT_STATE };
  const pending = replace({ installationDir: directory, expectedState: expected, nextState: next });
  expected.activeShellId = "changed-after-call"; next.activeShellId = "changed-after-call";
  assert.deepEqual((await pending).state, NEXT_STATE);
  let reads = 0;
  t.mock.method(fs, "realpath", async () => { reads++; throw new Error("unexpected IO"); });
  for (const [expectedState, nextState] of [[{}, NEXT_STATE], [VALID_STATE, {}], [VALID_STATE, VALID_STATE],
    [VALID_STATE, { ...NEXT_STATE, baselineShellId: "different" }]]) {
    await assert.rejects(replace({ installationDir: directory, expectedState, nextState }), error => {
      replacementFailure(error, "input"); return true;
    });
  }
  assert.equal(reads, 0);
});

test("replacement rejects an unexpected current state before creating any temporary file", async t => {
  const directory = await fixture(), open = fs.open; let writes = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[1] !== 0) writes++;
    return await open(...args);
  });
  await assert.rejects(replace({ installationDir: directory, expectedState: NEXT_STATE, nextState: VALID_STATE }), error => {
    replacementFailure(error, "read-current"); assert.deepEqual(error.observedState, VALID_STATE); return true;
  });
  assert.equal(writes, 0); assert.equal(await fs.readFile(path.join(directory, "shell-launch.ini"), "ascii"), VALID_TEXT);
});

test("replacement refuses missing and linked next layouts before writing a temporary file", async () => {
  for (const mode of ["missing", "junction"]) {
    const directory = await fixture(), target = path.join(directory, "shells", "candidate");
    if (mode === "junction") await fs.symlink(path.join(directory, "shells/shell-old"), target, "junction");
    await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE,
      nextState: { ...NEXT_STATE, activeShellId: "candidate" } }), error => {
      replacementFailure(error, "validate-next"); return true;
    });
    assert.deepEqual((await fs.readdir(directory)).sort(), ["shell-launch.ini", "shells"]);
    assert.equal(await fs.readFile(path.join(directory, "shell-launch.ini"), "ascii"), VALID_TEXT);
  }
});

test("replacement completes short writes and syncs and closes the temporary file before rename", async t => {
  const directory = await fixture(), open = fs.open, rename = fs.rename, events: string[] = [];
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const write = file.write.bind(file), sync = file.sync.bind(file), close = file.close.bind(file);
      t.mock.method(file, "write", async (bytes: Buffer, offset: number, length: number, position: number) => {
        events.push("write"); return await write(bytes, offset, Math.min(length, 3), position);
      });
      t.mock.method(file, "sync", async () => { events.push("sync"); await sync(); });
      t.mock.method(file, "close", async () => { events.push("close"); await close(); });
    }
    return file;
  });
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { events.push("rename"); await rename(...args); });
  await replace({ installationDir: directory, expectedState: VALID_STATE, nextState: NEXT_STATE });
  assert.ok(events.filter(value => value === "write").length > 1);
  assert.deepEqual(events.slice(-3), ["sync", "close", "rename"]);
  assert.equal(await fs.readFile(path.join(directory, "shell-launch.ini"), "ascii"), serializeShellLaunchState(NEXT_STATE));
});

for (const phase of ["write-temp", "sync-temp", "close-temp", "replace"] as const) {
  test(`replacement keeps the original INI on ${phase} failure and preserves the native cause`, async t => {
    const directory = await fixture(), open = fs.open;
    const failure = Object.assign(new Error("private-native-error"), { code: "EIO" });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]).endsWith(".tmp")) {
        if (phase === "write-temp") t.mock.method(file, "write", async () => { throw failure; });
        if (phase === "sync-temp") t.mock.method(file, "sync", async () => { throw failure; });
        if (phase === "close-temp") {
          const close = file.close.bind(file);
          t.mock.method(file, "close", async () => { await close(); throw failure; });
        }
      }
      return file;
    });
    if (phase === "replace") t.mock.method(fs, "rename", async () => { throw failure; });
    await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE, nextState: NEXT_STATE }), error => {
      replacementFailure(error, phase); assert.ok(errorObjects(error).includes(failure));
      assert.equal(error.message.includes("private-native-error"), false); return true;
    });
    assert.equal(await fs.readFile(path.join(directory, "shell-launch.ini"), "ascii"), VALID_TEXT);
    assert.equal((await fs.readdir(directory)).filter(name => name.endsWith(".tmp")).length, phase === "close-temp" ? 1 : 0);
  });
}

for (const secondary of ["close", "cleanup"] as const) {
  test(`replacement preserves both the write failure and ${secondary} failure`, async t => {
    const directory = await fixture(), open = fs.open;
    const failure = Object.assign(new Error("write failed"), { code: "ENOSPC" });
    const additional = Object.assign(new Error("secondary failed"), { code: "EBUSY" });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (String(args[0]).endsWith(".tmp")) {
        t.mock.method(file, "write", async () => { throw failure; });
        if (secondary === "close") {
          const close = file.close.bind(file);
          t.mock.method(file, "close", async () => { await close(); throw additional; });
        }
      }
      return file;
    });
    if (secondary === "cleanup") t.mock.method(fs, "unlink", async () => { throw additional; });
    await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE, nextState: NEXT_STATE }), error => {
      replacementFailure(error, "write-temp"); const all = errorObjects(error);
      assert.ok(all.includes(failure)); assert.ok(all.includes(additional)); return true;
    });
    assert.equal(await fs.readFile(path.join(directory, "shell-launch.ini"), "ascii"), VALID_TEXT);
    assert.equal((await fs.readdir(directory)).filter(name => name.endsWith(".tmp")).length, 1);
  });
}

test("replacement refuses zero-progress writes and changed temporary contents", async t => {
  const open = fs.open; let mode = "zero";
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      if (mode === "zero") t.mock.method(file, "write", async () => ({ bytesWritten: 0 }));
      else {
        const sync = file.sync.bind(file);
        t.mock.method(file, "sync", async () => { await sync(); await fs.writeFile(args[0], "unexpected", "ascii"); });
      }
    }
    return file;
  });
  for (mode of ["zero", "changed"]) {
    const directory = await fixture();
    await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE, nextState: NEXT_STATE }), error => {
      replacementFailure(error, mode === "zero" ? "write-temp" : "verify-temp"); return true;
    });
    assert.equal(await fs.readFile(path.join(directory, "shell-launch.ini"), "ascii"), VALID_TEXT);
    assert.deepEqual((await fs.readdir(directory)).sort(), ["shell-launch.ini", "shells"]);
  }
});

test("replacement rechecks expected state after closing the temporary file and preserves a third-party state", async t => {
  const directory = await fixture(), open = fs.open;
  const third = { activeShellId: "installation", previousShellId: "shell-old", baselineShellId: "installation" };
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => { await close(); await fs.writeFile(path.join(directory, "shell-launch.ini"), serializeShellLaunchState(third), "ascii"); });
    }
    return file;
  });
  await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE, nextState: NEXT_STATE }), error => {
    replacementFailure(error, "check-expected"); assert.deepEqual(error.observedState, third); return true;
  });
  assert.deepEqual((await readShellLaunchState(directory)).state, third);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["shell-launch.ini", "shells"]);
});

test("replacement never deletes a substituted temporary file or a hard-linked temporary inode", async t => {
  const open = fs.open; let mode = "substituted", temporary = "";
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      temporary = String(args[0]);
      if (mode === "hardlink") await fs.link(temporary, temporary + ".retained");
      else {
        const close = file.close.bind(file);
        t.mock.method(file, "close", async () => {
          await close(); await fs.rename(temporary, temporary + ".retained"); await fs.writeFile(temporary, "foreign temporary file", "ascii");
        });
      }
    }
    return file;
  });
  for (mode of ["substituted", "hardlink"]) {
    const directory = await fixture();
    await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE, nextState: NEXT_STATE }), error => {
      assert.ok(hasCode("DESKTOP_SHELL_LAUNCH_STATE_REPLACE_FAILED")(error));
      assert.equal((error as { stateReplaced: unknown }).stateReplaced, false); return true;
    });
    assert.equal(await fs.readFile(path.join(directory, "shell-launch.ini"), "ascii"), VALID_TEXT);
    assert.equal(mode === "substituted" ? await fs.readFile(temporary, "ascii") : (await fs.stat(temporary)).nlink,
      mode === "substituted" ? "foreign temporary file" : 2);
  }
});

test("replacement reports a committed read failure and does not delete a newly recreated temporary name", async t => {
  const directory = await fixture(), open = fs.open, rename = fs.rename;
  const failure = Object.assign(new Error("read after rename"), { code: "EIO" });
  let committed = false, temporary = "", renames = 0;
  t.mock.method(fs, "rename", async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    await rename(from, to); committed = true; temporary = String(from); renames++;
    await fs.writeFile(temporary, "new foreign file", "ascii");
  });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (committed && args[0] === path.join(directory, "shell-launch.ini")) throw failure;
    return await open(...args);
  });
  await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE, nextState: NEXT_STATE }), error => {
    replacementFailure(error, "verify-replaced", true); assert.ok(errorObjects(error).includes(failure));
    assert.equal(Object.hasOwn(error, "observedState"), false); return true;
  });
  assert.equal(await fs.readFile(path.join(directory, "shell-launch.ini"), "ascii"), serializeShellLaunchState(NEXT_STATE));
  assert.equal(await fs.readFile(temporary, "ascii"), "new foreign file"); assert.equal(renames, 1);
});

test("replacement reports the observed third-party state after rename without overwriting it", async t => {
  const directory = await fixture(), rename = fs.rename;
  const third = { activeShellId: "installation", previousShellId: null, baselineShellId: "installation" };
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args); await fs.writeFile(path.join(directory, "shell-launch.ini"), serializeShellLaunchState(third), "ascii");
  });
  await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE, nextState: NEXT_STATE }), error => {
    replacementFailure(error, "verify-replaced", true); assert.deepEqual(error.observedState, third); return true;
  });
  assert.deepEqual((await readShellLaunchState(directory)).state, third);
});

test("replacement cannot erase an existing temporary name when exclusive creation fails", async t => {
  const directory = await fixture(), open = fs.open;
  const failure = Object.assign(new Error("exclusive file exists"), { code: "EEXIST" }); let temporary = "";
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(".tmp")) { temporary = String(args[0]); await fs.writeFile(temporary, "foreign", "ascii"); throw failure; }
    return await open(...args);
  });
  await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE, nextState: NEXT_STATE }), error => {
    replacementFailure(error, "create-temp"); assert.ok(errorObjects(error).includes(failure)); return true;
  });
  assert.equal(await fs.readFile(temporary, "ascii"), "foreign");
  assert.equal(await fs.readFile(path.join(directory, "shell-launch.ini"), "ascii"), VALID_TEXT);
});

test("replacement refuses a next layout removed after preparation and cleans only its own file", async t => {
  const directory = await fixture(), open = fs.open;
  const target = path.join(directory, "shells/candidate");
  await fs.mkdir(target); await fs.writeFile(path.join(target, "CodeFlowAI.exe"), "candidate", "ascii");
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => { await close(); await fs.rename(target, target + "-retained"); });
    }
    return file;
  });
  await assert.rejects(replace({ installationDir: directory, expectedState: VALID_STATE,
    nextState: { ...NEXT_STATE, activeShellId: "candidate" } }), error => { replacementFailure(error, "check-expected"); return true; });
  assert.equal(await fs.readFile(path.join(directory, "shell-launch.ini"), "ascii"), VALID_TEXT);
  assert.deepEqual((await fs.readdir(directory)).sort(), ["shell-launch.ini", "shells"]);
});

test("replacement accepts a chosen root alias but refuses a changed installation-root identity", async t => {
  const directory = await fixture(), alias = path.join(root, "replacement-root-alias");
  await fs.symlink(directory, alias, "junction");
  assert.deepEqual((await replace({ installationDir: alias, expectedState: VALID_STATE, nextState: NEXT_STATE })).state, NEXT_STATE);
  const changed = await fixture(), open = fs.open, retained = changed + "-retained";
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => {
        await close(); await fs.rename(changed, retained); await fs.mkdir(changed);
        await fs.writeFile(path.join(changed, path.basename(String(args[0]))), "foreign root file", "ascii");
      });
    }
    return file;
  });
  await assert.rejects(replace({ installationDir: changed, expectedState: VALID_STATE, nextState: NEXT_STATE }), error => {
    assert.ok(hasCode("DESKTOP_SHELL_LAUNCH_STATE_REPLACE_FAILED")(error));
    assert.equal((error as { stateReplaced: unknown }).stateReplaced, false); return true;
  });
  assert.equal(await fs.readFile(path.join(retained, "shell-launch.ini"), "ascii"), VALID_TEXT);
  const [foreign] = await fs.readdir(changed); assert.equal(await fs.readFile(path.join(changed, foreign!), "ascii"), "foreign root file");
});

test("canonical bytes preserve all three shell selections without BOM or normalization", () => {
  assert.equal(serializeShellLaunchState(VALID_STATE), VALID_TEXT);
  const bytes = Buffer.from(VALID_TEXT, "ascii");
  const before = Buffer.from(bytes);
  assert.deepEqual(parseShellLaunchState(bytes), VALID_STATE);
  assert.deepEqual(bytes, before);
  assert.equal(serializeShellLaunchState({ activeShellId: "same", previousShellId: null, baselineShellId: "same" }),
    "[shell]\r\nschema=1\r\nactive=same\r\nprevious=\r\nbaseline=same\r\n");
  assert.deepEqual(parseShellLaunchState(Buffer.from("[shell]\r\nschema=1\r\nactive=same\r\nprevious=\r\nbaseline=same\r\n", "ascii")),
    { activeShellId: "same", previousShellId: null, baselineShellId: "same" });
});

test("oversized parser input is rejected before scanning its bytes", (t) => {
  const bytes = Buffer.alloc(1024 * 1024, "a");
  let scanned = false;
  t.mock.method(bytes, "some", () => { scanned = true; throw new Error("oversized bytes were scanned"); });
  assert.throws(() => parseShellLaunchState(bytes), hasCode("DESKTOP_SHELL_LAUNCH_STATE_INVALID"));
  assert.equal(scanned, false);
});

test("state reads stay bounded for real oversized files and files grown after stat", async (t) => {
  const open = fs.open;
  let statePath = "";
  let growAfterStat = false;
  let bytesRead = 0;
  let readFileCalls = 0;
  const observations: Array<{ bytesRead: number; readFileCalls: number }> = [];
  t.mock.method(fs, "open", async (file: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1]) => {
    const handle = await open(file, flags);
    if (file === statePath) {
      const stat = handle.stat.bind(handle);
      t.mock.method(handle, "stat", async () => {
        const original = await stat();
        if (growAfterStat) { await fs.appendFile(statePath, Buffer.alloc(1024 * 1024, "a")); growAfterStat = false; }
        return original;
      });
      const readFile = handle.readFile.bind(handle);
      t.mock.method(handle, "readFile", async () => {
        const result = await readFile();
        readFileCalls++;
        bytesRead += result.byteLength;
        return result;
      });
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position);
        bytesRead += result.bytesRead;
        return result;
      });
    }
    return handle;
  });
  for (const scenario of ["oversized", "grew-after-stat"]) {
    const directory = await fixture();
    statePath = path.join(directory, "shell-launch.ini");
    bytesRead = 0;
    readFileCalls = 0;
    growAfterStat = scenario === "grew-after-stat";
    if (!growAfterStat) await fs.writeFile(statePath, Buffer.alloc(1024 * 1024, "a"));
    await assert.rejects(readShellLaunchState(directory), hasCode("DESKTOP_SHELL_LAUNCH_STATE_INVALID"));
    await fs.writeFile(path.join(root, `${scenario}-read.json`), `${JSON.stringify({ bytesRead, readFileCalls, fileSize: (await fs.stat(statePath)).size })}\n`, "utf8");
    observations.push({ bytesRead, readFileCalls });
  }
  for (const observation of observations) {
    assert.ok(observation.bytesRead <= 435, `read ${observation.bytesRead} bytes instead of at most 435`);
    assert.equal(observation.readFileCalls, 0);
  }
});

test("the maximum 434-byte state remains readable without truncation", async () => {
  const directory = await fixture();
  const id = "a".repeat(128);
  await fs.rename(path.join(directory, "shells", "installation"), path.join(directory, "shells", id));
  const text = `[shell]\r\nschema=1\r\nactive=${id}\r\nprevious=${id}\r\nbaseline=${id}\r\n`;
  assert.equal(Buffer.byteLength(text, "ascii"), 434);
  await fs.writeFile(path.join(directory, "shell-launch.ini"), text, "ascii");
  assert.deepEqual((await readShellLaunchState(directory)).state, { activeShellId: id, previousShellId: id, baselineShellId: id });
  assert.equal(await fs.readFile(path.join(directory, "shell-launch.ini"), "ascii"), text);
});

test("short reads continue to EOF within the fixed allocation", async (t) => {
  const directory = await fixture();
  const statePath = path.join(directory, "shell-launch.ini");
  const open = fs.open;
  let reads = 0;
  t.mock.method(fs, "open", async (file: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1]) => {
    const handle = await open(file, flags);
    if (file === statePath) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
        assert.equal(buffer.byteLength, 435);
        reads++;
        return await read(buffer, offset, Math.min(length, 7), position);
      });
    }
    return handle;
  });
  assert.deepEqual((await readShellLaunchState(directory)).state, VALID_STATE);
  assert.ok(reads > 2);
});

test("rejects noncanonical encoding, line endings, sections, duplicate or extra fields", () => {
  const invalid = [Buffer.from([0xff, 0xfe]), Buffer.from([0xc3, 0x28]), Buffer.from(`\ufeff${VALID_TEXT}`, "utf8"),
    Buffer.from(VALID_TEXT.replace("shell-new", "新版"), "utf8"), Buffer.from(`${VALID_TEXT}\0`, "ascii"),
    ...[VALID_TEXT.replaceAll("\r\n", "\n"), VALID_TEXT.replaceAll("\r\n", "\r"), VALID_TEXT.trimEnd(), `${VALID_TEXT}\r\n`,
      `${VALID_TEXT}\n`, VALID_TEXT.replace("[shell]", "[Shell]"), VALID_TEXT.replace("schema=1", "schema=2"),
      VALID_TEXT.replace("active=", "active ="), VALID_TEXT.replace("active=shell-new", "active=shell-new "),
      VALID_TEXT.replace("previous=shell-old\r\n", ""), VALID_TEXT.replace("baseline=installation", "active=installation"),
      `${VALID_TEXT}other=ignored\r\n`, VALID_TEXT.replace("schema=1\r\n", "schema=1\r\nschema=1\r\n")].map(text => Buffer.from(text, "ascii"))];
  for (const bytes of invalid) {
    assert.throws(() => parseShellLaunchState(bytes), hasCode("DESKTOP_SHELL_LAUNCH_STATE_INVALID"));
  }
});

test("all shell IDs reject traversal, reserved names, aliases and overlong launcher strings", () => {
  for (const value of ["", ".", "..", "../outside", "a/b", "a\\b", "C:drive", "a:b", "with space", "ending.", "ending ",
    "con", "CON.exe", "nul", "aux", "prn.any", "com1", "lpt9.bin", "a\0b", "中文", "a".repeat(129)]) {
    for (const field of ["activeShellId", "previousShellId", "baselineShellId"]) {
      const input = { ...VALID_STATE, [field]: value };
      assert.throws(() => serializeShellLaunchState(input), hasCode("DESKTOP_SHELL_LAUNCH_STATE_INVALID"));
      if (value !== "" || field !== "previousShellId") {
        const key = field === "activeShellId" ? "active" : field === "previousShellId" ? "previous" : "baseline";
        const text = VALID_TEXT.replace(new RegExp(`${key}=[^\\r]*`), `${key}=${value}`);
        assert.throws(() => parseShellLaunchState(Buffer.from(text, "utf8")), hasCode("DESKTOP_SHELL_LAUNCH_STATE_INVALID"));
      }
    }
  }
  for (const id of ["a".repeat(128), "v1.2_3-4", "com10", "null"]) {
    const state = { activeShellId: id, previousShellId: id, baselineShellId: id };
    assert.deepEqual(parseShellLaunchState(Buffer.from(serializeShellLaunchState(state), "ascii")), state);
  }
});

test("serialization refuses incomplete, unknown or accessor fields without evaluating getters", () => {
  for (const value of [null, [], "state", {}, { ...VALID_STATE, previousShellId: undefined }, { ...VALID_STATE, activeShellId: 1 },
    { ...VALID_STATE, extra: "ignored" }, { ...VALID_STATE, [Symbol("extra")]: "ignored" }, Object.create(VALID_STATE)]) {
    assert.throws(() => serializeShellLaunchState(value), hasCode("DESKTOP_SHELL_LAUNCH_STATE_INVALID"));
  }
  const accessor = { ...VALID_STATE };
  Object.defineProperty(accessor, "activeShellId", { get() { throw new Error("getter must not run"); } });
  assert.throws(() => serializeShellLaunchState(accessor), hasCode("DESKTOP_SHELL_LAUNCH_STATE_INVALID"));
});

test("reads real active executable and retained installation resources without changing state bytes", async () => {
  const directory = await fixture();
  const file = path.join(directory, "shell-launch.ini");
  const before = await fs.readFile(file);
  assert.deepEqual(await readShellLaunchState(directory), {
    state: VALID_STATE,
    executablePath: path.join(directory, "shells", "shell-new", "CodeFlowAI.exe"),
    initialReleaseDir: path.join(directory, "shells", "installation", "resources"),
  });
  assert.deepEqual(await fs.readFile(file), before);
});

test("resolves a user-selected root junction while refusing links inside that real root", async () => {
  const directory = await fixture();
  const alias = path.join(root, `selected-${path.basename(directory)}`);
  await fs.symlink(directory, alias, "junction");
  const result = await readShellLaunchState(alias);
  assert.equal(result.executablePath, path.join(directory, "shells", "shell-new", "CodeFlowAI.exe"));
  assert.equal(result.initialReleaseDir, path.join(directory, "shells", "installation", "resources"));
});

test("active may equal baseline and an empty previous field needs no old-shell directory", async () => {
  const directory = await fixture();
  await fs.writeFile(path.join(directory, "shell-launch.ini"), "[shell]\r\nschema=1\r\nactive=installation\r\nprevious=\r\nbaseline=installation\r\n", "ascii");
  const result = await readShellLaunchState(directory);
  assert.deepEqual(result.state, { activeShellId: "installation", previousShellId: null, baselineShellId: "installation" });
  assert.equal(result.executablePath, path.join(directory, "shells", "installation", "CodeFlowAI.exe"));
});

test("the state and selected shell fail explicitly when absent", async () => {
  for (const relative of ["shell-launch.ini", "shells", "shells/shell-new", "shells/shell-new/CodeFlowAI.exe"]) {
    const directory = await fixture();
    await fs.rename(path.join(directory, relative), path.join(directory, "removed"));
    await assert.rejects(readShellLaunchState(directory), hasCode("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID"));
  }
});

test("file and directory type mismatches never count as installed entries", async () => {
  for (const relative of ["shell-launch.ini", "shells", "shells/shell-new", "shells/shell-new/CodeFlowAI.exe"]) {
    const directory = await fixture();
    const target = path.join(directory, relative);
    const directoryEntry = (await fs.lstat(target)).isDirectory();
    await fs.rename(target, path.join(directory, "removed"));
    if (directoryEntry) await fs.writeFile(target, "wrong type", "utf8");
    else await fs.mkdir(target);
    await assert.rejects(readShellLaunchState(directory), hasCode("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID"));
  }
});

test("rejects junctions at every internal directory component", async () => {
  for (const relative of ["shells", "shells/shell-new"]) {
    const directory = await fixture();
    const target = path.join(directory, relative);
    const retained = path.join(directory, "retained");
    await fs.rename(target, retained);
    await fs.symlink(retained, target, "junction");
    await assert.rejects(readShellLaunchState(directory), hasCode("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID"));
  }
});

test("rejects file symlink metadata for every required ordinary file", async (t) => {
  const lstat = fs.lstat;
  let linkedTarget = "";
  t.mock.method(fs, "lstat", async (file: Parameters<typeof fs.lstat>[0]) => {
    const stat = await lstat(file);
    if (file === linkedTarget) stat.isSymbolicLink = () => true;
    return stat;
  });
  for (const relative of ["shell-launch.ini", "shells/shell-new/CodeFlowAI.exe"]) {
    const directory = await fixture();
    linkedTarget = path.join(directory, relative);
    await assert.rejects(readShellLaunchState(directory), hasCode("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID"));
  }
});

test("missing historical shells and business baseline cannot block the selected shell recovery UI", async () => {
  const directory = await fixture();
  await fs.rename(path.join(directory, "shells", "installation"), path.join(directory, "retained-baseline"));
  await fs.rename(path.join(directory, "shells", "shell-old"), path.join(directory, "retained-previous"));
  const result = await readShellLaunchState(directory);
  assert.equal(result.executablePath, path.join(directory, "shells", "shell-new", "CodeFlowAI.exe"));
});

test("read errors retain the system cause and never print malformed INI content", async () => {
  const directory = await fixture();
  const missing = path.join(directory, "missing-root");
  await assert.rejects(readShellLaunchState(missing), error => {
    assert.ok(hasCode("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID")(error));
    assert.ok(error instanceof Error && error.cause instanceof Error && "code" in error.cause && error.cause.code === "ENOENT");
    return true;
  });
  const secret = "private-fragment-do-not-print";
  await fs.writeFile(path.join(directory, "shell-launch.ini"), `${VALID_TEXT}${secret}`, "utf8");
  await assert.rejects(readShellLaunchState(directory), error => {
    assert.ok(hasCode("DESKTOP_SHELL_LAUNCH_STATE_INVALID")(error));
    for (let current: unknown = error; current instanceof Error; current = current.cause) assert.equal(current.message.includes(secret), false);
    return true;
  });
});

test("a state file replaced between path validation and open is explicitly rejected", async (t) => {
  const directory = await fixture();
  const statePath = path.join(directory, "shell-launch.ini");
  const open = fs.open;
  t.mock.method(fs, "open", async (file: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1]) => {
    if (file === statePath) {
      await fs.rename(statePath, path.join(directory, "original-state.ini"));
      await fs.writeFile(statePath, VALID_TEXT, "ascii");
    }
    return await open(file, flags);
  });
  await assert.rejects(readShellLaunchState(directory), hasCode("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID"));
  assert.equal(await fs.readFile(statePath, "ascii"), VALID_TEXT);
});

test("state read and close failures retain both original causes", async (t) => {
  const directory = await fixture();
  const statePath = path.join(directory, "shell-launch.ini");
  const open = fs.open;
  const readFailure = Object.assign(new Error("read failure"), { code: "EIO" });
  const closeFailure = Object.assign(new Error("close failure"), { code: "EBADF" });
  t.mock.method(fs, "open", async (file: Parameters<typeof fs.open>[0], flags: Parameters<typeof fs.open>[1]) => {
    const handle = await open(file, flags);
    if (file === statePath) {
      t.mock.method(handle, "read", async () => { throw readFailure; });
      const close = handle.close.bind(handle);
      t.mock.method(handle, "close", async () => { await close(); throw closeFailure; });
    }
    return handle;
  });
  await assert.rejects(readShellLaunchState(directory), error => {
    assert.ok(hasCode("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID")(error));
    assert.ok(error instanceof Error && error.cause instanceof AggregateError);
    assert.deepEqual(error.cause.errors, [readFailure, closeFailure]);
    return true;
  });
});

test("versioned startup retains the original baseline and leaves the launch state untouched", async () => {
  const directory = await fixture();
  const statePath = path.join(directory, "shell-launch.ini");
  const before = await fs.readFile(statePath);
  assert.equal(typeof shellLaunchState.resolveVersionedShellStartup, "function");
  const result = await shellLaunchState.resolveVersionedShellStartup(path.join(directory, "shells", "shell-new", "CodeFlowAI.exe"));
  assert.deepEqual(result, { state: VALID_STATE,
    executablePath: path.join(directory, "shells", "shell-new", "CodeFlowAI.exe"),
    initialReleaseDir: path.join(directory, "shells", "installation", "resources") });
  assert.deepEqual(await fs.readFile(statePath), before);
});

test("legacy and development executable layouts do not read a shell state", async () => {
  const directory = await fixture();
  await fs.writeFile(path.join(directory, "shell-launch.ini"), "broken state", "ascii");
  assert.equal(typeof shellLaunchState.resolveVersionedShellStartup, "function");
  for (const executable of [path.join(directory, "CodeFlowAI.exe"), path.join(directory, "electron.exe"),
    path.join(directory, "shells", "shell-new", "electron.exe"), path.join(directory, "other", "shell-new", "CodeFlowAI.exe")]) {
    assert.equal(await shellLaunchState.resolveVersionedShellStartup(executable), null);
  }
});

test("versioned startup refuses missing or corrupt state instead of using candidate resources", async () => {
  assert.equal(typeof shellLaunchState.resolveVersionedShellStartup, "function");
  for (const mode of ["missing", "corrupt"] as const) {
    const directory = await fixture();
    const statePath = path.join(directory, "shell-launch.ini");
    if (mode === "missing") await fs.unlink(statePath);
    else await fs.writeFile(statePath, "private-fragment-do-not-print", "ascii");
    await assert.rejects(shellLaunchState.resolveVersionedShellStartup(path.join(directory, "shells", "shell-new", "CodeFlowAI.exe")),
      hasCode(mode === "missing" ? "DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID" : "DESKTOP_SHELL_LAUNCH_STATE_INVALID"));
  }
});

test("versioned startup refuses a previous, baseline or unselected shell even if its executable exists", async () => {
  const directory = await fixture();
  await fs.mkdir(path.join(directory, "shells", "unselected"));
  await fs.writeFile(path.join(directory, "shells", "unselected", "CodeFlowAI.exe"), "fixture executable", "utf8");
  assert.equal(typeof shellLaunchState.resolveVersionedShellStartup, "function");
  for (const id of ["shell-old", "installation", "unselected"]) {
    await assert.rejects(shellLaunchState.resolveVersionedShellStartup(path.join(directory, "shells", id, "CodeFlowAI.exe")),
      hasCode("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID"));
  }
});

test("versioned startup validates the current shell ID before touching the filesystem", async () => {
  const directory = await fixture();
  assert.equal(typeof shellLaunchState.resolveVersionedShellStartup, "function");
  for (const id of ["CON", "bad name", "ending.", "a".repeat(129)]) {
    await assert.rejects(shellLaunchState.resolveVersionedShellStartup(`${directory}${path.sep}shells${path.sep}${id}${path.sep}CodeFlowAI.exe`),
      hasCode("DESKTOP_SHELL_LAUNCH_STATE_INVALID"));
  }
  await assert.rejects(shellLaunchState.resolveVersionedShellStartup(`${directory}${path.sep}shells${path.sep}..${path.sep}CodeFlowAI.exe`),
    hasCode("DESKTOP_SHELL_LAUNCH_STATE_INVALID"));
});

test("versioned startup accepts a root junction without washing internal directory links", async () => {
  const directory = await fixture();
  const alias = path.join(root, `startup-${path.basename(directory)}`);
  await fs.symlink(directory, alias, "junction");
  assert.equal(typeof shellLaunchState.resolveVersionedShellStartup, "function");
  const result = await shellLaunchState.resolveVersionedShellStartup(path.join(alias, "shells", "shell-new", "CodeFlowAI.exe"));
  assert.equal(result?.initialReleaseDir, path.join(directory, "shells", "installation", "resources"));
  for (const relative of ["shells", "shells/shell-new"]) {
    const linkedRoot = await fixture();
    const target = path.join(linkedRoot, relative), retained = path.join(linkedRoot, "retained");
    await fs.rename(target, retained);
    await fs.symlink(retained, target, "junction");
    await assert.rejects(shellLaunchState.resolveVersionedShellStartup(path.join(linkedRoot, "shells", "shell-new", "CodeFlowAI.exe")),
      hasCode("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID"));
  }
  const unselected = path.join(directory, "shells", "unselected");
  await fs.symlink(path.join(directory, "shells", "shell-new"), unselected, "junction");
  await assert.rejects(shellLaunchState.resolveVersionedShellStartup(path.join(unselected, "CodeFlowAI.exe")),
    hasCode("DESKTOP_SHELL_LAUNCH_LAYOUT_INVALID"));
});
