import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import module, { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import type { ShellReleasePayload } from "@codeflowai/shared";
import { signShellReleaseManifest } from "@codeflowai/shared/desktop-shell-release-signing";
import { verifyShellReleaseArtifact as verifyArtifact, verifyShellInstallerArtifact } from "../src/shellReleaseArtifact.js";

const evidence = await fs.mkdtemp(path.join(os.tmpdir(), "cf-d13-shell-artifact-"));
after(() => { process.stdout.write(`D13 shell artifact evidence: ${evidence}\n`); });
type ArtifactInput = { manifest: unknown; trustedKeys: { "test-key": crypto.KeyObject }; installerPath: string; candidateDirectory: string };

/** 夹具只生成临时 Ed25519 材料与明确标记的合成安装器，不运行任何工件。 */
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(evidence, "fixture-")));
  const candidateDirectory = path.join(root, "candidate"), installerPath = path.join(root, "installer.exe");
  const contents: Record<string, Buffer> = {
    "CodeFlowAI.exe": Buffer.from("synthetic shell executable\n"),
    "locales/zh-CN.pak": Buffer.from("synthetic locale\n"),
    "resources/app.asar": Buffer.from("physical ASAR bytes, never a virtual directory\n".repeat(4096)),
    "resources/release-trust.json": Buffer.from("{\"fixture\":true}\n"),
    "resources/empty.bin": Buffer.alloc(0)
  };
  for (const [relative, bytes] of Object.entries(contents)) {
    const file = path.join(candidateDirectory, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
  }
  const installer = Buffer.from("explicit synthetic installer bytes\n".repeat(4096));
  await fs.writeFile(installerPath, installer);
  const keys = crypto.generateKeyPairSync("ed25519");
  const payload: ShellReleasePayload = {
    schemaVersion: 1, protocol: "codeflow-desktop-shell-v1", shellId: "shell-artifact-1", version: "1.0.0", platform: "win32", arch: "x64",
    installerSha256: crypto.createHash("sha256").update(installer).digest("hex"), installerSize: installer.length,
    files: Object.entries(contents).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([relative, bytes]) => ({ path: relative, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") })),
    createdAt: "2026-10-26T00:00:00.000Z", expiresAt: "2026-10-27T00:00:00.000Z", keyId: "test-key"
  };
  const manifest = signShellReleaseManifest(payload, keys.privateKey);
  const input: ArtifactInput = { manifest, trustedKeys: { "test-key": keys.publicKey }, installerPath, candidateDirectory };
  return { root, contents, installer, payload, manifest, input, keys };
}

/** 失败断言检查可信身份与阶段，避免只匹配消息文本。 */
function rejectsArtifact(input: ArtifactInput, phase: "signature" | "installer" | "candidate", code?: string) {
  return assert.rejects(verifyArtifact(input), (error: any) => {
    assert.equal(error.phase, phase);
    assert.equal(error.shellId, phase === "signature" ? undefined : "shell-artifact-1");
    assert.match(error.code, /^DESKTOP_SHELL_ARTIFACT_/u);
    if (code) assert.equal(error.code, code);
    return true;
  });
}

test("a valid signed installer and complete physical candidate return an independent verified manifest without writes", async () => {
  const f = await fixture(), before = JSON.stringify(f.manifest);
  const result = await verifyArtifact(f.input);
  assert.deepEqual(result, f.manifest);
  assert.notEqual(result, f.manifest);
  assert.equal(JSON.stringify(f.manifest), before);
  assert.deepEqual(await fs.readFile(f.input.installerPath), f.installer);
  for (const [relative, bytes] of Object.entries(f.contents)) assert.deepEqual(await fs.readFile(path.join(f.input.candidateDirectory, relative)), bytes);
});

test("an installed complete shell matching the signed inventory needs no installer download", async () => {
  const f = await fixture(), api = await import("../src/shellReleaseArtifact.js");
  const matches = (api as any).matchesInstalledShellRelease;
  assert.equal(typeof matches, "function");
  await fs.unlink(f.input.installerPath);
  assert.equal(await matches(f.input), true);
  await fs.writeFile(path.join(f.input.candidateDirectory, "resources/app.asar"), "new content");
  assert.equal(await matches(f.input), false);
});

test("installed-shell comparison rejects invalid signatures and propagates I/O failures", async t => {
  const f = await fixture(), api = await import("../src/shellReleaseArtifact.js"), matches = (api as any).matchesInstalledShellRelease;
  assert.equal(typeof matches, "function");
  await assert.rejects(matches({ ...f.input, manifest: { ...f.manifest, signature: "A".repeat(88) } }));
  const read = t.mock.method(fs, "open", async () => { throw Object.assign(new Error("read denied"), { code: "EACCES" }); });
  await assert.rejects(matches(f.input), error => (error as NodeJS.ErrnoException).code === "EACCES");
  read.mock.restore();
});

test("the installer-only verifier shares physical validation without reading candidate inventory", async () => {
  const f = await fixture();
  await fs.rename(f.input.candidateDirectory, path.join(f.root, "unused-candidate"));
  assert.deepEqual(await verifyShellInstallerArtifact(f.input), f.manifest);
  await fs.writeFile(f.input.installerPath, Buffer.alloc(f.installer.length));
  await assert.rejects(verifyShellInstallerArtifact(f.input), (error: any) => {
    assert.equal(error.phase, "installer"); assert.equal(error.code, "DESKTOP_SHELL_ARTIFACT_FILE_MISMATCH"); return true;
  });
});

test("a bad real signature rejects before reading any artifact path or filesystem", async t => {
  const f = await fixture(), signature = Buffer.from(f.manifest.signature, "base64");
  signature[0] = signature[0]! ^ 1;
  let reads = 0;
  for (const operation of ["lstat", "stat", "realpath", "readdir", "open", "readFile"] as const) {
    t.mock.method(fs, operation, async () => { reads += 1; throw new Error("artifact read before signature verification"); });
  }
  const input = { manifest: { ...f.manifest, signature: signature.toString("base64"), shellId: "untrusted-shell-id" }, trustedKeys: f.input.trustedKeys,
    get installerPath(): string { reads += 1; throw new Error("installer path read before signature verification"); },
    get candidateDirectory(): string { reads += 1; throw new Error("candidate path read before signature verification"); } };
  await rejectsArtifact(input, "signature", "DESKTOP_SHELL_ARTIFACT_SIGNATURE_INVALID");
  assert.equal(reads, 0);
});

for (const variant of ["truncated", "tampered", "oversized"] as const) {
  test(`a ${variant} installer explicitly fails before candidate inventory is read`, async t => {
    const f = await fixture();
    const bytes = variant === "truncated" ? f.installer.subarray(0, -1) : variant === "oversized" ? Buffer.concat([f.installer, Buffer.from("x")]) : Buffer.from(f.installer);
    if (variant === "tampered") bytes[0] = bytes[0]! ^ 1;
    await fs.writeFile(f.input.installerPath, bytes);
    let candidateReads = 0;
    const realpath = fs.realpath;
    t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
      if (args[0] === f.input.candidateDirectory) candidateReads += 1;
      return await realpath(...args);
    });
    await rejectsArtifact(f.input, "installer", "DESKTOP_SHELL_ARTIFACT_FILE_MISMATCH");
    assert.equal(candidateReads, 0);
  });
}

