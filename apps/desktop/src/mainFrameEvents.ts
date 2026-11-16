import type { DesktopEvent } from "@codeflowai/shared";
import { assertTrustedDesktopSender, isTrustedDesktopUrl } from "./webProtocol.js";

type MainFrameContents = {
  mainFrame: { url: string; send(channel: string, event: DesktopEvent): void };
  isDestroyed(): boolean;
  isLoadingMainFrame(): boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
};

/** 仅可信主文档存续期间订阅；重载缺口由 SQLite 历史恢复，不另存推送队列。 */
export function bindMainFrameEvents(contents: MainFrameContents, entry: string,
  subscribe: (listener: (event: DesktopEvent) => void) => () => void): () => void {
  let unsubscribe: (() => void) | null = null;
  let disposed = false;
  /** 提交时替换文档订阅；取消导航保留旧文档，投递时复验当前真实主 frame。 */
  const bindDocument = (): void => {
    if (disposed || contents.isDestroyed()) return;
    unsubscribe?.();
    unsubscribe = null;
    const url = contents.mainFrame.url;
    if (!url || url === "about:blank" || !isTrustedDesktopUrl(url, entry)) return;
    unsubscribe = subscribe((event) => {
      if (contents.isDestroyed()) throw new Error("DESKTOP_EVENT_TARGET_UNAVAILABLE");
      const frame = contents.mainFrame;
      assertTrustedDesktopSender({ mainFrame: frame === contents.mainFrame, url: frame.url }, entry);
      frame.send("desktop:event", event);
    });
  };
  /** 导航提交早于页面脚本挂载，避免历史读取后才接入实时尾部。 */
  const onCommitted = (_event: unknown, _url: string, _status: number, _text: string, isMainFrame: boolean): void => {
    if (isMainFrame) bindDocument();
  };
  /** 销毁与显式注销共用幂等清理，避免旧窗口保留当前 runtime 的订阅。 */
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    unsubscribe = null;
    contents.removeListener("did-frame-navigate", onCommitted);
    contents.removeListener("destroyed", dispose);
  };
  contents.on("did-frame-navigate", onCommitted);
  contents.on("destroyed", dispose);
  if (!contents.isLoadingMainFrame()) bindDocument();
  return dispose;
}
