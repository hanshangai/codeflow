import type { DesktopBridgeApi } from "./contracts.js";

declare global {
  interface Window {
    codeflowDesktop: DesktopBridgeApi;
  }
}

export {};
