export function completePackagedResources(input: { source: string; destination: string; platform: string; arch: string }): Promise<void>;
export default function afterPack(context: { appOutDir: string; electronPlatformName: string; packager: {
  config: { extraResources: Array<string | { from?: string; to?: string }> };
  getResourcesDir(directory: string): string;
} }): Promise<void>;
