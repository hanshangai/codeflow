export type ServerConnectionHintInput = {
  serverWsUrl: string;
  message: string | null;
  code: number | null;
  reason: string;
  hasConnectedBefore: boolean;
};

/** 将底层连接失败翻译为面向用户的控制台提示。 */
export function resolveServerConnectionHint(input: ServerConnectionHintInput): string | null {
  const rawErrorText = `${String(input.message ?? "")} ${String(input.reason ?? "")}`.trim();
  const errorText = rawErrorText.toLowerCase();
  const prefix = input.hasConnectedBefore ? "[codeflowai] 与 Server 连接中断：" : "[codeflowai] 无法连接到 Server：";
  if (errorText.includes("invalid url") || errorText.includes("the url") || errorText.includes("ws+unix")) {
    return `${prefix}Server 地址格式不正确，请检查 CODEFLOWAI_SERVER_WS，当前值：${input.serverWsUrl}`;
  }
  if (errorText.includes("enotfound") || errorText.includes("eai_again") || errorText.includes("getaddrinfo")) {
    return `${prefix}无法解析 Server 地址，请检查域名或 IP 是否正确，当前值：${input.serverWsUrl}`;
  }
  if (errorText.includes("econnrefused")) {
    return `${prefix}目标地址拒绝连接，请确认 Server 已启动且端口可访问，当前值：${input.serverWsUrl}`;
  }
  if (errorText.includes("etimedout") || errorText.includes("timed out") || errorText.includes("timeout")) {
    return `${prefix}连接超时，请检查网络、代理或防火墙设置，当前值：${input.serverWsUrl}`;
  }
  if (errorText.includes("certificate") || errorText.includes("self signed") || errorText.includes("hostname/ip")) {
    return `${prefix}TLS/证书校验失败，请检查 https/wss 证书配置，当前值：${input.serverWsUrl}`;
  }
  if (input.code === 1008 || errorText.includes("apikey") || errorText.includes("authorization") || errorText.includes("not allowed")) {
    return `${prefix}鉴权失败，请检查 CODEFLOWAI_API_KEY 是否正确，Server 返回：${input.reason || input.message || "1008"}`;
  }
  if (!input.hasConnectedBefore && input.code === 1006) {
    return `${prefix}Server 不可达或握手失败，请检查地址、网络以及 Server 进程状态，当前值：${input.serverWsUrl}`;
  }
  if (input.hasConnectedBefore && input.code === 1006) {
    return `${prefix}网络中断或 Server 已关闭，client 会自动重连。`;
  }
  return null;
}
