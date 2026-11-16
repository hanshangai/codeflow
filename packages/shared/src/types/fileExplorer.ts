import type { WorkspaceId } from "./ids.js";

/** 文件树节点 */
export type FsTreeNode = {
  name: string;
  /** workspace 相对路径 (POSIX) */
  path: string;
  isDir: boolean;
  /** 文件大小 (bytes)，目录为 undefined */
  size?: number;
  /** 最后修改时间 ISO8601 */
  mtime?: string;
  children?: FsTreeNode[];
};

export type FsTreeRequestBody = {
  workspaceId: WorkspaceId;
  /** 要展开的目录相对路径，空/"" 表示根目录 */
  dirPath?: string | null;
  /** 最大深度，默认 1（仅当前层级） */
  depth?: number | null;
  /** 是否展示名称以 "." 开头的文件或文件夹 */
  showHidden?: boolean | null;
};

export type FsTreeResponseBody = { nodes: FsTreeNode[] };

export type FsReadFileRequestBody = {
  workspaceId: WorkspaceId;
  path: string;
  /** 最大读取字节数，默认 512KB */
  maxBytes?: number | null;
};

export type FsReadFileResponseBody = {
  path: string;
  /** 解码后的文本内容，二进制文件为 null */
  content: string | null;
  isBinary: boolean;
  size: number;
  /** base64 编码的内容（仅图片等需要 base64 传输的文件） */
  base64?: string | null;
  mimeType?: string | null;
  /** 实际采用的文本解码方式；二进制文件可为空 */
  encoding?: "utf8" | "gb18030" | null;
};

export type FsSpreadsheetCellValue = string | number | boolean | null;

export type FsSpreadsheetSheetInfo = {
  name: string;
  rowCount: number;
  columnCount: number;
};

export type FsSpreadsheetPreviewRequestBody = {
  workspaceId: WorkspaceId;
  path: string;
  /** 工作表名称；为空时读取第一个工作表 */
  sheetName?: string | null;
  /** 最大预览行数，默认 200 */
  maxRows?: number | null;
  /** 最大预览列数，默认 50 */
  maxColumns?: number | null;
};

export type FsSpreadsheetPreviewResponseBody = {
  path: string;
  size: number;
  mimeType?: string | null;
  sheetName: string;
  sheets: FsSpreadsheetSheetInfo[];
  rows: FsSpreadsheetCellValue[][];
  rowCount: number;
  columnCount: number;
  maxRows: number;
  maxColumns: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
};

export type FsDocumentPreviewKind = "pdf" | "word" | "presentation";

export type FsDocumentPreviewRequestBody = {
  workspaceId: WorkspaceId;
  path: string;
};

export type FsDocumentPreviewResponseBody = {
  path: string;
  size: number;
  mimeType?: string | null;
  kind: FsDocumentPreviewKind;
  /** PDF/PPTX 使用 base64；Word 使用安全 HTML 内容。 */
  base64?: string | null;
  content?: string | null;
  truncated?: boolean;
};

export type FsDownloadFileRequestBody = {
  workspaceId: WorkspaceId;
  path: string;
};

export type FsDownloadFileResponseBody = {
  path: string;
  fileName: string;
  size: number;
  mimeType?: string | null;
  /** base64 编码的原始文件内容，用于浏览器生成下载 Blob。 */
  base64: string;
};

export type FsUploadRequestQuery = {
  workspaceId: WorkspaceId;
  /** 上传目标目录，空字符串表示工作区根目录。 */
  targetDir?: string | null;
  fileName: string;
  sizeBytes: number;
  mimeType?: string | null;
  overwrite?: boolean | null;
};

export type FsUploadResponseBody = {
  transferId: string;
  path: string;
  fileName: string;
  size: number;
};

export type FsDownloadRequestBody = {
  workspaceId: WorkspaceId;
  path: string;
};

export type FsUploadBeginRequestBody = FsUploadRequestQuery;