for (const variant of ["missing", "extra", "tampered"] as const) {
  test(`a ${variant} candidate file fails complete signed inventory verification`, async () => {
    const f = await fixture(), app = path.join(f.input.candidateDirectory, "resources/app.asar");
    if (variant === "missing") await fs.unlink(app);
    else if (variant === "extra") await fs.writeFile(path.join(f.input.candidateDirectory, "unexpected.txt"), "not signed");
    else {
      const bytes = Buffer.from(f.contents["resources/app.asar"]!); bytes[0] = bytes[0]! ^ 1; await fs.writeFile(app, bytes);
    }
    await rejectsArtifact(f.input, "candidate", variant === "tampered" ? "DESKTOP_SHELL_ARTIFACT_FILE_MISMATCH" : "DESKTOP_SHELL_ARTIFACT_INVENTORY_MISMATCH");
  });
}

test("the caller-selected candidate root may be a directory alias while internal directory links fail", async () => {
  const f = await fixture(), alias = path.join(f.root, "chosen-root");
  await fs.symlink(f.input.candidateDirectory, alias, "junction");
  assert.deepEqual(await verifyArtifact({ ...f.input, candidateDirectory: alias }), f.manifest);
  const resources = path.join(f.input.candidateDirectory, "resources"), retained = path.join(f.root, "retained-resources");
  await fs.rename(resources, retained); await fs.symlink(retained, resources, "junction");
  await rejectsArtifact(f.input, "candidate", "DESKTOP_SHELL_ARTIFACT_PATH_INVALID");
});

