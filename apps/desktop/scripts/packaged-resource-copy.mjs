import fs from "node:fs/promises";
import path from "node:path";
import { assertTrustedReleaseKeys, readReleaseBundleFiles, verifyReleaseBundlePayload } from "@codeflowai/shared/desktop-release-signing";
import adhocSignMac from "./adhoc-sign-mac.cjs";

/** 打包输出必须完整匹配原资源；验签始终使用输入信任根，不信任输出自报的公钥。 */
export async function completePackagedResources({ source, destination, platform, arch }) {
  const trust = await fs.readFile(path.join(source, "release-trust.json"));
  const trustedKeys = assertTrustedReleaseKeys(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(trust)));
  const proof = path.join(source, "baseline-release-manifest.json");
  let manifest;
  try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(proof))); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const files = await readReleaseBundleFiles(source);
  if (manifest) await verifyReleaseBundlePayload({ directory: source, manifest, trustedKeys, platform, arch, requireHeldStartup: true });
  // builder-util 的 walk 在 filter 前丢弃这两个名字；只补原清单内的缺失实体，其他差异仍须失败。
  await readReleaseBundleFiles(destination);
  for (const file of files) {
    if (![".gitkeep", ".DS_Store"].includes(path.posix.basename(file.path))) continue;
    const target = path.join(destination, file.path);
    try { await fs.lstat(target); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      // 完整目标枚举已拒绝链接；builder 可能连同空目录省略，父目录只从可信相对路径重建。
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(source, file.path), target, fs.constants.COPYFILE_EXCL);
    }
  }
  if (!(await fs.readFile(path.join(destination, "release-trust.json"))).equals(trust)) throw new Error("DESKTOP_PACKAGED_RESOURCE_TRUST_MISMATCH");
  if (manifest && !(await fs.readFile(path.join(destination, "baseline-release-manifest.json"))).equals(await fs.readFile(proof))) {
    throw new Error("DESKTOP_PACKAGED_RESOURCE_MANIFEST_MISMATCH");
  }
  if (manifest) await verifyReleaseBundlePayload({ directory: destination, manifest, trustedKeys, platform, arch, requireHeldStartup: true });
  else if (JSON.stringify(await readReleaseBundleFiles(destination)) !== JSON.stringify(files)) throw new Error("DESKTOP_PACKAGED_RESOURCE_CONTENT_MISMATCH");
}

/** builder 复制完成后校验，必须早于 Windows 目录转换和安装器归档、macOS ad-hoc 签名。 */
export default async function afterPack(context) {
  const trust = context.packager.config.extraResources.find(entry => typeof entry === "object" && entry.to === "release-trust.json");
  if (!trust?.from) throw new Error("DESKTOP_PACKAGED_RESOURCE_SOURCE_MISSING");
  await completePackagedResources({ source: path.dirname(trust.from), destination: context.packager.getResourcesDir(context.appOutDir),
    platform: context.electronPlatformName, arch: context.electronPlatformName === "win32" ? "x64" : process.arch });
  if (context.electronPlatformName === "darwin") await adhocSignMac(context);
}
