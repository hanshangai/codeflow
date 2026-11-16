import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { computeReleaseDirectorySha256, computeReleasePackageSha256, readReleaseBundleFiles, signReleaseBundleManifest, verifyReleaseBundlePayload } from "@codeflowai/shared/desktop-release-signing";
import { runTar } from "./tar.mjs";

/** 从已装配的完整资源生成本地绑定工件；不构建、安装、上传或生成签名密钥。 */
export async function buildReleaseBundle({ resourcesDir, outputDir, metadata, privateKeyFile, requireHeldStartup = false }) {
  const source = path.resolve(resourcesDir);
  const output = path.resolve(outputDir);
  const keyPath = await fs.realpath(path.resolve(privateKeyFile));
  const keyRelative = path.relative(await fs.realpath(source), keyPath);
  if (!keyRelative || (!keyRelative.startsWith(`..${path.sep}`) && keyRelative !== ".." && !path.isAbsolute(keyRelative))) throw new Error("DESKTOP_RELEASE_PRIVATE_KEY_INSIDE_RESOURCES");
  const relative = path.relative(source, output);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("DESKTOP_RELEASE_OUTPUT_INSIDE_RESOURCES");
  try {
    await fs.lstat(output);
    throw new Error("DESKTOP_RELEASE_OUTPUT_EXISTS");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(output), { recursive: true });
  const staging = await fs.mkdtemp(`${output}.build-`);
  try {
    await readReleaseBundleFiles(source);
    for (const root of ["web", "client"]) await fs.cp(path.join(source, root), path.join(staging, root), { recursive: true, errorOnExist: true, force: false });
    const files = await readReleaseBundleFiles(staging);
    const webSha256 = computeReleaseDirectorySha256(files, "web");
    const clientSha256 = computeReleaseDirectorySha256(files, "client");
    const archivePath = path.join(staging, "bundle.tar.gz");
    runTar(["-czf", archivePath, "-C", staging, "web", "client"], { stdio: ["ignore", "pipe", "pipe"] });
    const archive = await fs.readFile(archivePath);
    const privateKey = await fs.readFile(keyPath);
    const manifest = signReleaseBundleManifest({ ...metadata, schemaVersion: 2, webSha256, clientSha256,
      packageSha256: computeReleasePackageSha256(webSha256, clientSha256), files,
      archiveSha256: crypto.createHash("sha256").update(archive).digest("hex"), archiveSize: archive.byteLength,
    }, privateKey);
    if (requireHeldStartup) await verifyReleaseBundlePayload({ directory: staging, manifest,
      trustedKeys: { [manifest.keyId]: crypto.createPublicKey(privateKey) }, platform: manifest.platform, arch: manifest.arch,
      requireHeldStartup: true, requireFresh: true });
    await fs.writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
    /** Windows 索引/杀毒会短暂占用新目录；有界重试，超时后保留原始失败。 */
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(staging, output); break; }
      catch (error) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 14) throw error;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    return { outputDir: output, manifest };
  } catch (error) {
    try { await fs.rm(staging, { recursive: true, force: true }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "DESKTOP_RELEASE_BUILD_CLEANUP_FAILED"); }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [resourcesDir, outputDir, metadataFile, privateKeyFile, ...extra] = process.argv.slice(2);
  if (!resourcesDir || !outputDir || !metadataFile || !privateKeyFile || extra.length) {
    throw new Error("用法：node build-release-bundle.mjs <resources-dir> <output-dir> <metadata.json> <private-key.pem>");
  }
  await buildReleaseBundle({ resourcesDir, outputDir, metadata: JSON.parse(await fs.readFile(metadataFile, "utf8")), privateKeyFile });
}
