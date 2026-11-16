export const UNCONDITIONAL_REGENERABLE_DIRECTORY_NAMES = [
  "node_modules",
  ".gradle",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
] as const;

const UNCONDITIONAL_NAME_SET = new Set<string>(UNCONDITIONAL_REGENERABLE_DIRECTORY_NAMES);
const CONDITIONAL_DIRECTORY_NAMES = new Set(["target", "build", "bin", "obj"]);
const DOTNET_PROJECT_EXTENSIONS = [".csproj", ".fsproj", ".vbproj"];

export type WorkspaceMigrationRegenerableDirectoryKind =
  | "node_dependencies"
  | "gradle_cache"
  | "python_environment"
  | "python_cache"
  | "maven_output"
  | "gradle_output"
  | "cmake_output"
  | "dotnet_output"
  | "rust_output";

export type WorkspaceMigrationDirectoryCandidate = {
  name: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  siblingFileNames: readonly string[];
};

/** 按目录名和同级项目标识识别可重新生成目录；普通文件永不排除。 */
export function classifyWorkspaceMigrationRegenerableDirectory(
  candidate: WorkspaceMigrationDirectoryCandidate,
): WorkspaceMigrationRegenerableDirectoryKind | null {
  if (!candidate.isDirectory && !candidate.isSymbolicLink) return null;
  const name = candidate.name.toLowerCase();
  if (name === "node_modules") return "node_dependencies";
  if (name === ".gradle") return "gradle_cache";
  if (name === ".venv") return "python_environment";
  if (name === "__pycache__" || name === ".pytest_cache" || name === ".mypy_cache" || name === ".ruff_cache") {
    return "python_cache";
  }

  const siblings = new Set(candidate.siblingFileNames.map((entry) => entry.toLowerCase()));
  if (name === "target" && siblings.has("pom.xml")) return "maven_output";
  if (name === "target" && siblings.has("cargo.toml")) return "rust_output";
  if (name === "build" && (siblings.has("build.gradle") || siblings.has("build.gradle.kts"))) return "gradle_output";
  if ((name === "build" || isCmakeBuildDirectoryName(name)) && siblings.has("cmakelists.txt")) return "cmake_output";
  if ((name === "bin" || name === "obj") && hasDotnetProjectMarker(siblings)) return "dotnet_output";
  return null;
}

/** 校验持久化相对路径的末级名称属于当前支持的排除规则。 */
export function isSupportedRegenerableDirectoryRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return false;
  const leaf = normalized.split("/").at(-1)?.toLowerCase() ?? "";
  return UNCONDITIONAL_NAME_SET.has(leaf)
    || CONDITIONAL_DIRECTORY_NAMES.has(leaf)
    || isCmakeBuildDirectoryName(leaf);
}

/** 判断监听事件是否位于无歧义名称或已扫描确认的排除目录内。 */
export function isPathInsideRegenerableDirectory(
  relativePath: string | null,
  confirmedDirectories: readonly string[],
  caseSensitive: boolean,
): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return false;
  const comparablePath = caseSensitive ? normalized : normalized.toLowerCase();
  if (comparablePath.split("/").some((segment) => UNCONDITIONAL_NAME_SET.has(segment.toLowerCase()))) return true;
  return confirmedDirectories.some((directory) => {
    const normalizedDirectory = normalizeRelativePath(directory);
    if (!normalizedDirectory) return false;
    const comparableDirectory = caseSensitive ? normalizedDirectory : normalizedDirectory.toLowerCase();
    return comparablePath === comparableDirectory || comparablePath.startsWith(`${comparableDirectory}/`);
  });
}

/** 规范化工作区相对路径；绝对路径、空段和父级跳转返回 null。 */
function normalizeRelativePath(value: string | null): string | null {
  const normalized = String(value ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

/** 判断目录名是否符合常见 CMake IDE 构建目录命名。 */
function isCmakeBuildDirectoryName(name: string): boolean {
  return /^cmake-build-.+/i.test(name);
}

/** 判断同级条目是否包含 .NET 项目文件。 */
function hasDotnetProjectMarker(siblingNames: ReadonlySet<string>): boolean {
  return [...siblingNames].some((name) => DOTNET_PROJECT_EXTENSIONS.some((extension) => name.endsWith(extension)));
}
