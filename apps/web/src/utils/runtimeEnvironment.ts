type RuntimeEnvironmentSource = {
  VITE_CODEFLOWAI_RUNTIME_ENV?: unknown;
  DEV?: unknown;
};

export type RuntimeEnvironment = "dev" | "test" | "production";

const viteEnv = ((import.meta as ImportMeta & { env?: RuntimeEnvironmentSource }).env ?? {}) as RuntimeEnvironmentSource;

/** 构建注入优先，本地 Vite dev 回退 dev；未注入视为生产，不显示标识。 */
export function resolveRuntimeEnvironment(source: RuntimeEnvironmentSource = viteEnv): RuntimeEnvironment {
  const injected = String(source.VITE_CODEFLOWAI_RUNTIME_ENV ?? "").trim().toLowerCase();
  if (injected === "dev" || injected === "test" || injected === "production") return injected;
  return source.DEV === true ? "dev" : "production";
}

/** 仅本地开发与测试环境展示徽标；生产返回 null。 */
export function resolveRuntimeEnvironmentBadge(
  source: RuntimeEnvironmentSource = viteEnv,
): { label: "DEV" | "TEST"; title: string } | null {
  const environment = resolveRuntimeEnvironment(source);
  if (environment === "dev") return { label: "DEV", title: "本地开发环境" };
  if (environment === "test") return { label: "TEST", title: "测试环境" };
  return null;
}
