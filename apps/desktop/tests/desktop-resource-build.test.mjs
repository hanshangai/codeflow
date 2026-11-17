import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync as realSpawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import test, { mock } from "node:test";
import { buildReleaseBundle as realBuildReleaseBundle } from "../scripts/build-release-bundle.mjs";

const unsupportedPlatform = !["win32/x64", "darwin/arm64"].includes(`${process.platform}/${process.arch}`);
if (!process.env.CODEFLOWAI_RESOURCE_BUILD_TEST_CHILD) {
  test("desktop resource cache integration", { skip: unsupportedPlatform ? "desktop releases require win32/x64 or darwin/arm64" : false }, () => {
    const env = { ...process.env, CODEFLOWAI_RESOURCE_BUILD_TEST_CHILD: "1" };
    delete env.NODE_TEST_CONTEXT;
    const result = realSpawnSync(process.execPath, ["--experimental-test-module-mocks", "--conditions=development", "--import", "tsx", "--test", import.meta.filename], {
      encoding: "utf8", env, maxBuffer: 1024 * 1024,
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /"cache":"hit"/);
  });
} else {
  test("warm resources reuse web and production dependencies, rebuild client, and prepare once", async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-resource-build-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const files = {
      "package.json": '{"packageManager":"pnpm@10.14.0"}',
      "pnpm-lock.yaml": "lock",
      "apps/web/src/main.ts": "web-source",
      "apps/desktop/package.json": '{"devDependencies":{"electron":"45.0.0"}}',
      "apps/desktop/client/package.json": '{"name":"@codeflowai/client","dependencies":{"dependency":"1"}}',
      "apps/desktop/client/scripts/verify-bundled-native.mjs": "native-probe",
      "apps/desktop/node_modules/electron/package.json": '{"name":"electron","version":"45.0.0"}',
      "apps/desktop/node_modules/npm/package.json": '{"name":"npm","version":"12.2.2"}',
    };
    /** 外部构建进程替身只写对应工件，缓存、复制、签名与验签仍执行真实代码。 */
    const write = async (relative, content) => {
      const target = path.join(root, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    };
    for (const [relative, content] of Object.entries(files)) await write(relative, content);
    const keys = crypto.generateKeyPairSync("ed25519");
    await write("private.pem", keys.privateKey.export({ type: "pkcs8", format: "pem" }));
    await write("trust.json", JSON.stringify({ fixture: keys.publicKey.export({ type: "spki", format: "pem" }) }));
    let webBuilds = 0, clientBuilds = 0, deploys = 0, prepares = 0, tamper = false, archiveMode = false;
    const versions = [];
    mock.module("../../../tools/release/pnpm-command.cjs", { defaultExport: { resolvePnpmCommand: () => ({ command: "fake-pnpm", prefixArgs: [] }) } });
    mock.module("node:child_process", { namedExports: {
      spawnSync: (command, args, options) => {
        if (command === "git") return { status: 0, stdout: Object.keys(files).filter(file => !file.includes("node_modules")).join("\0") + "\0" };
        if (["npm", "npm.cmd"].includes(command)) throw new Error("UNEXPECTED_NPM_INSTALL");
        if (command !== "fake-pnpm") return realSpawnSync(command, args, options);
        if (args[0] === "--version") return { status: 0, stdout: "10.14.0\n" };
        if (args.includes("deploy")) {
          deploys++;
          const destination = args.at(-1);
          const entries = { "node_modules/dependency/index.js": "dependency", "package.json": files["apps/desktop/client/package.json"], "scripts/native.mjs": "native", "bin/codeflow.js": "bin", "dist/stale.cjs": "stale" };
          for (const [relative, content] of Object.entries(entries)) {
            const target = path.join(destination, relative);
            // spawnSync 的文件副作用必须在返回之前完成。
            const result = realSpawnSync(process.execPath, ["--input-type=module", "--eval", "import fs from 'node:fs'; import path from 'node:path'; fs.mkdirSync(path.dirname(process.argv[1]),{recursive:true}); fs.writeFileSync(process.argv[1],process.argv[2]);", target, content]);
            if (result.error) throw result.error;
            assert.equal(result.status, 0, result.stderr?.toString());
          }
        }
        return { status: 0, stdout: "" };
      },
      spawn: (command, args, options) => {
        assert.equal(command, "fake-pnpm");
        const child = new EventEmitter();
        queueMicrotask(async () => {
          try {
            if (args[1] === "apps/web") { webBuilds++; await write("apps/web/dist/index.html", `web-${webBuilds}`); }
            else if (args[1] === "apps/desktop/client") {
              clientBuilds++;
              versions.push(options.env.CODEFLOWAI_CLIENT_BUILD_VERSION);
              await write("apps/desktop/client/dist/index.cjs", options.env.CODEFLOWAI_CLIENT_BUILD_VERSION);
            } else throw new Error(`unexpected build: ${args}`);
            child.emit("close", 0);
          } catch (error) { child.emit("error", error); }
        });
        return child;
      },
    } });
    mock.module("../scripts/prepare-resources.mjs", { namedExports: {
      prepareDesktopResources: async options => {
        prepares++;
        if (archiveMode) {
          assert.equal(options.archive, "explicit-client.tgz");
          assert.equal(options.clientPackageDir, undefined);
        } else {
          assert.ok(options.clientPackageDir);
          assert.equal(options.archive, undefined);
          await assert.rejects(fs.access(path.join(options.clientPackageDir, "dist")), { code: "ENOENT" });
          await fs.access(path.join(options.clientPackageDir, "node_modules/dependency/index.js"));
        }
        await fs.mkdir(path.join(options.outputDir, "client/dist"), { recursive: true });
        await fs.cp(path.join(root, "apps/web/dist"), path.join(options.outputDir, "web"), { recursive: true });
        const client = await fs.readFile(path.join(root, "apps/desktop/client/dist/index.cjs"));
        await fs.writeFile(path.join(options.outputDir, "client/dist/index.cjs"), client);
        await fs.writeFile(path.join(options.outputDir, "client/dist/desktop-startup-capability.json"), JSON.stringify({ schemaVersion: 1, heldStartupProtocol: 1,
          clientEntrySha256: crypto.createHash("sha256").update(client).digest("hex") }));
      },
    } });
    mock.module("../scripts/build-release-bundle.mjs", { namedExports: {
      buildReleaseBundle: async options => {
        const result = await realBuildReleaseBundle(options);
        if (tamper) await fs.writeFile(path.join(options.resourcesDir, "web/index.html"), "tampered");
        return result;
      },
    } });
    const { buildDesktopResources } = await import("../../../tools/release/desktop-resources.mjs");
    const plan = { environment: "test", platformSet: [`${process.platform}/${process.arch}`], clientVersion: "2026.11.17.01", webVersion: "2026.11.17.01", version: "2026.11.17.01",
      releaseId: "fixture", keyId: "fixture", protocolVersion: 1, capabilityVersion: 1, dbSchemaVersion: 1, expiresAt: "2099-01-01T00:00:00.000Z" };
    const common = { root, plan, privateKeyFile: path.join(root, "private.pem"), trustedReleaseKeysFile: path.join(root, "trust.json"), npmPackageDir: root,
      cacheDir: path.join(root, "cache") };
    const first = await buildDesktopResources({ ...common, outputDir: path.join(root, "first") });
    assert.equal(prepares, 1);
    assert.deepEqual(await fs.readFile(path.join(first.resourcesDir, "baseline-release-manifest.json")), await fs.readFile(path.join(first.bundleDir, "manifest.json")));
    const second = await buildDesktopResources({ ...common, npmPackageDir: null, plan: { ...plan, clientVersion: "2026.11.17.02" }, outputDir: path.join(root, "second") });
    assert.equal(prepares, 2);
    assert.equal(webBuilds, 1);
    assert.equal(deploys, 1);
    assert.equal(clientBuilds, 2);
    assert.deepEqual(versions, ["2026.11.17.01", "2026.11.17.02"]);
    assert.equal(await fs.readFile(path.join(second.resourcesDir, "client/dist/index.cjs"), "utf8"), "2026.11.17.02");
    assert.equal(await fs.readFile(path.join(second.resourcesDir, "web/index.html"), "utf8"), "web-1");
    archiveMode = true;
    await buildDesktopResources({ ...common, build: false, clientArchive: "explicit-client.tgz", outputDir: path.join(root, "archive") });
    assert.equal(prepares, 3);
    assert.equal(deploys, 1);
    assert.equal(clientBuilds, 2);
    archiveMode = false;
    tamper = true;
    await assert.rejects(buildDesktopResources({ ...common, outputDir: path.join(root, "tampered") }), /SHA-256|FILES_MISMATCH/);
    await assert.rejects(fs.access(path.join(root, "tampered/resources/baseline-release-manifest.json")), { code: "ENOENT" });
  });
}
