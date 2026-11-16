/** 将 git 错误包装为可序列化消息。 */
export function wrapGitError(e: unknown): string {
  if (e instanceof Error) {
    // simple-git 的 GitError 通常在 message 中包含有用信息
    return e.message.replace(/\n+/g, " ").slice(0, 500);
  }
  return String(e).slice(0, 500);
}
