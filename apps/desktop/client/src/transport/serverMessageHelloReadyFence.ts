type HelloReadyState = {
  generation: number;
  promise: Promise<boolean>;
  resolve: (ready: boolean) => void;
  settled: boolean;
};

/** Gates Server messages until the current connection's hello activation is fully ready. */
export class ServerMessageHelloReadyFence {
  private generation = 0;
  private state: HelloReadyState | null = null;

  /** Starts a new connection generation and releases stale waiters as not ready. */
  beginConnection(): number {
    this.settle(this.state, false);
    const generation = this.generation + 1;
    this.generation = generation;
    let resolve!: (ready: boolean) => void;
    const promise = new Promise<boolean>((settle) => { resolve = settle; });
    this.state = { generation, promise, resolve, settled: false };
    return generation;
  }

  /** Marks only the current connection generation ready. */
  markReady(generation: number): boolean {
    const state = this.state;
    if (!state || state.generation !== generation) return false;
    this.settle(state, true);
    return true;
  }

  /** Releases pending messages for a closed connection without authorizing execution. */
  closeConnection(generation: number): void {
    const state = this.state;
    if (!state || state.generation !== generation) return;
    this.settle(state, false);
    this.state = null;
  }

  /** Waits for the exact connection generation and returns false when it became stale or closed. */
  waitUntilReady(generation: number): Promise<boolean> {
    const state = this.state;
    return state && state.generation === generation
      ? state.promise
      : Promise.resolve(false);
  }

  /** Reports whether async hello work still belongs to the active connection. */
  isCurrent(generation: number): boolean {
    return this.state?.generation === generation;
  }

  /** Settles one generation at most once. */
  private settle(state: HelloReadyState | null, ready: boolean): void {
    if (!state || state.settled) return;
    state.settled = true;
    state.resolve(ready);
  }
}
