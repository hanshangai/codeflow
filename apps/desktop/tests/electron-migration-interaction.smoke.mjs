import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 查询原生命中区域，不移动用户鼠标；标题栏命中会吞掉 DOM 点击。 */
async function nativeHitTest(handle, x, y) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MigrationHitTest {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, UIntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
$sent = [MigrationHitTest]::SendMessageTimeout([IntPtr]::new(${handle}), 0x84, [UIntPtr]::Zero, [IntPtr]::new(${(y << 16) | (x & 65535)}), 2, 3000, [ref]$result)
if ($sent -eq [IntPtr]::Zero) { throw 'MIGRATION_NATIVE_HIT_TEST_FAILED' }
$result.ToUInt64()
`;
  const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 10_000 });
  return Number(result.stdout.trim());
}

/** 挂载真实迁移或入口错误页，仅替换宿主与外部加载边界，保护用户数据。 */
async function run(startupError = false) {
  assert.equal(process.platform, "win32", "MIGRATION_NATIVE_TEST_REQUIRES_WINDOWS");
  const desktopDir = fileURLToPath(new URL("..", import.meta.url));
  const webDir = fileURLToPath(new URL("../../web", import.meta.url));
  const desktop = createRequire(path.join(desktopDir, "package.json")), web = createRequire(path.join(webDir, "package.json"));
  const { createServer } = await import(pathToFileURL(web.resolve("vite")).href);
  const { default: vue } = await import(pathToFileURL(web.resolve("@vitejs/plugin-vue")).href);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeflow-migration-interaction-"));
  const fixtureId = path.join(webDir, "__migration_interaction_fixture__.ts").replaceAll("\\", "/");
  const fixture = `
import { createApp, h, provide, ref } from 'vue';
import Migration from '${startupError ? "./src/App.vue" : "./src/features/desktop/components/desktop-migration-startup.vue"}';
window.migrationActions = [];
window.codeflowDesktop = {
  request: async () => { throw new Error('UNEXPECTED_RUNTIME_REQUEST'); },
  getState: async () => { throw new Error('UNEXPECTED_RUNTIME_STATE'); },
  getMigrationState: async () => ({ status:'available', candidateId:'source-1', migrationId:null,
    workspaceCount:3, stage:'discover', completed:0, total:null, errorCode:null, message:null,
    account:{status:'not_requested',errorCode:null,message:null} }),
  onMigrationState: () => () => {},
  startMigration: async id => { window.migrationActions.push(['start',id]); },
  deferMigration: async () => { window.migrationActions.push(['defer']); },
};
createApp({setup(){provide('codeflow:desktop-workbench-ready',ref(false));return ()=>h(Migration);}}).mount('#app');
`;
  const server = await createServer({
    configFile: false, root: webDir, cacheDir: path.join(root, "vite-cache"),
    resolve: { alias: { "@": path.join(webDir, "src") } },
    optimizeDeps: { entries: [], include: ["vue", "ant-design-vue"] },
    plugins: [vue(), {
      name: "migration-interaction-fixture",
      enforce: "pre",
      /** 虚拟入口不落入源码；本用例不启动账号恢复依赖。 */
      resolveId(id, importer) {
        if (id === "/__migration_interaction_fixture__.ts") return fixtureId;
        if (startupError && id.endsWith("/desktop-migration-startup.vue") && importer?.endsWith("App.vue")) return "\0startup-error";
        if (id.endsWith("store/config") && importer?.includes("desktop-migration-startup.vue")) return "\0migration-unused-config";
      },
      /** 错误场景注入明确的模块失败；意外进入账号恢复同样立即失败。 */
      load(id) {
        if (id === fixtureId) return fixture;
        if (id === "\0startup-error") return "throw new Error('MIGRATION_CHUNK_FAILED');export default {};";
        if (id === "\0migration-unused-config") return "export function useConfigStore(){throw Error('UNEXPECTED_ACCOUNT_RECOVERY')}";
      },
      /** 仅提供隔离测试页，其余请求交由 Vite 转换真实源码。 */
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url !== "/") { next(); return; }
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end('<!doctype html><style>body{margin:0}</style><div id="app"></div><script>window.fixtureErrors=[];window.addEventListener("error",e=>window.fixtureErrors.push(e.message));window.addEventListener("unhandledrejection",e=>window.fixtureErrors.push(String(e.reason)));</script><script type="module" src="/__migration_interaction_fixture__.ts"></script>');
        });
      },
    }],
    server: { host: "127.0.0.1", port: 0, open: false },
  });
  try {
    await server.listen(0);
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const loader = await desktop("esbuild").transform(await fs.readFile(path.join(desktopDir, "src/webLoader.ts"), "utf8"), { loader: "ts", format: "esm" });
    await fs.writeFile(path.join(root, "loader.mjs"), loader.code, { encoding: "utf8", flag: "wx" });
    const entry = path.join(root, "main.mjs");
    await fs.writeFile(entry, `
import { app, BrowserWindow, screen } from 'electron';
import assert from 'node:assert/strict';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { loadStartupWeb } from ${JSON.stringify(pathToFileURL(path.join(root, "loader.mjs")).href)};
const nativeHitTest = ${nativeHitTest.toString()};
app.setPath('userData', ${JSON.stringify(path.join(root, "profile"))});
void (async () => {
  let window;
  try {
    await app.whenReady();
    window = new BrowserWindow({ width:1000, height:800, x:50, y:50, frame:false,
      webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false} });
    window.webContents.on('console-message', details => { if (details.level === 'error') console.error(details.message); });
    await loadStartupWeb(window);
    await window.loadURL('http://127.0.0.1:${address.port}/');
    await window.webContents.executeJavaScript(
      "new Promise((resolve,reject)=>{const end=Date.now()+30000;const poll=()=>{const errors=window.fixtureErrors.filter(error=>!${startupError}||!error.includes('MIGRATION_CHUNK_FAILED'));if(errors.length)reject(Error(JSON.stringify(errors)));else if(document.querySelectorAll('${startupError ? ".app-startup-error button" : ".desktop-migration button"}').length===${startupError ? 1 : 2})resolve();else if(Date.now()>end)reject(Error('MIGRATION_RENDER_TIMEOUT:'+document.body.innerText));else setTimeout(poll,20);};poll();})");
    window.showInactive();
    const points = await window.webContents.executeJavaScript(
      "[...document.querySelectorAll('${startupError ? ".app-startup-error button" : ".desktop-migration button"}')].map(el=>{const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})");
    const bounds = window.getContentBounds(), scale = screen.getDisplayMatching(bounds).scaleFactor;
    const handle = window.getNativeWindowHandle();
    const hwnd = (handle.length===8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString();
    const regions = [];
    for (const point of [...points, {x:40,y:200}]) {
      regions.push(await nativeHitTest(hwnd, Math.round((bounds.x+point.x)*scale), Math.round((bounds.y+point.y)*scale)));
    }
    console.log(JSON.stringify({scenario:${JSON.stringify(startupError ? "startup-error" : "migration")},nativeRegions:regions}));
    assert.deepEqual(regions,${startupError ? "[1,1]" : "[1,1,1]"},'Startup buttons and blank content must be client areas, not a native title bar');
    if (${startupError}) {
      let reloaded = false;
      window.webContents.once('did-start-navigation', () => { reloaded = true; });
      const point = points[0];
      window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
      window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
      const deadline = Date.now() + 3000;
      while (!reloaded && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve,20));
      assert.equal(reloaded,true,'Retry must reload the current page through the real mouse event');
    } else {
      for (const [index, point] of points.entries()) {
        window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
        window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
        await window.webContents.executeJavaScript(
          'new Promise((resolve,reject)=>{const end=Date.now()+3000;const poll=()=>{if(window.migrationActions.length==='+(index+1)+')resolve();else if(Date.now()>end)reject(Error("MIGRATION_CLICK_TIMEOUT"));else setTimeout(poll,20);};poll();})');
      }
      assert.deepEqual(await window.webContents.executeJavaScript('window.migrationActions'),[['start','source-1'],['defer']]);
    }
    console.log(${JSON.stringify(startupError ? "Startup error native regions and retry action passed" : "Migration native regions and both button actions passed")});
    window.destroy();app.exit(0);
  } catch(error) {console.error(error);window?.destroy();app.exit(1);}
})();
`, { encoding: "utf8", flag: "wx" });
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const execution = promisify(execFile)(desktop("electron"), [entry], { env, windowsHide: true, timeout: 60_000 });
    execution.child.stdout.pipe(process.stdout);
    execution.child.stderr.pipe(process.stderr);
    await execution;
  } finally {
    await server.close();
    // 仅删除本次独占临时目录，拒绝清理其他路径。
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("codeflow-migration-interaction-"));
    await fs.rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
  }
}

await run();
await run(true);
