/** 解析可展示的 CLI 入口路径；node -e 引导时取真实入口脚本，避免把引导参数当成路径。 */
export function resolveCliDisplayPath(input: { command: string; argsPrefix: readonly string[] }): string {
  if (input.argsPrefix[0] === "-e") {
    return input.argsPrefix.length >= 3 ? input.argsPrefix[2]! : input.command;
  }
  return input.argsPrefix[0] ?? input.command;
}
