import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const fileTreeSource = fs.readFileSync("apps/web/src/features/explorer/components/file-tree.vue", "utf8");
const explorerSidebarSource = fs.readFileSync("apps/web/src/features/explorer/components/explorer-sidebar.vue", "utf8");

test("文件树目录右键菜单把当前目录交给统一上传流程", () => {
  assert.match(fileTreeSource, /UploadOutlined/u);
  assert.match(fileTreeSource, /\(e: "uploadToDirectory", path: string\): void/u);
  assert.match(fileTreeSource, /<a-menu-item v-else @click="emit\('uploadToDirectory', record\.fsNode\.path\)">/u);
  assert.match(fileTreeSource, /上传文件到此目录/u);
  assert.match(explorerSidebarSource, /@upload-to-directory="onUploadToDirectory"/u);
});

test("目录右键上传优先使用锁定目录，工具栏上传继续使用原有目录推断", () => {
  assert.match(explorerSidebarSource, /const uploadTargetDir = ref<string \| null>\(null\)/u);
  assert.match(explorerSidebarSource, /async function openUploadPicker\(targetDir\?: string\): Promise<void>/u);
  assert.match(explorerSidebarSource, /function onUploadToDirectory\(targetDir: string\): void/u);
  assert.match(explorerSidebarSource, /const selectedTargetDir = uploadTargetDir\.value/u);
  assert.match(explorerSidebarSource, /const targetDir = selectedTargetDir \?\? resolveUploadTargetDir\(\)/u);
  assert.match(explorerSidebarSource, /targetDir,\s+file,\s+overwrite/u);
});

test("文件树添加路径菜单显示加号图标", () => {
  assert.match(fileTreeSource, /import \{ DownloadOutlined, FileTextOutlined, PlusOutlined, UploadOutlined \} from "@ant-design\/icons-vue";/u);
  assert.match(fileTreeSource, /<a-menu-item @click="enqueueRelativePath\(record\.fsNode\.path\)">\s*<PlusOutlined \/>/u);
});

test("文件树下载和文本附件菜单显示对应图标", () => {
  assert.match(fileTreeSource, /DownloadOutlined/u);
  assert.match(fileTreeSource, /FileTextOutlined/u);
  assert.match(fileTreeSource, /@click="downloadNodeFile\(record\.fsNode\)">\s*<DownloadOutlined \/>\s*下载文件/u);
  assert.match(fileTreeSource, /@click="enqueueWorkspaceFile\(record\.fsNode\)">\s*<FileTextOutlined \/>\s*添加为文本附件/u);
});
