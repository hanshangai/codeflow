<script setup lang="ts">
import { computed, type Component } from "vue";
import {
  FileOutlined, FolderOutlined, FolderOpenOutlined,
  FileImageOutlined, FileMarkdownOutlined,
  FileTextOutlined, FilePdfOutlined, FileWordOutlined,
  FileExcelOutlined, FilePptOutlined, FileZipOutlined,
  CodeOutlined, DatabaseOutlined, SettingOutlined,
  PlusOutlined, MinusOutlined,
} from "@ant-design/icons-vue";
import { formatFileSizeLabel, formatMtimeLabel, formatMtimeTitle } from "../../../utils/fileMetaPresentation";
import type { FsTreeNode, GitFileStatus } from "@codeflowai/shared";

defineOptions({ name: "FileTreeNode" });

const props = defineProps<{
  node: FsTreeNode;
  gitStatusMap?: Map<string, GitFileStatus>;
  viewMode?: "files" | "git" | "log";
}>();

const emit = defineEmits<{
  (e: "stage", path: string): void;
  (e: "unstage", path: string): void;
}>();

type FileIconKind = "default" | "image" | "markdown" | "code" | "text" | "pdf" | "word" | "excel" | "ppt" | "archive" | "database" | "config";
type FileIconDefinition = { component: Component; kind: FileIconKind };

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "tif", "tiff"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "py", "java", "kt", "kts", "rs", "go", "rb", "php",
  "c", "cc", "cpp", "cxx", "h", "hpp", "cs", "swift", "dart", "scala", "sh", "bash", "zsh", "fish", "ps1",
  "bat", "cmd", "html", "htm", "css", "scss", "sass", "less", "svelte", "astro", "graphql", "gql",
]);
const TEXT_EXTENSIONS = new Set(["txt", "log", "rtf"]);
const WORD_EXTENSIONS = new Set(["doc", "docx", "docm", "dot", "dotx", "odt"]);
const EXCEL_EXTENSIONS = new Set(["xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "ods", "csv", "tsv"]);
const PPT_EXTENSIONS = new Set(["ppt", "pptx", "pptm", "pot", "potx", "pps", "ppsx", "odp", "key"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "jar", "war"]);
const DATABASE_EXTENSIONS = new Set(["db", "sqlite", "sqlite3", "sql", "dump", "bak"]);
const CONFIG_EXTENSIONS = new Set(["json", "jsonc", "yaml", "yml", "toml", "ini", "conf", "config", "env", "properties", "xml", "lock"]);
const CODE_FILENAMES = new Set(["dockerfile", "makefile", "jenkinsfile", "procfile", "rakefile"]);
const CONFIG_FILENAMES = new Set([".editorconfig", ".gitattributes", ".gitignore", ".npmrc", ".prettierrc", ".eslintrc"]);

/** 按文件名解析图标分类；未知格式回退为通用文件图标。 */
function resolveFileIcon(name: string): FileIconDefinition {
  const normalizedName = name.trim().toLowerCase();
  const ext = normalizedName.split(".").pop() ?? "";
  if (CODE_FILENAMES.has(normalizedName)) return { component: CodeOutlined, kind: "code" };
  if (CONFIG_FILENAMES.has(normalizedName) || normalizedName.startsWith(".env")) return { component: SettingOutlined, kind: "config" };
  if (IMAGE_EXTENSIONS.has(ext)) return { component: FileImageOutlined, kind: "image" };
  if (MARKDOWN_EXTENSIONS.has(ext)) return { component: FileMarkdownOutlined, kind: "markdown" };
  if (normalizedName === "readme") return { component: FileMarkdownOutlined, kind: "markdown" };
  if (normalizedName === "license") return { component: FileTextOutlined, kind: "text" };
  if (ext === "pdf") return { component: FilePdfOutlined, kind: "pdf" };
  if (WORD_EXTENSIONS.has(ext)) return { component: FileWordOutlined, kind: "word" };
  if (EXCEL_EXTENSIONS.has(ext)) return { component: FileExcelOutlined, kind: "excel" };
  if (PPT_EXTENSIONS.has(ext)) return { component: FilePptOutlined, kind: "ppt" };
  if (ARCHIVE_EXTENSIONS.has(ext)) return { component: FileZipOutlined, kind: "archive" };
  if (DATABASE_EXTENSIONS.has(ext)) return { component: DatabaseOutlined, kind: "database" };
  if (CONFIG_EXTENSIONS.has(ext)) return { component: SettingOutlined, kind: "config" };
  if (CODE_EXTENSIONS.has(ext)) return { component: CodeOutlined, kind: "code" };
  if (TEXT_EXTENSIONS.has(ext)) return { component: FileTextOutlined, kind: "text" };
  return { component: FileOutlined, kind: "default" };
}

/** 当前文件节点的图标和颜色分类。 */
const fileIcon = computed<FileIconDefinition | null>(() => {
  if (!props.node) return null;
  if (props.node.isDir) return null; // 由 tree 控制
  return resolveFileIcon(props.node.name);
});

/** Git 状态 */
const gitStatus = computed(() => {
  if (!props.gitStatusMap || !props.node) return null;
  return props.gitStatusMap.get(props.node.path) ?? null;
});

/** 状态字母 */
const statusLetter = computed(() => {
  const s = gitStatus.value;
  if (!s) return null;
  if (s.index && s.index !== " " && s.index !== "?") return s.index;
  if (s.working && s.working !== " ") return s.working;
  return null;
});

/** 状态颜色 */
const statusColor = computed(() => {
  const l = statusLetter.value;
  if (!l) return "";
  if (l === "M") return "var(--explorer-status-modified, #1890ff)";
  if (l === "A") return "var(--explorer-status-added, #52c41a)";
  if (l === "D") return "var(--explorer-status-deleted, #ff4d4f)";
  if (l === "R") return "var(--explorer-status-renamed, #722ed1)";
  if (l === "?") return "var(--explorer-status-untracked, #d48806)";
  return "var(--app-muted)";
});

/** 文件名样式（Git 颜色编码） */
const nameStyle = computed(() => {
  if (!statusColor.value) return {};
  return { color: statusColor.value };
});

/** 文件大小格式化；目录不展示，避免侧栏信息过载。 */
const sizeLabel = computed(() => {
  if (!props.node || props.node.isDir || props.node.size == null) return "";
  return formatFileSizeLabel(props.node.size);
});

/** 文件最后修改时间短标签；目录不展示，避免侧栏信息过载。 */
const mtimeLabel = computed(() => {
  if (!props.node || props.node.isDir || !props.node.mtime) return "";
  return formatMtimeLabel(props.node.mtime);
});

/** 文件最后修改时间完整提示。 */
const mtimeTitle = computed(() => {
  if (!props.node || props.node.isDir || !props.node.mtime) return "";
  return formatMtimeTitle(props.node.mtime);
});
</script>

<template>
  <span v-if="node" class="file-tree-node" :title="node.path">
    <component
      :is="fileIcon.component"
      v-if="fileIcon && !node.isDir"
      class="file-tree-node__icon"
      :class="`file-tree-node__icon--${fileIcon.kind}`"
    />
    <span class="file-tree-node__name" :style="nameStyle">{{ node.name }}</span>
    <span class="file-tree-node__mtime" :title="mtimeTitle">{{ mtimeLabel }}</span>
    <span class="file-tree-node__size">{{ sizeLabel }}</span>
    <span class="file-tree-node__status" :style="statusLetter ? { color: statusColor } : {}">{{ statusLetter ?? '' }}</span>
    <span class="file-tree-node__actions">
      <template v-if="gitStatus">
        <button
          v-if="gitStatus.index && gitStatus.index !== ' ' && gitStatus.index !== '?'"
          class="file-tree-node__action-btn"
          title="Unstage"
          @click.stop="emit('unstage', node.path)"
        ><MinusOutlined /></button>
        <button
          v-else
          class="file-tree-node__action-btn"
          title="Stage"
          @click.stop="emit('stage', node.path)"
        ><PlusOutlined /></button>
      </template>
    </span>
  </span>
  <span v-else>—</span>
</template>

<style scoped>
.file-tree-node {
  --file-icon-default: var(--app-muted);
  --file-icon-image: #9b659f;
  --file-icon-markdown: #527a9d;
  --file-icon-code: #6670a8;
  --file-icon-text: #6f7882;
  --file-icon-pdf: #b65353;
  --file-icon-word: #4779ad;
  --file-icon-excel: #438165;
  --file-icon-ppt: #b86d3f;
  --file-icon-archive: #9a7a3e;
  --file-icon-database: #8b6847;
  --file-icon-config: #687681;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  min-width: 0;
}

.file-tree-node__icon {
  font-size: 14px;
  color: var(--file-icon-default);
  flex-shrink: 0;
}

.file-tree-node__icon--image { color: var(--file-icon-image); }
.file-tree-node__icon--markdown { color: var(--file-icon-markdown); }
.file-tree-node__icon--code { color: var(--file-icon-code); }
.file-tree-node__icon--text { color: var(--file-icon-text); }
.file-tree-node__icon--pdf { color: var(--file-icon-pdf); }
.file-tree-node__icon--word { color: var(--file-icon-word); }
.file-tree-node__icon--excel { color: var(--file-icon-excel); }
.file-tree-node__icon--ppt { color: var(--file-icon-ppt); }
.file-tree-node__icon--archive { color: var(--file-icon-archive); }
.file-tree-node__icon--database { color: var(--file-icon-database); }
.file-tree-node__icon--config { color: var(--file-icon-config); }

:global(:root[data-theme="dark"]) .file-tree-node {
  --file-icon-image: #c58ac9;
  --file-icon-markdown: #7fa8ca;
  --file-icon-code: #929bd0;
  --file-icon-text: #9ba5ae;
  --file-icon-pdf: #db7a7a;
  --file-icon-word: #75a3d1;
  --file-icon-excel: #72ad8f;
  --file-icon-ppt: #d69a71;
  --file-icon-archive: #c0a365;
  --file-icon-database: #b59270;
  --file-icon-config: #94a4af;
}

.file-tree-node__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-tree-node__size {
  font-size: 11px;
  color: var(--app-muted);
  flex-shrink: 0;
  width: 48px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.file-tree-node__mtime {
  font-size: 11px;
  color: var(--app-muted);
  flex-shrink: 0;
  width: 50px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}

.file-tree-node__status {
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
  width: 16px;
  text-align: center;
  margin-left: 4px;
}

.file-tree-node__actions {
  display: none;
  gap: 2px;
  flex-shrink: 0;
  margin-left: 4px;
}

.file-tree-node:hover .file-tree-node__actions {
  display: inline-flex;
}

.file-tree-node__action-btn {
  background: none;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 3px;
  cursor: pointer;
  padding: 0 3px;
  font-size: 11px;
  line-height: 1;
  color: var(--app-text);
  display: inline-flex;
  align-items: center;
}

.file-tree-node__action-btn:hover {
  background: var(--app-hover, rgba(0, 0, 0, 0.04));
}
</style>

