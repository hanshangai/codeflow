/** 判断 MCP 启动命令是否直接指向 Docker 可执行文件。 */
export function isDockerMcpCommand(command: unknown): boolean {
  const value = String(command ?? "").trim().toLowerCase().replaceAll("\\", "/");
  const basename = value.slice(value.lastIndexOf("/") + 1);
  return basename === "docker" || basename === "docker.exe";
}