export type FsUploadBeginResponseBody = {
  uploadId: string;
  path: string;
  chunkSizeBytes: number;
};

export type FsUploadChunkRequestBody = {
  uploadId: string;
  offset: number;
  base64: string;
};

export type FsUploadChunkResponseBody = {
  uploadId: string;
  receivedBytes: number;
};

export type FsUploadCompleteRequestBody = {
  uploadId: string;
};

export type FsUploadCompleteResponseBody = {
  path: string;
  fileName: string;
  size: number;
  mimeType?: string | null;
};

export type FsUploadCancelRequestBody = {
  uploadId: string;
  reason?: string | null;
};

export type FsDownloadStatRequestBody = {
  workspaceId: WorkspaceId;
  path: string;
};

export type FsDownloadStatResponseBody = {
  path: string;
  fileName: string;
  size: number;
  mimeType?: string | null;
};

export type FsDownloadChunkRequestBody = {
  workspaceId: WorkspaceId;
  path: string;
  offset: number;
  length: number;
};

export type FsDownloadChunkResponseBody = {
  path: string;
  offset: number;
  bytesRead: number;
  base64: string;
  done: boolean;
};

export type FsStatRequestBody = {
  workspaceId: WorkspaceId;
  path: string;
};

export type FsStatResponseBody = {
  path: string;
  isDir: boolean;
  size: number;
  mtime: string;
  exists: boolean;
};

export type FsSearchRequestBody = {
  workspaceId: WorkspaceId;
  /** 搜索关键词；空字符串返回根目录候选。 */
  query?: string | null;
  /** 最大返回数量，默认 50，最大 100。 */
  limit?: number | null;
  /** 分页游标；当前实现为结果偏移量字符串。 */
  cursor?: string | null;
  /** 是否包含 "." 开头的路径。 */
  includeHidden?: boolean | null;
  kind?: "file" | "directory" | "all" | null;
};

export type FsSearchResult = {
  path: string;
  name: string;
  isDir: boolean;
  size?: number;
  mtime?: string;
};

export type FsSearchIndexStatus = "queued" | "building" | "ready" | "stale" | "failed" | "disabled";

export type FsSearchResponseBody = {
  results: FsSearchResult[];
  hasMore: boolean;
  nextCursor?: string | null;
  /** Client 本地文件索引状态；缺失表示仍使用旧实时搜索路径。 */
  indexStatus?: FsSearchIndexStatus;
  /** 当前索引已纳入的路径数量。 */
  indexedCount?: number;
  /** true 表示结果来自未完成/不完整索引或显式降级路径。 */
  partial?: boolean;
  /** 索引状态补充说明，供前端展示短提示。 */
  message?: string | null;
};

export type FsReindexRequestBody = {
  workspaceId: WorkspaceId;
};

export type FsReindexResponseBody = {
  indexStatus: FsSearchIndexStatus;
  indexedCount: number;
  partial: boolean;
  /** 手工重建触发后的索引状态说明。 */
  message?: string | null;
};

/** 目标 Client 本机目录树节点，path 为该 Client 上的绝对路径。 */
export type ClientDirectoryNode = {
  name: string;
  path: string;
  isDir: true;
  /** Ant Tree 懒加载提示；true 表示该目录没有可继续展开的子目录。 */
  isLeaf?: boolean;
  children?: ClientDirectoryNode[];
};

export type ClientDirectoryTreeRequestBody = {
  clientId: string;
  /** 目标 Client 上的绝对目录路径；空表示列出可选根目录。 */
  dirPath?: string | null;
  /** 兼容字段；当前目录选择器始终按 1 层懒加载。 */
  depth?: number | null;
  /** 是否展示名称以 "." 开头的目录。 */
  showHidden?: boolean | null;
};

export type ClientDirectoryTreeRpcRequestBody = Omit<ClientDirectoryTreeRequestBody, "clientId">;

export type ClientDirectoryTreeResponseBody = {
  nodes: ClientDirectoryNode[];
};
