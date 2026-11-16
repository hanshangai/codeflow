import type { Writable } from "node:stream";

/** stdout/stderr 的文件或管道故障只影响控制台输出，不应作为未捕获异常终止业务进程。 */
export function installClientStdioDiagnostics(input: {
  stdout: Writable;
  stderr: Writable;
  onError: (stream: "stdout" | "stderr", error: Error) => void;
}): () => void {
  const cleanups: Array<() => void> = [];
  for (const name of ["stdout", "stderr"] as const) {
    const stream = input[name];
    const reported = new Set<string>();
    const onError = (error: Error) => {
      const code = String((error as NodeJS.ErrnoException).code ?? error.name);
      if (reported.has(code)) return;
      reported.add(code);
      input.onError(name, error);
    };
    stream.on("error", onError);
    cleanups.push(() => stream.off("error", onError));
  }
  return () => { for (const cleanup of cleanups) cleanup(); };
}
