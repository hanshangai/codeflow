/** 识别升级后的重连 Client；ID 变化时必须匹配稳定设备标识。 */
export function findReconnectedClientId<T extends { clientId: string; deviceId?: string | null; version: string }>(
  originalClientId: string,
  originalDeviceId: string | null | undefined,
  targetVersion: string,
  clients: T[],
  compareVersion: (left: string, right: string) => number,
): string | null {
  const exact = clients.find((client) => client.clientId === originalClientId);
  const deviceId = String(originalDeviceId ?? "").trim();
  if (
    exact
    && (!deviceId || String(exact.deviceId ?? "").trim() === deviceId)
    && compareVersion(exact.version, targetVersion) >= 0
  ) return exact.clientId;
  if (!deviceId) return null;
  const candidates = clients.filter((client) =>
    String(client.deviceId ?? "").trim() === deviceId
    && compareVersion(client.version, targetVersion) >= 0,
  );
  return candidates.length === 1 ? candidates[0]!.clientId : null;
}
