type WebWindow = {
  loadURL(url: string): Promise<unknown>;
  webContents?: { executeJavaScript(source: string): Promise<unknown> };
};

/** 固定壳内启动页不读取发布资源，也不声明业务就绪。 */
export async function loadStartupWeb(window: WebWindow): Promise<void> {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>CodeFlow</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#faf9f5;color:#34322d}
@media(prefers-color-scheme:dark){:root{background:#1f1e1d;color:#e8e6df}}
body{margin:0;height:100vh;display:grid;place-content:center;text-align:center;-webkit-app-region:drag}
h1{font-size:24px;font-weight:500;margin:0 0 16px}p{font-size:14px;opacity:.7;margin:0}
</style></head><body><h1>CodeFlow</h1><p role="status">正在启动…</p></body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
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
