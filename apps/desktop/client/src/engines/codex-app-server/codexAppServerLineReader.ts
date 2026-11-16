export const CODEX_APP_SERVER_MAX_LINE_BYTES = 64 * 1024 * 1024;

export type CodexAppServerLineLimitError = {
  lineBytes: number;
  maxLineBytes: number;
};

/** Splits a child-process stream without allowing an unterminated line to grow without bound. */
export class CodexAppServerLineReader {
  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private failed = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onLineTooLarge: (error: CodexAppServerLineLimitError) => void,
    private readonly maxLineBytes = CODEX_APP_SERVER_MAX_LINE_BYTES,
  ) {}

  /** Adds one stream chunk and emits each complete UTF-8 line in order. */
  push(chunk: Buffer): void {
    if (this.failed) return;

    let offset = 0;
    for (let newlineAt = chunk.indexOf(0x0a, offset); newlineAt >= 0; newlineAt = chunk.indexOf(0x0a, offset)) {
      if (!this.append(chunk.subarray(offset, newlineAt))) return;
      const line = Buffer.concat(this.chunks, this.bufferedBytes).toString("utf8").replace(/\r$/, "");
      this.chunks.length = 0;
      this.bufferedBytes = 0;
      this.onLine(line);
      if (this.failed) return;
      offset = newlineAt + 1;
    }

    this.append(chunk.subarray(offset));
  }

  /** Emits a final line at EOF and releases buffered chunks. */
  end(): void {
    if (this.failed) return;
    const line = this.bufferedBytes ? Buffer.concat(this.chunks, this.bufferedBytes).toString("utf8").replace(/\r$/, "") : null;
    this.close();
    if (line !== null) this.onLine(line);
  }

  /** Releases partial output when its child process has failed or closed. */
  close(): void {
    this.failed = true;
    this.chunks.length = 0;
    this.bufferedBytes = 0;
  }

  /** Buffers a partial line or reports its first byte-limit violation. */
  private append(chunk: Buffer): boolean {
    if (chunk.length === 0) return true;
    const lineBytes = this.bufferedBytes + chunk.length;
    if (lineBytes > this.maxLineBytes) {
      this.close();
      this.onLineTooLarge({ lineBytes, maxLineBytes: this.maxLineBytes });
      return false;
    }
    this.chunks.push(chunk);
    this.bufferedBytes = lineBytes;
    return true;
  }
}
