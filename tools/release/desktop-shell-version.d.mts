export function assertShellVersion(value: unknown): string;
export function readDesktopShellInputs(root: string): Promise<{ shellInputFingerprint: string; baselineVersion: string; electronVersion: string }>;
export function allocateDesktopShellVersion(input: {
  baselineVersion: string;
  shellInputFingerprint: string;
  plans: Array<{ shellVersion?: string; shellInputFingerprint?: string }>;
}): string;