test("a candidate hard link and an installer hard link are both rejected as shared physical files", async () => {
  for (const phase of ["candidate", "installer"] as const) {
    const f = await fixture(), target = phase === "installer" ? f.input.installerPath : path.join(f.input.candidateDirectory, "CodeFlowAI.exe");
    await fs.link(target, path.join(f.root, `outside-${phase}`));
    await rejectsArtifact(f.input, phase, "DESKTOP_SHELL_ARTIFACT_PATH_INVALID");
  }
});

test("installer and internal file paths replaced by real junctions fail without following their target", async () => {
  for (const phase of ["installer", "candidate"] as const) {
    const f = await fixture(), target = phase === "installer" ? f.input.installerPath : path.join(f.input.candidateDirectory, "CodeFlowAI.exe");
    const retained = path.join(f.root, `retained-${phase}`), directory = path.join(f.root, `junction-target-${phase}`);
    await fs.rename(target, retained); await fs.mkdir(directory); await fs.symlink(directory, target, "junction");
    await rejectsArtifact(f.input, phase, "DESKTOP_SHELL_ARTIFACT_PATH_INVALID");
  }
});

test("the installer cannot reside inside the candidate tree even with a signed matching inventory", async () => {
  const f = await fixture(), installerPath = path.join(f.input.candidateDirectory, "installer.exe");
  await fs.rename(f.input.installerPath, installerPath);
  const manifest = signShellReleaseManifest({ ...f.payload, files: [...f.payload.files,
    { path: "installer.exe", size: f.installer.length, sha256: f.payload.installerSha256 }].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }, f.keys.privateKey);
  await rejectsArtifact({ ...f.input, installerPath, manifest }, "candidate", "DESKTOP_SHELL_ARTIFACT_PATH_OVERLAP");
});

test("same-handle bounded reads cover installer and physical ASAR bytes including empty candidate files", async t => {
  const f = await fixture(), open = fs.open;
  const reads = new Map<string, number[]>(), opens = new Map<string, number>();
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const target = String(args[0]), file = await open(...args), read = file.read.bind(file);
    assert.equal(Number(args[1]) & fsSync.constants.O_WRONLY, 0);
    assert.equal(Number(args[1]) & fsSync.constants.O_RDWR, 0);
    opens.set(target, (opens.get(target) ?? 0) + 1);
    t.mock.method(file, "readFile", async () => { throw new Error("unbounded readFile is forbidden"); });
    t.mock.method(file, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
      assert.ok(length > 0 && length <= 65_536);
      const positions = reads.get(target) ?? []; positions.push(position); reads.set(target, positions);
      return await read(buffer, offset, Math.min(length, 997), position);
    });
    return file;
  });
  await verifyArtifact(f.input);
  assert.ok(reads.get(f.input.installerPath)!.length > 2);
  assert.ok(reads.get(path.join(f.input.candidateDirectory, "resources/app.asar"))!.length > 2);
  assert.equal(reads.has(path.join(f.input.candidateDirectory, "resources/empty.bin")), false);
  assert.equal(opens.size, Object.keys(f.contents).length + 1);
  for (const count of opens.values()) assert.equal(count, 1);
});

test("a path replaced after opening fails even if replacement bytes match", async t => {
  const f = await fixture(), open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === f.input.installerPath) {
      const read = file.read.bind(file); let replaced = false;
      t.mock.method(file, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position);
        if (!replaced) {
          replaced = true;
          await fs.rename(f.input.installerPath, path.join(f.root, "retained-installer.exe"));
          await fs.writeFile(f.input.installerPath, f.installer);
        }
        return result;
      });
    }
    return file;
  });
  await rejectsArtifact(f.input, "installer", "DESKTOP_SHELL_ARTIFACT_FILE_CHANGED");
});

