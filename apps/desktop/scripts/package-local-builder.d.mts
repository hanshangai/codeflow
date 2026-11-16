export function toBuilderVersion(version: string): string;
export function resolveElectronVersion(): Promise<string>;
export function removeBuilderProject(stage: string): Promise<void>;
export function createBuilderProject(desktopDir: string, shellVersion: string): Promise<string>;
