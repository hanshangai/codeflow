export type WorkspacePathIndexExclusionGroup = {
  key: string;
  label: string;
  directoryNames?: readonly string[];
  rootDirectoryNames?: readonly string[];
  paths?: readonly string[];
  pathPrefixes?: readonly string[];
};

/** 文件索引内置排除规则；Client 执行和 Web 展示必须共用此清单。 */
export const WORKSPACE_PATH_INDEX_DEFAULT_EXCLUSION_GROUPS: readonly WorkspacePathIndexExclusionGroup[] = [
  {
    key: "version-control",
    label: "版本控制",
    directoryNames: [".git", ".svn", ".hg", ".bzr"],
  },
  {
    key: "dependencies",
    label: "依赖目录",
    directoryNames: ["node_modules", ".pnpm", ".yarn", "bower_components", "jspm_packages", "pods"],
    paths: ["ios/pods"],
    pathPrefixes: [".cargo/registry", ".cargo/git", "vendor/bundle"],
  },
  {
    key: "build-output",
    label: "构建与测试产物",
    directoryNames: [
      "storybook-static", "coverage", "htmlcov", "target", "dist", "build", "release", "debug", "testresults",
      ".zig-cache", "zig-out", "cmake-build-debug", "cmake-build-release", "cmakefiles", "deriveddata",
    ],
    rootDirectoryNames: ["bin", "obj", "out"],
    paths: [".output", ".vercel", ".netlify", ".firebase", "android/build"],
  },
  {
    key: "framework-cache",
    label: "框架与工具缓存",
    directoryNames: [
      ".gradle", ".terraform", ".serverless", ".aws-sam", ".cache", ".parcel-cache", ".turbo", ".nx", ".next",
      ".nuxt", ".svelte-kit", ".vite", ".angular", ".expo", ".dart_tool", ".flutter-plugins",
      ".flutter-plugins-dependencies", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".tox", ".nox", ".sass-cache",
    ],
    paths: ["android/.gradle"],
  },
  {
    key: "runtime-temp",
    label: "环境与临时目录",
    directoryNames: [
      ".venv", "venv", "__pycache__", ".vs", ".idea", ".history", ".vscode-test", "logs", "log", "tmp", "temp",
      ".tmp", ".temp",
    ],
  },
] as const;

/** 按匹配类型展开内置规则，供索引 worker 构造高效集合。 */
export function flattenWorkspacePathIndexDefaultExclusions(): {
  directoryNames: string[];
  rootDirectoryNames: string[];
  paths: string[];
  pathPrefixes: string[];
} {
  return WORKSPACE_PATH_INDEX_DEFAULT_EXCLUSION_GROUPS.reduce((result, group) => {
    result.directoryNames.push(...(group.directoryNames ?? []));
    result.rootDirectoryNames.push(...(group.rootDirectoryNames ?? []));
    result.paths.push(...(group.paths ?? []));
    result.pathPrefixes.push(...(group.pathPrefixes ?? []));
    return result;
  }, { directoryNames: [], rootDirectoryNames: [], paths: [], pathPrefixes: [] } as {
    directoryNames: string[];
    rootDirectoryNames: string[];
    paths: string[];
    pathPrefixes: string[];
  });
}
