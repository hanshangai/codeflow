import type { ProviderNativeToolPolicy } from "./threadSession.js";

export function providerNativeToolsDenied(policy: ProviderNativeToolPolicy | null | undefined): boolean {
  return policy === "deny" || policy === "interactive-only";
}

export function providerNativeInteractionToolsAllowed(policy: ProviderNativeToolPolicy | null | undefined): boolean {
  return policy === "allow" || policy === "interactive-only";
}

export function buildProviderNativeToolDenyMessage(engine: "claude" | "codex", toolName: string): string {
  const normalizedToolName = String(toolName ?? "").trim() || "该工具";
  const engineLabel = engine === "claude" ? "Claude" : "Codex";
  return [
    `当前会话禁止直接使用 ${engineLabel} 原生工具 ${normalizedToolName}。`,
    "如果平台提供了可用真实工具，请直接调用真实工具；",
    "不要通过 assistant 文本输出任何 JSON 协议。",
  ].join("");
}
