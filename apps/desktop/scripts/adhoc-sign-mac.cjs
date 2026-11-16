const { execFileSync } = require("node:child_process");
const path = require("node:path");

/** electron-builder afterPack：无证书时对 .app 做 ad-hoc 签名，降低 Apple Silicon 直接判损坏的概率。 */
module.exports = async function adhocSignMac(context) {
  if (context.electronPlatformName !== "darwin") return;
  const info = context.packager?.appInfo;
  const name = info?.productFilename ?? info?.productName;
  if (!name) throw new Error("DESKTOP_MAC_APP_NAME_MISSING");
  const appPath = path.join(context.appOutDir, name.endsWith(".app") ? name : `${name}.app`);
  const run = (args) => {
    try { execFileSync("/usr/bin/codesign", args, { stdio: "pipe", encoding: "utf8" }); }
    catch (error) {
      const detail = (error.stderr || error.stdout || error.message || "").trim();
      throw new Error(`DESKTOP_MAC_ADHOC_SIGN_FAILED: ${detail}`);
    }
  };
  run(["--force", "--deep", "--sign", "-", "--timestamp=none", appPath]);
  run(["--verify", "--deep", "--strict", "--verbose=2", appPath]);
};
