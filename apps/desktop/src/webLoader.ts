type WebWindow = {
  loadURL(url: string): Promise<unknown>;
  webContents?: { executeJavaScript(source: string): Promise<unknown> };
};

/** 启动阶段进度只用于壳内提示，不代表业务就绪。 */
export type StartupStatus = { label: string; percent: number };

/** 固定壳内启动页不读取发布资源，也不声明业务就绪。 */
export async function loadStartupWeb(window: WebWindow): Promise<void> {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>CodeFlow</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#faf9f5;color:#34322d}
@media(prefers-color-scheme:dark){:root{background:#1f1e1d;color:#e8e6df}}
body{margin:0;height:100vh;display:grid;place-content:center;text-align:center;-webkit-app-region:drag}
h1{font-size:24px;font-weight:500;margin:0 0 16px}p{font-size:14px;opacity:.7;margin:0}
.track{width:220px;height:4px;margin:18px auto 0;overflow:hidden;border-radius:999px;background:color-mix(in srgb,currentColor 14%,transparent)}
.track span{display:block;width:10%;height:100%;border-radius:999px;background:currentColor;opacity:.55;transition:width .25s ease}
</style></head><body><h1>CodeFlow</h1><p role="status" data-codeflow-startup-status>正在启动…</p>
<div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="10" data-codeflow-startup-track><span data-codeflow-startup-bar></span></div></body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

/** 更新启动页阶段与进度；只改固定文本和宽度，不执行页面业务脚本。 */
export async function updateStartupWeb(window: WebWindow, status: StartupStatus): Promise<void> {
  if (!window.webContents) return;
  const label = JSON.stringify(status.label);
  const percent = Math.max(0, Math.min(100, Math.round(status.percent)));
  await window.webContents.executeJavaScript(`(() => {
    const status = document.querySelector('[data-codeflow-startup-status]');
    if (status) status.textContent = ${label};
    const bar = document.querySelector('[data-codeflow-startup-bar]');
    if (bar) bar.style.width = '${percent}%';
    const track = document.querySelector('[data-codeflow-startup-track]');
    if (track) track.setAttribute('aria-valuenow', '${percent}');
  })()`);
}

/** 导航后先等待已有本地启动任务，再限时确认应用挂载；导航成功本身不算健康。 */
export async function loadWeb(window: WebWindow, entry: string, options: {
  requireReady?: boolean; timeoutMs?: number; beforeReady?: () => Promise<void>;
} = {}): Promise<void> {
  await window.loadURL(entry);
  if (!options.requireReady) return;
  if (!window.webContents) throw new Error("DESKTOP_WEB_READY_UNAVAILABLE");
  await options.beforeReady?.();
  const timeoutMs = options.timeoutMs ?? 30_000, deadline = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 只读取可信页面的固定启动协议；探测拒绝与超时均交更新恢复边界。 */
  const wait = async (): Promise<void> => {
    while (performance.now() < deadline) {
      if (await window.webContents!.executeJavaScript('document.documentElement.dataset.codeflowReady === "1"') === true) return;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(50, remaining)));
    }
    throw new Error("DESKTOP_WEB_READY_TIMEOUT");
  };
  try {
    await Promise.race([wait(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("DESKTOP_WEB_READY_TIMEOUT")), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