test("a metadata change during the final bounded read fails despite the original digest", async t => {
  const f = await fixture(), open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === f.input.installerPath) {
      const read = file.read.bind(file);
      t.mock.method(file, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position);
        if (position + result.bytesRead === f.installer.length) await fs.utimes(f.input.installerPath, new Date(), new Date("2030-01-01T00:00:00Z"));
        return result;
      });
    }
    return file;
  });
  await rejectsArtifact(f.input, "installer", "DESKTOP_SHELL_ARTIFACT_FILE_CHANGED");
});

test("a nanosecond-only metadata difference is not rounded into a successful identity match", async t => {
  const f = await fixture(), open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === f.input.installerPath) {
      const stat = file.stat.bind(file); let calls = 0;
      t.mock.method(file, "stat", async (options: any) => {
        const result = await stat(options);
        if (++calls === 2) {
          const mtimeNs = "mtimeNs" in result && typeof result.mtimeNs === "bigint" ? result.mtimeNs : 0n;
          Object.assign(result, { mtimeNs: mtimeNs + 1n });
        }
        return result;
      });
    }
    return file;
  });
  await rejectsArtifact(f.input, "installer", "DESKTOP_SHELL_ARTIFACT_FILE_CHANGED");
});

test("an installer altered while candidate bytes are hashed fails the final installer recheck", async t => {
  const f = await fixture(), open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === path.join(f.input.candidateDirectory, "resources/app.asar")) {
      const read = file.read.bind(file); let changed = false;
      t.mock.method(file, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position);
        if (!changed) {
          changed = true;
          const bytes = Buffer.from(f.installer); bytes[0] = bytes[0]! ^ 1;
          await fs.writeFile(f.input.installerPath, bytes);
        }
        return result;
      });
    }
    return file;
  });
  await rejectsArtifact(f.input, "installer", "DESKTOP_SHELL_ARTIFACT_FILE_CHANGED");
});

test("a previously hashed candidate file changed in place while a later file is read fails the final file recheck", async t => {
  const f = await fixture(), open = fs.open, executable = path.join(f.input.candidateDirectory, "CodeFlowAI.exe");
  const directories = [f.input.candidateDirectory, path.join(f.input.candidateDirectory, "resources")];
  const before = await Promise.all(directories.map(directory => fs.lstat(directory, { bigint: true })));
  let changed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const file = await open(...args);
    if (args[0] === path.join(f.input.candidateDirectory, "resources/release-trust.json")) {
      const read = file.read.bind(file);
      t.mock.method(file, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position);
        if (!changed) {
          changed = true;
          const bytes = Buffer.from(f.contents["CodeFlowAI.exe"]!); bytes[0] = bytes[0]! ^ 1;
          await fs.writeFile(executable, bytes);
        }
        return result;
      });
    }
    return file;
  });
  await rejectsArtifact(f.input, "candidate", "DESKTOP_SHELL_ARTIFACT_FILE_CHANGED");
  assert.equal(changed, true);
  assert.notDeepEqual(await fs.readFile(executable), f.contents["CodeFlowAI.exe"]);
  for (const [index, directory] of directories.entries()) {
    const after = await fs.lstat(directory, { bigint: true }), original = before[index]!;
    assert.deepEqual([after.dev, after.ino, after.mtimeNs, after.ctimeNs], [original.dev, original.ino, original.mtimeNs, original.ctimeNs]);
  }
});

for (const variant of ["extra", "directory-replaced"] as const) {
  test(`final candidate revalidation catches ${variant} after its earlier inventory was hashed`, async t => {
    const f = await fixture(), open = fs.open, trigger = path.join(f.input.candidateDirectory, "resources/release-trust.json");
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (args[0] === trigger) {
        const read = file.read.bind(file); let changed = false;
        t.mock.method(file, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await read(buffer, offset, length, position);
          if (!changed) {
            changed = true;
            if (variant === "extra") await fs.writeFile(path.join(f.input.candidateDirectory, "locales/extra.pak"), "unsigned");
            else {
              const locales = path.join(f.input.candidateDirectory, "locales");
              await fs.rename(locales, path.join(f.root, "retained-locales"));
              await fs.mkdir(locales); await fs.writeFile(path.join(locales, "zh-CN.pak"), f.contents["locales/zh-CN.pak"]!);
            }
          }
          return result;
        });
      }
      return file;
    });
    await rejectsArtifact(f.input, "candidate", variant === "extra" ? "DESKTOP_SHELL_ARTIFACT_DIRECTORY_CHANGED" : "DESKTOP_SHELL_ARTIFACT_FILE_CHANGED");
  });
}

