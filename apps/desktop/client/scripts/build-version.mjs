export function resolveClientBuildVersion(repoVersion, plannedVersion) {
  const version = String(plannedVersion ?? repoVersion ?? "").trim();
  if (!/^\d{4}\.\d{2}\.\d{2}\.\d+$/u.test(version)) {
    throw Object.assign(new Error(`DESKTOP_CLIENT_BUILD_VERSION_INVALID: ${version}`), { code: "DESKTOP_CLIENT_BUILD_VERSION_INVALID" });
  }
  return version;
}
