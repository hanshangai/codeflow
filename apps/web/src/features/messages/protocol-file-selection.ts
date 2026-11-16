export function resolveProtocolSelectedFilePath(input: {
  currentSelectedFilePath: string | null;
  nextFilePaths: string[];
}): string | null {
  const nextFilePaths = input.nextFilePaths.filter(Boolean);
  if (!nextFilePaths.length) return null;
  const currentSelectedFilePath = String(input.currentSelectedFilePath ?? "").trim();
  if (currentSelectedFilePath && nextFilePaths.includes(currentSelectedFilePath)) {
    return currentSelectedFilePath;
  }
  return nextFilePaths[0] ?? null;
}