for (const variant of ["read", "close", "both"] as const) {
  test(`a ${variant} I/O failure preserves its original cause and never returns success`, async t => {
    const f = await fixture(), open = fs.open, readFailure = new Error("controlled read failure"), closeFailure = new Error("controlled close failure");
    let closes = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const file = await open(...args);
      if (args[0] === f.input.installerPath) {
        if (variant !== "close") t.mock.method(file, "read", async () => { throw readFailure; });
        const close = file.close.bind(file);
        t.mock.method(file, "close", async () => { closes += 1; await close(); if (variant !== "read") throw closeFailure; });
      }
      return file;
    });
    await assert.rejects(verifyArtifact(f.input), (error: any) => {
      assert.equal(error.phase, "installer"); assert.equal(error.shellId, "shell-artifact-1");
      if (variant === "both") { assert.ok(error.cause instanceof AggregateError); assert.deepEqual(error.cause.errors, [readFailure, closeFailure]); }
      else assert.equal(error.cause, variant === "read" ? readFailure : closeFailure);
      return true;
    });
    assert.equal(closes, 1);
  });
}

test("a directory modified after its final entry read still fails the closing identity check", async t => {
  const f = await fixture(), readdir = fs.readdir, locales = path.join(f.input.candidateDirectory, "locales");
  let reads = 0;
  t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    const entries = await readdir(...args);
    if (args[0] === locales && ++reads === 2) await fs.writeFile(path.join(locales, "late-extra.pak"), "unsigned after listing");
    return entries;
  });
  await rejectsArtifact(f.input, "candidate", "DESKTOP_SHELL_ARTIFACT_DIRECTORY_CHANGED");
});

test("an unavailable installer fails with its native cause and does not inspect the candidate", async t => {
  const f = await fixture(); await fs.unlink(f.input.installerPath);
  let candidateReads = 0;
  const realpath = fs.realpath;
  t.mock.method(fs, "realpath", async (...args: Parameters<typeof fs.realpath>) => {
    if (args[0] === f.input.candidateDirectory) candidateReads += 1;
    return await realpath(...args);
  });
  await assert.rejects(verifyArtifact(f.input), (error: any) => {
    assert.equal(error.phase, "installer"); assert.equal(error.shellId, "shell-artifact-1"); assert.equal(error.cause.code, "ENOENT"); return true;
  });
  assert.equal(candidateReads, 0);
});

test("Electron selects a local original-fs view for every artifact operation without global ASAR mutation", async t => {
  const f = await fixture(), physicalPromises = { ...fs }, physicalView = { ...fsSync, promises: physicalPromises };
  const electron = Object.getOwnPropertyDescriptor(process.versions, "electron"), noAsar = (process as NodeJS.Process & { noAsar?: boolean }).noAsar;
  let originalFsRequests = 0;
  const mocked = t.mock.method(module, "createRequire", () => ((specifier: string) => {
    assert.equal(specifier, "original-fs"); originalFsRequests += 1; return physicalView;
  }) as NodeJS.Require);
  Object.defineProperty(process.versions, "electron", { value: "controlled-local-view", configurable: true });
  syncBuiltinESMExports();
  try {
    for (const operation of ["lstat", "stat", "realpath", "readdir", "open", "readFile"] as const) {
      t.mock.method(fs, operation, async () => { throw new Error(`virtual Node fs used: ${operation}`); });
    }
    assert.deepEqual(await verifyArtifact(f.input), f.manifest);
    assert.equal(originalFsRequests, 1);
    assert.equal((process as NodeJS.Process & { noAsar?: boolean }).noAsar, noAsar);
  } finally {
    mocked.mock.restore(); syncBuiltinESMExports();
    if (electron) Object.defineProperty(process.versions, "electron", electron);
    else assert.equal(Reflect.deleteProperty(process.versions, "electron"), true);
  }
});
