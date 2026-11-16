export class SessionInvalidatedError extends Error {
  readonly code = "session_invalidated";
  constructor(message: string) {
    super(message);
    this.name = "SessionInvalidatedError";
  }
}
