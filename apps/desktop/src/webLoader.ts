import crypto from "node:crypto";

type WebWindow = {
  loadURL(url: string): Promise<unknown>;
  webContents?: { executeJavaScript(source: string): Promise<unknown> };
};

export type WebLoadTrace = {
  stage: "navigation" | "before_ready" | "ready_probe";
  outcome: "start" | "success" | "failure";
  durationMs?: number;
  errorCode?: string;
  probeCount?: number;
  ready?: boolean;
  documentReadyState?: "loading" | "interactive" | "complete" | "unknown";
  htmlRootPresent?: boolean;
  appRootPresent?: boolean;
  bodyChildCount?: number;
};

/** 启动阶段进度只用于壳内提示，不代表业务就绪。 */
export type StartupStatus = { label: string; percent?: number };

/** 固定壳内启动页不读取发布资源，也不声明业务就绪。 */
export async function loadStartupWeb(window: WebWindow): Promise<void> {
  const nonce = crypto.randomBytes(16).toString("base64");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>CodeFlow</title><style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#faf9f5;color:#34322d}
@media(prefers-color-scheme:dark){:root{background:#1f1e1d;color:#e8e6df}}
body{margin:0;height:100vh;display:grid;place-content:center;text-align:center;-webkit-app-region:drag}
h1{font-size:24px;font-weight:500;margin:0 0 16px}p{font-size:14px;opacity:.7;margin:0}
.track{width:220px;height:4px;margin:18px auto 0;overflow:hidden;border-radius:999px;background:color-mix(in srgb,currentColor 14%,transparent)}
.track span{display:block;width:30%;height:100%;border-radius:999px;background:currentColor;opacity:.55;animation:flow 1.4s ease-in-out infinite alternate}
.track[aria-valuenow] span{animation:none;transition:width .25s ease}
@keyframes flow{from{transform:translateX(-100%)}to{transform:translateX(330%)}}
[data-codeflow-startup-elapsed]{margin-top:14px;font-size:12px}
</style></head><body><h1>CodeFlow</h1><p role="status" data-codeflow-startup-status>正在启动…</p>
<div class="track" role="progressbar" aria-label="正在启动" aria-valuemin="0" aria-valuemax="100" data-codeflow-startup-track><span data-codeflow-startup-bar></span></div>
<p data-codeflow-startup-elapsed>已用时 0 秒</p>
<script nonce="${nonce}">const started = Date.now(); setInterval(() => {
document.querySelector('[data-codeflow-startup-elapsed]').textContent = '已用时 ' + Math.floor((Date.now() - started) / 1000) + ' 秒';
}, 1000);</script></body></html>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

/** 更新固定状态；仅已计量进度设置百分比，其余阶段保留活动指示。 */
export async function updateStartupWeb(window: WebWindow, status: StartupStatus): Promise<void> {
  if (!window.webContents) return;
  const label = JSON.stringify(status.label);
  if (status.percent !== undefined && !Number.isFinite(status.percent)) throw new Error("DESKTOP_STARTUP_PROGRESS_INVALID");
  const percent = status.percent === undefined ? undefined : Math.max(0, Math.min(100, Math.round(status.percent)));
  await window.webContents.executeJavaScript(`(() => {
    const status = document.querySelector('[data-codeflow-startup-status]');
    if (status) status.textContent = ${label};
    const bar = document.querySelector('[data-codeflow-startup-bar]');
    if (bar) bar.style.width = ${percent === undefined ? "''" : `'${percent}%'`};
    const track = document.querySelector('[data-codeflow-startup-track]');
    if (track) {
      track.setAttribute('aria-label', ${label});
      ${percent === undefined ? "track.removeAttribute('aria-valuenow');" : `track.setAttribute('aria-valuenow', '${percent}');`}
    }
  })()`);
}

/** 导航后先等待已有本地启动任务，再限时确认应用挂载；导航成功本身不算健康。 */
export async function loadWeb(window: WebWindow, entry: string, options: {
  requireReady?: boolean; timeoutMs?: number; beforeReady?: () => Promise<void>; onTrace?: (event: WebLoadTrace) => void;
} = {}): Promise<void> {
  const emit = (event: WebLoadTrace): void => { options.onTrace?.(event); };
  let startedAt = performance.now();
  emit({ stage: "navigation", outcome: "start" });
  try { await window.loadURL(entry); }
  catch (cause) {
    try { emit({ stage: "navigation", outcome: "failure", durationMs: elapsed(startedAt), errorCode: safeWebErrorCode(cause) }); }
    catch (logError) { throw new AggregateError([cause, logError], "DESKTOP_WEB_TRACE_FAILED"); }
    throw cause;
  }
  emit({ stage: "navigation", outcome: "success", durationMs: elapsed(startedAt) });
  if (!options.requireReady) return;
  if (!window.webContents) throw new Error("DESKTOP_WEB_READY_UNAVAILABLE");
  if (options.beforeReady) {
    startedAt = performance.now(); emit({ stage: "before_ready", outcome: "start" });
    try { await options.beforeReady(); }
    catch (cause) {
      try { emit({ stage: "before_ready", outcome: "failure", durationMs: elapsed(startedAt), errorCode: safeWebErrorCode(cause) }); }
      catch (logError) { throw new AggregateError([cause, logError], "DESKTOP_WEB_TRACE_FAILED"); }
      throw cause;
    }
    emit({ stage: "before_ready", outcome: "success", durationMs: elapsed(startedAt) });
  }
  const timeoutMs = options.timeoutMs ?? 30_000, deadline = performance.now() + timeoutMs;
  let probes = 0, lastState: WebLoadTrace | undefined;
  startedAt = performance.now(); emit({ stage: "ready_probe", outcome: "start" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 只读取可信页面的固定启动协议；探测拒绝与超时均交更新恢复边界。 */
  const wait = async (): Promise<void> => {
    while (performance.now() < deadline) {
      probes++;
      const result = await window.webContents!.executeJavaScript(`(() => ({
        ready: document.documentElement.dataset.codeflowReady === "1",
        documentReadyState: document.readyState,
        htmlRootPresent: Boolean(document.documentElement),
        appRootPresent: Boolean(document.getElementById("app")),
        bodyChildCount: document.body?.childElementCount ?? 0
      }))()`);
      if (result && typeof result === "object") {
        const state = result as Record<string, unknown>;
        lastState = {
          stage: "ready_probe", outcome: "failure", ready: state.ready === true,
          documentReadyState: ["loading", "interactive", "complete"].includes(String(state.documentReadyState))
            ? state.documentReadyState as "loading" | "interactive" | "complete" : "unknown",
          htmlRootPresent: state.htmlRootPresent === true,
          appRootPresent: state.appRootPresent === true,
          bodyChildCount: Number.isSafeInteger(state.bodyChildCount) && Number(state.bodyChildCount) >= 0
            ? Number(state.bodyChildCount) : 0,
        };
        if (lastState.ready) return;
      }
      if (result === true) return;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(50, remaining)));
    }
    throw Object.assign(new Error("DESKTOP_WEB_READY_TIMEOUT"), { code: "DESKTOP_WEB_READY_TIMEOUT" });
  };
  try {
    await Promise.race([wait(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("DESKTOP_WEB_READY_TIMEOUT"), { code: "DESKTOP_WEB_READY_TIMEOUT" })), timeoutMs);
    })]);
    emit({ stage: "ready_probe", outcome: "success", durationMs: elapsed(startedAt), probeCount: probes, ready: true,
      ...(lastState ? { documentReadyState: lastState.documentReadyState, htmlRootPresent: lastState.htmlRootPresent,
        appRootPresent: lastState.appRootPresent, bodyChildCount: lastState.bodyChildCount } : {}) });
  } catch (cause) {
    try { emit({ ...lastState, stage: "ready_probe", outcome: "failure", durationMs: elapsed(startedAt), probeCount: probes,
      errorCode: safeWebErrorCode(cause) }); }
    catch (logError) { throw new AggregateError([cause, logError], "DESKTOP_WEB_TRACE_FAILED"); }
    throw cause;
  } finally { if (timer) clearTimeout(timer); }
}

/** 仅输出固定错误码/名称，避免异常正文夹带页面数据。 */
function safeWebErrorCode(cause: unknown): string {
  if (!cause || typeof cause !== "object") return "DESKTOP_WEB_LOAD_FAILED";
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string" && /^[A-Z0-9_:-]{1,96}$/u.test(code)) return code;
  const name = (cause as { name?: unknown }).name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/u.test(name) ? `WEB_${name.toUpperCase()}` : "DESKTOP_WEB_LOAD_FAILED";
}

/** 使用单调时钟记录阶段持续时间。 */
function elapsed(startedAt: number): number { return Math.max(0, Math.round(performance.now() - startedAt)); }
