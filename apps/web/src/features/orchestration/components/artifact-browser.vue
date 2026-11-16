<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { FullscreenExitOutlined, FullscreenOutlined } from "@ant-design/icons-vue";
import { type Artifact, type ArtifactFileEntry, type WorkspaceId } from "@codeflowai/shared";

import { listOrchArtifactFiles } from "../../../api/orchestration";
import { trackProductEvent } from "../../../analytics/analytics";
import { useApiContext } from "../../../composables/useApiContext";
import { useOrchestrationStore } from "../../../store/orchestration";
import DiffViewer from "../../chat/components/diff-viewer.vue";
import ArtifactFilePreview from "./artifact-file-preview.vue";
import {
  buildArtifactPresentation,
  isDocumentArtifactPath,
  isImageArtifactPath,
  isSpreadsheetArtifactPath,
  type ArtifactPresentationFile,
} from "./artifact-preview-utils";

defineOptions({ name: "ArtifactBrowser" });

type ArtifactCompareDiffPayload = {
  original: string;
  modified: string;
  filePath: string;
};

const props = defineProps<{ workspaceId: WorkspaceId }>();

const orch = useOrchestrationStore();
const { ctx } = useApiContext();
const compareOpen = ref(false);
const compareFullscreen = ref(false);
const metaDrawerOpen = ref(false);
const showCurrentRaw = ref(false);
const selectedPreviewPath = ref<string | null>(null);
const compareBaseArtifactId = ref<string | null>(null);
const artifactFilesByArtifactId = ref<Record<string, ArtifactFileEntry[]>>({});

watch(() => orch.selectedInstanceId, async (instanceId) => {
  if (!instanceId) return;
  if (orch.selectedInstance?.id === instanceId && orch.selectedInstanceArtifacts.length) return;
  await orch.loadInstance(ctx.value, props.workspaceId, instanceId);
}, { immediate: true });

watch(() => orch.selectedArtifactId, async (artifactId, previousArtifactId) => {
  if (!artifactId) {
    selectedPreviewPath.value = null;
    return;
  }
  if (artifactId !== previousArtifactId) {
    showCurrentRaw.value = false;
    metaDrawerOpen.value = false;
    selectedPreviewPath.value = null;
  }
  await ensureArtifactContent(artifactId);
}, { immediate: true });

const nodeLabelMap = computed(() => new Map((orch.selectedInstance?.workflowSnapshot?.nodes ?? []).map((node) => [node.id, node.label])));

const groupedArtifacts = computed(() => {
  const groups = new Map<string, Artifact[]>();
  for (const artifact of orch.selectedInstanceArtifacts) {
    const key = artifact.nodeId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(artifact);
  }
  return Array.from(groups.entries()).map(([nodeId, artifacts]) => ({
    nodeId,
    artifacts: latestArtifacts(artifacts),
  }));
});

const flatArtifacts = computed(() =>
  groupedArtifacts.value.flatMap((group) => group.artifacts),
);

const selectedArtifact = computed(() => orch.selectedArtifact);
const selectedArtifactFiles = computed(() => {
  const artifactId = selectedArtifact.value?.id;
  if (!artifactId) return [] as ArtifactFileEntry[];
  return artifactFilesByArtifactId.value[artifactId] ?? [];
});
const selectedPresentation = computed(() => buildArtifactPresentation(selectedArtifact.value, selectedArtifactFiles.value));
const selectedPreviewItems = computed<ArtifactPresentationFile[]>(() =>
  selectedPresentation.value.files.length ? selectedPresentation.value.files : [selectedPresentation.value],
);
const selectedNodeLabel = computed(() => {
  const artifact = selectedArtifact.value;
  if (!artifact) return "-";
  return nodeLabelMap.value.get(artifact.nodeId) ?? artifact.nodeId;
});

const compareBaseVersions = computed(() => {
  const current = selectedArtifact.value;
  if (!current) return [] as Artifact[];
  return orch.selectedInstanceArtifacts
    .filter((artifact) => artifact.nodeId === current.nodeId && artifact.kind === current.kind && artifact.version < current.version)
    .sort((left, right) => right.version - left.version || right.updatedAt - left.updatedAt);
});
const previousVersion = computed(() => {
  const versions = compareBaseVersions.value;
  return versions.find((artifact) => artifact.id === compareBaseArtifactId.value) ?? versions[0] ?? null;
});
const previousArtifactFiles = computed(() => {
  const artifactId = previousVersion.value?.id;
  if (!artifactId) return [] as ArtifactFileEntry[];
  return artifactFilesByArtifactId.value[artifactId] ?? [];
});
const previousPresentation = computed(() => buildArtifactPresentation(previousVersion.value, previousArtifactFiles.value));
const activeSelectedPreview = computed(() => {
  if (!selectedPresentation.value.files.length) return selectedPresentation.value;
  return selectedPresentation.value.files.find((file) => file.filePath === selectedPreviewPath.value)
    ?? selectedPresentation.value.files[0]
    ?? selectedPresentation.value;
});
const activePreviousPreview = computed(() => {
  if (!previousPresentation.value.files.length) return previousPresentation.value;
  return previousPresentation.value.files.find((file) => file.filePath === selectedPreviewPath.value)
    ?? previousPresentation.value.files[0]
    ?? previousPresentation.value;
});
const previousPreviewForDiff = computed(() => resolvePreviousPreviewForDiff(
  previousPresentation.value,
  activeSelectedPreview.value.filePath,
));
const compareDiffPayload = computed<ArtifactCompareDiffPayload | null>(() => {
  const previousPreview = previousPreviewForDiff.value;
  const currentPreview = activeSelectedPreview.value;
  if (!previousPreview) return null;
  if (!isTextDiffablePreview(currentPreview) || !isTextDiffablePreview(previousPreview)) return null;
  return {
    original: previousPreview.content,
    modified: currentPreview.content,
    filePath: currentPreview.filePath,
  };
});
const compareFallbackReason = computed(() => {
  if (compareDiffPayload.value) return "";
  if (!previousVersion.value) return "";
  const previousPreview = previousPreviewForDiff.value;
  if (!previousPreview) return "所选对比版本没有同路径文件，暂时只能并排查看。";
  if (isImageArtifactPath(activeSelectedPreview.value.filePath) || isImageArtifactPath(previousPreview.filePath)) {
    return "图片类产出暂不支持文本 diff，已回退到并排预览。";
  }
  if (isDocumentArtifactPath(activeSelectedPreview.value.filePath) || isDocumentArtifactPath(previousPreview.filePath)) {
    return "文档类产出暂不支持文本 diff，已回退到并排预览。";
  }
  if (isSpreadsheetArtifactPath(activeSelectedPreview.value.filePath) || isSpreadsheetArtifactPath(previousPreview.filePath)) {
    return "表格类产出暂不支持文本 diff，已回退到并排预览。";
  }
  return "当前产出内容暂不支持文本 diff，已回退到并排预览。";
});
const compareFullscreenTitle = computed(() => compareFullscreen.value ? "还原结果版本对比" : "全屏查看结果版本对比");
const compareModalWidth = computed(() => compareFullscreen.value ? "100vw" : 1320);
const compareModalBodyStyle = computed(() =>
  compareFullscreen.value
    ? { padding: "16px 20px", height: "calc(100dvh - 56px)", maxHeight: "calc(100dvh - 56px)", overflow: "hidden" }
    : { padding: "16px 20px", maxHeight: "calc(100vh - 140px)", overflowY: "auto" });
const compareModalWrapClassName = computed(() =>
  compareFullscreen.value
    ? "artifact-browser__compare-modal-wrap artifact-browser__compare-modal-wrap--fullscreen"
    : "artifact-browser__compare-modal-wrap");
const visibleSelectedPreviewItems = computed(() =>
  resolveVisiblePreviewItems(selectedPreviewItems.value, activeSelectedPreview.value.filePath, 4),
);
const overflowSelectedPreviewItems = computed(() => {
  const visibleKeys = new Set(visibleSelectedPreviewItems.value.map((file) => file.filePath));
  return selectedPreviewItems.value.filter((file) => !visibleKeys.has(file.filePath));
});

watch(flatArtifacts, (artifacts) => {
  if (!artifacts.length) {
    orch.selectedArtifactId = null;
    return;
  }
  if (!orch.selectedArtifactId || !artifacts.some((artifact) => artifact.id === orch.selectedArtifactId)) {
    orch.selectedArtifactId = artifacts[0]?.id ?? null;
  }
}, { immediate: true });

watch(selectedPresentation, (presentation) => {
  if (!presentation.files.length) {
    selectedPreviewPath.value = null;
    return;
  }
  if (!selectedPreviewPath.value || !presentation.files.some((file) => file.filePath === selectedPreviewPath.value)) {
    selectedPreviewPath.value = presentation.files[0]?.filePath ?? null;
  }
}, { immediate: true });

watch(
  () => [selectedArtifact.value?.id ?? null, compareBaseVersions.value.map((artifact) => artifact.id).join("|")] as const,
  () => {
    const versions = compareBaseVersions.value;
    if (!versions.length) {
      compareBaseArtifactId.value = null;
      return;
    }
    if (!versions.some((artifact) => artifact.id === compareBaseArtifactId.value)) {
      compareBaseArtifactId.value = versions[0]?.id ?? null;
    }
  },
  { immediate: true },
);

watch(
  () => [selectedArtifact.value?.id ?? null, previousVersion.value?.id ?? null] as const,
  ([currentArtifactId, previousArtifactId]) => {
    void ensureArtifactContent(currentArtifactId);
    void ensureArtifactContent(previousArtifactId);
    void ensureArtifactFiles(currentArtifactId);
    void ensureArtifactFiles(previousArtifactId);
  },
  { immediate: true },
);

/** 关闭结果版本对比弹框并恢复普通窗口尺寸。 */
function closeCompareModal(): void {
  compareFullscreen.value = false;
  compareOpen.value = false;
}

/** 切换结果版本对比弹框全屏状态，保留当前对比版本和滚动上下文。 */
function toggleCompareFullscreen(): void {
  compareFullscreen.value = !compareFullscreen.value;
}

function latestArtifacts(artifacts: Artifact[]): Artifact[] {
  const latestByKey = new Map<string, Artifact>();
  const sorted = [...artifacts].sort((left, right) => right.version - left.version || right.updatedAt - left.updatedAt);
  for (const artifact of sorted) {
    const key = `${artifact.nodeId}::${artifact.kind}`;
    if (!latestByKey.has(key)) {
      latestByKey.set(key, artifact);
    }
  }
  return Array.from(latestByKey.values()).sort((left, right) => right.updatedAt - left.updatedAt || left.kind.localeCompare(right.kind));
}

/** 按当前文件路径查找所选历史版本的同名文件，避免把不同文件误当作 diff 两端。 */
function resolvePreviousPreviewForDiff(
  presentation: ReturnType<typeof buildArtifactPresentation>,
  currentFilePath: string,
): ArtifactPresentationFile | null {
  if (!presentation.files.length) return presentation;
  return presentation.files.find((file) => file.filePath === currentFilePath) ?? null;
}

/** 只有可直接读取文本内容的产出才进入 Monaco diff；图片等二进制预览走兜底双栏。 */
function isTextDiffablePreview(preview: ArtifactPresentationFile): boolean {
  return !isImageArtifactPath(preview.filePath)
    && !isSpreadsheetArtifactPath(preview.filePath)
    && !isDocumentArtifactPath(preview.filePath);
}

/** 为预览组件生成重建 key，切换文件、版本或原文模式时重置内部滚动容器。 */
function previewComponentKey(
  artifactId: string | null | undefined,
  preview: ArtifactPresentationFile,
  showRaw: boolean,
): string {
  return [
    artifactId ?? "none",
    preview.filePath,
    preview.workspacePreviewPath ?? "",
    preview.renderMode,
    showRaw ? "raw" : "render",
  ].join("::");
}

async function ensureArtifactFiles(artifactId: string | null) {
  if (!artifactId) return;
  if (Object.prototype.hasOwnProperty.call(artifactFilesByArtifactId.value, artifactId)) return;
  try {
    const res = await listOrchArtifactFiles(ctx.value, { workspaceId: props.workspaceId, artifactId });
    artifactFilesByArtifactId.value = {
      ...artifactFilesByArtifactId.value,
      [artifactId]: res.ok ? (res as any).files ?? [] : [],
    };
  } catch {
    artifactFilesByArtifactId.value = {
      ...artifactFilesByArtifactId.value,
      [artifactId]: [],
    };
  }
}

/** 仅在用户打开结果或对比版本时读取正文，列表阶段只保留产物元数据。 */
async function ensureArtifactContent(artifactId: string | null): Promise<void> {
  if (!artifactId) return;
  const artifact = orch.selectedInstanceArtifacts.find((item) => item.id === artifactId);
  if (!artifact || String(artifact.contentJson ?? "").trim()) return;
  try {
    const loaded = await orch.loadArtifact(ctx.value, props.workspaceId, artifactId, { loadFiles: false });
    if (!loaded) message.error(`加载产物正文失败：${artifactId}`);
  } catch (error) {
    message.error(`加载产物正文失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function refreshCurrentInstance() {
  if (!orch.selectedInstanceId) return;
  orch.loadInstance(ctx.value, props.workspaceId, orch.selectedInstanceId).catch((error) => {
    message.error(error instanceof Error ? error.message : "刷新结果失败");
  });
}

/** 选择一个结果产物，只上报产物类型和状态，不上报标题或路径。 */
function selectArtifact(artifact: Artifact): void {
  orch.selectedArtifactId = artifact.id;
  trackProductEvent("artifact_open", {
    kind: artifact.kind,
    version: artifact.version,
    status: artifact.status ?? null,
    payload_mode: artifact.payloadMode ?? null,
    workspace_status: artifact.workspaceStatus ?? null,
    persistence_mode: artifact.persistenceMode ?? null,
  });
}

/** 打开结果详情抽屉，不上传结果 ID 或工作区路径。 */
function openArtifactMetaDrawer(): void {
  metaDrawerOpen.value = true;
  trackProductEvent("artifact_meta_open", {
    kind: selectedArtifact.value?.kind ?? null,
    payload_mode: selectedArtifact.value?.payloadMode ?? null,
  });
}

/** 打开结果版本对比弹框，仅记录可对比版本是否存在。 */
function openArtifactCompareModal(): void {
  compareOpen.value = true;
  trackProductEvent("artifact_compare_open", {
    kind: selectedArtifact.value?.kind ?? null,
    has_previous_version: Boolean(previousVersion.value),
  });
}

/** 切换 Markdown 原文/渲染预览状态，不上传正文。 */
function toggleRawPreview(): void {
  showCurrentRaw.value = !showCurrentRaw.value;
  trackProductEvent("artifact_raw_toggle", {
    kind: selectedArtifact.value?.kind ?? null,
    raw_enabled: showCurrentRaw.value,
  });
}

/** 切换多文件结果的当前预览项，不上传文件名或路径。 */
function selectPreviewFile(file: ArtifactPresentationFile): void {
  selectedPreviewPath.value = file.filePath;
  trackProductEvent("artifact_preview_file_select", {
    render_mode: file.renderMode,
    preview_kind: previewKindLabel(file),
    has_workspace_preview: Boolean(file.workspacePreviewPath),
  });
}

function artifactTitle(artifact: Artifact | null): string {
  if (!artifact) return "-";
  return artifact.title || artifact.kind;
}

function artifactSummary(artifact: Artifact | null): string {
  if (!artifact) return "";
  return [
    artifact.kind,
    `第 ${artifact.version} 版`,
    artifactStatusLabel(artifact.status),
    payloadModeLabel(artifact.payloadMode),
    workspaceStatusLabel(artifact.workspaceStatus),
  ].join(" · ");
}

function artifactStatusLabel(status: string | null | undefined): string {
  const map: Record<string, string> = {
    draft: "草稿",
    approved: "已通过",
    rejected: "已驳回",
    superseded: "已替代",
  };
  return map[String(status ?? "")] ?? String(status ?? "-");
}

function persistenceModeLabel(mode: string | null | undefined): string {
  if (mode === "workspace-only") return "只保存到工作区";
  if (mode === "dual-write") return "DB + 工作区";
  if (mode === "db-only") return "只保存到数据库";
  return "默认策略";
}

function payloadModeLabel(mode: string | null | undefined): string {
  if (mode === "structured") return "结构化结果";
  if (mode === "file") return "单文件";
  if (mode === "file-set") return "多文件";
  return "文本";
}

function workspaceStatusLabel(status: string | null | undefined): string {
  const map: Record<string, string> = {
    none: "未写入工作区",
    staging: "已写入 · 待审核",
    published: "已通过",
    discarded: "已驳回",
  };
  return map[String(status ?? "none")] ?? String(status ?? "-");
}

function previewFilename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function previewFileBadge(filePath: string): string {
  const fileName = previewFilename(filePath);
  const ext = fileName.includes(".") ? fileName.split(".").pop() : "";
  const normalized = String(ext ?? "").trim().toLowerCase();
  if (!normalized) return "FILE";
  return normalized.slice(0, 4).toUpperCase();
}

function previewKindLabel(preview: ArtifactPresentationFile): string {
  if (isImageArtifactPath(preview.filePath)) return "图片";
  if (isSpreadsheetArtifactPath(preview.filePath)) return "表格";
  if (isDocumentArtifactPath(preview.filePath)) return "文档";
  if (preview.renderMode === "markdown") return "Markdown";
  if (preview.renderMode === "html") return "HTML";
  return "文本";
}

function resolveVisiblePreviewItems(
  items: ArtifactPresentationFile[],
  activePath: string,
  maxVisible: number,
): ArtifactPresentationFile[] {
  if (items.length <= maxVisible) return items;
  const activeIndex = Math.max(items.findIndex((item) => item.filePath === activePath), 0);
  if (activeIndex < maxVisible) {
    return items.slice(0, maxVisible);
  }
  return [
    ...items.slice(0, Math.max(maxVisible - 1, 0)),
    items[activeIndex]!,
  ];
}
</script>

<template>
  <div v-if="orch.selectedInstance" class="artifact-browser">
    <div class="artifact-browser__body">
      <aside class="artifact-browser__list">
        <div class="artifact-browser__list-header">
          <button class="artifact-browser__ghost" type="button" @click="refreshCurrentInstance">刷新</button>
        </div>

        <div class="artifact-browser__list-body">
          <div v-if="groupedArtifacts.length === 0" class="artifact-browser__empty">当前执行还没有产出结果</div>
          <div v-for="group in groupedArtifacts" :key="group.nodeId" class="artifact-browser__group">
            <div class="artifact-browser__group-title">{{ nodeLabelMap.get(group.nodeId) ?? group.nodeId }}</div>
            <button
              v-for="artifact in group.artifacts"
              :key="artifact.id"
              class="artifact-browser__artifact-item"
              :class="{ 'artifact-browser__artifact-item--selected': artifact.id === orch.selectedArtifactId }"
              @click="selectArtifact(artifact)"
            >
              <strong>{{ artifactTitle(artifact) }}</strong>
              <span>{{ artifact.kind }}</span>
              <small>第 {{ artifact.version }} 版 · {{ artifactStatusLabel(artifact.status) }}</small>
            </button>
          </div>
        </div>
      </aside>

      <section class="artifact-browser__detail">
        <div v-if="selectedArtifact" class="artifact-browser__detail-card">
          <div class="artifact-browser__detail-head">
            <div>
              <span class="artifact-browser__eyebrow">{{ selectedNodeLabel }}</span>
              <h4>{{ artifactTitle(selectedArtifact) }}</h4>
              <p>{{ artifactSummary(selectedArtifact) }}<template v-if="selectedPresentation.files.length"> · {{ selectedPresentation.files.length }} 个文件</template></p>
            </div>
            <div class="artifact-browser__detail-actions">
              <button
                class="artifact-browser__ghost"
                type="button"
                @click="openArtifactMetaDrawer"
              >
                结果详情
              </button>
              <button
                v-if="previousVersion"
                class="artifact-browser__ghost"
                type="button"
                @click="openArtifactCompareModal"
              >
                对比版本
              </button>
              <button
                v-if="activeSelectedPreview.renderMode === 'markdown'"
                class="artifact-browser__ghost"
                type="button"
                @click="toggleRawPreview"
              >
                {{ showCurrentRaw ? "渲染预览" : "查看原文" }}
              </button>
            </div>
          </div>

          <div v-if="selectedPreviewItems.length > 1" class="artifact-browser__file-rail">
            <div class="artifact-browser__file-tabs">
              <button
                v-for="file in visibleSelectedPreviewItems"
                :key="file.filePath"
                type="button"
                class="artifact-browser__file-tab"
                :class="{ 'artifact-browser__file-tab--active': file.filePath === activeSelectedPreview.filePath }"
                :title="file.filePath"
                @click="selectPreviewFile(file)"
              >
                <span class="artifact-browser__file-tab-badge">{{ previewFileBadge(file.filePath) }}</span>
                <span class="artifact-browser__file-tab-name">{{ previewFilename(file.filePath) }}</span>
                <small>{{ previewKindLabel(file) }}</small>
              </button>
            </div>
            <a-dropdown
              v-if="overflowSelectedPreviewItems.length"
              :trigger="['click']"
              placement="bottomRight"
              overlay-class-name="artifact-browser__overflow-dropdown"
            >
              <button type="button" class="artifact-browser__overflow-trigger">
                更多 {{ overflowSelectedPreviewItems.length }} ▾
              </button>
              <template #overlay>
                <a-menu selectable="false" class="artifact-browser__overflow-menu">
                  <a-menu-item
                    v-for="file in overflowSelectedPreviewItems"
                    :key="file.filePath"
                    @click="selectPreviewFile(file)"
                  >
                    <div class="artifact-browser__overflow-item">
                      <span class="artifact-browser__file-tab-badge">{{ previewFileBadge(file.filePath) }}</span>
                      <div class="artifact-browser__overflow-meta">
                        <strong>{{ previewFilename(file.filePath) }}</strong>
                        <small>{{ file.filePath }}</small>
                      </div>
                    </div>
                  </a-menu-item>
                </a-menu>
              </template>
            </a-dropdown>
          </div>

          <div class="artifact-browser__preview">
            <ArtifactFilePreview
              :key="previewComponentKey(selectedArtifact.id, activeSelectedPreview, showCurrentRaw)"
              :workspace-id="workspaceId"
              :preview="activeSelectedPreview"
              :show-raw-markdown="showCurrentRaw"
              empty-markdown-text="*当前结果没有可预览正文*"
            />
          </div>
        </div>

        <div v-else class="artifact-browser__empty">从左侧选择一项结果查看详情</div>
      </section>
    </div>

    <a-modal
      :open="compareOpen"
      :footer="null"
      :width="compareModalWidth"
      :body-style="compareModalBodyStyle"
      :wrap-class-name="compareModalWrapClassName"
      destroy-on-close
      @cancel="closeCompareModal"
    >
      <template #title>
        <div class="artifact-browser__modal-titlebar">
          <span>结果版本对比</span>
          <a-tooltip :title="compareFullscreenTitle">
            <a-button size="small" type="text" :aria-label="compareFullscreenTitle" @click.stop="toggleCompareFullscreen">
              <component :is="compareFullscreen ? FullscreenExitOutlined : FullscreenOutlined" />
            </a-button>
          </a-tooltip>
        </div>
      </template>
      <div
        v-if="selectedArtifact && previousVersion"
        class="artifact-browser__compare-modal"
        :class="{ 'artifact-browser__compare-modal--fullscreen': compareFullscreen }"
      >
        <template v-if="compareDiffPayload">
          <div class="artifact-browser__compare-diff">
            <div class="artifact-browser__compare-head artifact-browser__compare-head--diff">
              <div>
                <strong>真实差异</strong>
                <span>
                  第 {{ previousVersion.version }} 版 · {{ artifactStatusLabel(previousVersion.status) }}
                  → 第 {{ selectedArtifact.version }} 版 · {{ artifactStatusLabel(selectedArtifact.status) }}
                </span>
              </div>
              <label class="artifact-browser__compare-version-control">
                <span>选择</span>
                <select v-model="compareBaseArtifactId">
                  <option v-for="artifact in compareBaseVersions" :key="artifact.id" :value="artifact.id">
                    第 {{ artifact.version }} 版 · {{ artifactStatusLabel(artifact.status) }}
                  </option>
                </select>
              </label>
              <code>{{ compareDiffPayload.filePath }}</code>
            </div>
            <div class="artifact-browser__compare-diff-body">
              <DiffViewer
                :original="compareDiffPayload.original"
                :modified="compareDiffPayload.modified"
                :file-path="compareDiffPayload.filePath"
                :hide-unchanged="true"
              />
            </div>
          </div>
        </template>

        <template v-else>
          <div v-if="compareFallbackReason" class="artifact-browser__compare-note">
            {{ compareFallbackReason }}
          </div>
          <div class="artifact-browser__compare-panes">
            <div class="artifact-browser__compare-pane">
              <div class="artifact-browser__compare-head">
                <strong>当前版本</strong>
                <span>第 {{ selectedArtifact.version }} 版 · {{ artifactStatusLabel(selectedArtifact.status) }}</span>
              </div>
              <div class="artifact-browser__compare-body">
                <ArtifactFilePreview
                  :key="previewComponentKey(selectedArtifact.id, activeSelectedPreview, showCurrentRaw)"
                  :workspace-id="workspaceId"
                  :preview="activeSelectedPreview"
                  :show-raw-markdown="showCurrentRaw"
                  empty-markdown-text="*当前结果没有可预览正文*"
                />
              </div>
            </div>

            <div class="artifact-browser__compare-pane">
              <div class="artifact-browser__compare-head">
                <strong>对比版本</strong>
                <label class="artifact-browser__compare-version-control">
                  <span>选择</span>
                  <select v-model="compareBaseArtifactId">
                    <option v-for="artifact in compareBaseVersions" :key="artifact.id" :value="artifact.id">
                      第 {{ artifact.version }} 版 · {{ artifactStatusLabel(artifact.status) }}
                    </option>
                  </select>
                </label>
              </div>
              <div class="artifact-browser__compare-body">
                <ArtifactFilePreview
                  :key="previewComponentKey(previousVersion?.id, activePreviousPreview, false)"
                  :workspace-id="workspaceId"
                  :preview="activePreviousPreview"
                  :show-raw-markdown="false"
                  empty-markdown-text="*对比版本没有可预览正文*"
                />
              </div>
            </div>
          </div>
        </template>
      </div>
      <div v-else class="artifact-browser__empty">当前结果没有历史版本可对比。</div>
    </a-modal>

    <a-drawer
      :open="metaDrawerOpen"
      placement="right"
      title="结果详情"
      :width="420"
      :body-style="{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }"
      destroy-on-close
      @close="metaDrawerOpen = false"
    >
      <template v-if="selectedArtifact">
        <div class="artifact-browser__drawer-group">
          <div class="artifact-browser__meta-row">
            <span>标题</span>
            <code>{{ artifactTitle(selectedArtifact) }}</code>
          </div>
          <div class="artifact-browser__meta-row">
            <span>所属节点</span>
            <code>{{ selectedNodeLabel }}</code>
          </div>
          <div class="artifact-browser__meta-row">
            <span>结果 ID</span>
            <code>{{ selectedArtifact.id }}</code>
          </div>
          <div class="artifact-browser__meta-row">
            <span>状态</span>
            <code>{{ artifactStatusLabel(selectedArtifact.status) }}</code>
          </div>
          <div class="artifact-browser__meta-row">
            <span>数据形式</span>
            <code>{{ payloadModeLabel(selectedArtifact.payloadMode) }}</code>
          </div>
          <div class="artifact-browser__meta-row">
            <span>保存方式</span>
            <code>{{ persistenceModeLabel(selectedArtifact.persistenceMode) }}</code>
          </div>
          <div class="artifact-browser__meta-row">
            <span>工作区状态</span>
            <code>{{ workspaceStatusLabel(selectedArtifact.workspaceStatus) }}</code>
          </div>
          <div class="artifact-browser__meta-row">
            <span>工作区路径</span>
            <code>{{ selectedArtifact.publishedPath || selectedArtifact.stagingPath || "-" }}</code>
          </div>
          <div
            v-for="(value, key) in selectedArtifact.metadata ?? {}"
            :key="key"
            class="artifact-browser__meta-row"
          >
            <span>{{ key }}</span>
            <code>{{ value }}</code>
          </div>
        </div>

        <div v-if="selectedArtifactFiles.length" class="artifact-browser__drawer-group">
          <strong class="artifact-browser__drawer-title">文件清单（{{ selectedArtifactFiles.length }}）</strong>
          <div v-for="file in selectedArtifactFiles" :key="file.id" class="artifact-browser__meta-row">
            <span>{{ file.relPath }}</span>
            <code>{{ workspaceStatusLabel(file.status) }} · {{ file.publishedPath || file.stagingPath || "-" }}</code>
          </div>
        </div>
      </template>
    </a-drawer>
  </div>

  <div v-else class="artifact-browser__empty">先在左侧选择一条执行记录，再查看该次执行的结果。</div>
</template>

<style scoped>
.artifact-browser {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 100%;
  min-height: 0;
}

.artifact-browser__ghost {
  min-height: 34px;
  padding: 7px 12px;
  border-radius: 10px;
  border: 1px solid var(--app-border, #d9d9d9);
  background: linear-gradient(180deg, color-mix(in srgb, var(--app-bg, #fff) 95%, #f7f9fc), var(--app-bg, #fff));
  cursor: pointer;
  font-size: 12px;
}

.artifact-browser__body {
  flex: 1;
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  gap: 12px;
  min-height: 0;
}

.artifact-browser__list,
.artifact-browser__detail-card {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 16px;
  padding: 12px;
  background: transparent;
  box-shadow: 0 10px 26px rgba(15, 23, 42, 0.04);
}

.artifact-browser__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow: hidden;
}

.artifact-browser__list-header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--app-border, #e8e8e8);
}

.artifact-browser__list-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.artifact-browser__group + .artifact-browser__group {
  margin-top: 12px;
}

.artifact-browser__group-title {
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--app-muted, #666);
}

.artifact-browser__artifact-item {
  width: 100%;
  margin-bottom: 6px;
  padding: 8px 10px;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 12px;
  background: var(--app-bg, #fff);
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
}

.artifact-browser__artifact-item strong {
  font-size: 13px;
}

.artifact-browser__artifact-item span,
.artifact-browser__artifact-item small {
  font-size: 11px;
  color: var(--app-muted, #666);
}

.artifact-browser__artifact-item--selected {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 55%, var(--app-border, #e8e8e8));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, #fff);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-primary, #1677ff) 18%, transparent);
}

.artifact-browser__detail {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex: 1 1 auto;
}

.artifact-browser__detail-card {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 10px;
  min-width: 0;
  min-height: 0;
}

.artifact-browser__detail-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
}

.artifact-browser__eyebrow {
  display: inline-flex;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 700;
  color: var(--app-muted, #667085);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.artifact-browser__detail-head h4 {
  margin: 0 0 6px;
  font-size: 16px;
}

.artifact-browser__detail-head p {
  margin: 0;
  font-size: 12px;
  color: var(--app-muted, #666);
}

.artifact-browser__detail-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.artifact-browser__file-rail {
  display: flex;
  align-items: stretch;
  gap: 8px;
  min-width: 0;
}

.artifact-browser__file-tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 8px;
  overflow: hidden;
}

.artifact-browser__file-tab,
.artifact-browser__overflow-trigger {
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 14px;
  background: var(--app-bg, #fff);
  color: var(--app-text, #1f2937);
  padding: 8px 10px;
  cursor: pointer;
}

.artifact-browser__file-tab {
  flex: 1 1 0;
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: auto auto;
  align-items: center;
  gap: 2px 8px;
  text-align: left;
}

.artifact-browser__file-tab--active {
  border-color: color-mix(in srgb, var(--app-primary, #1677ff) 55%, var(--app-border, #d9d9d9));
  background: color-mix(in srgb, var(--app-primary, #1677ff) 8%, #fff);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--app-primary, #1677ff) 18%, transparent);
}

.artifact-browser__file-tab-badge {
  grid-row: 1 / span 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 42px;
  height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-primary, #1677ff) 10%, var(--app-bg, #fff));
  color: var(--app-primary, #1677ff);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.artifact-browser__file-tab-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
}

.artifact-browser__file-tab small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--app-muted, #667085);
}

.artifact-browser__overflow-trigger {
  flex: 0 0 auto;
  min-width: 104px;
  font-size: 12px;
  font-weight: 600;
}

.artifact-browser__overflow-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 240px;
}

.artifact-browser__overflow-meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.artifact-browser__overflow-meta strong,
.artifact-browser__overflow-meta small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-browser__overflow-meta strong {
  font-size: 12px;
}

.artifact-browser__overflow-meta small {
  font-size: 11px;
  color: var(--app-muted, #667085);
}

:deep(.artifact-browser__overflow-dropdown .ant-dropdown-menu) {
  padding: 6px;
  border-radius: 14px;
}

:deep(.artifact-browser__overflow-dropdown .ant-dropdown-menu-item) {
  padding: 8px 10px;
  border-radius: 10px;
}

.artifact-browser__preview {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 14px;
  background: var(--app-bg, #fff);
}

.artifact-browser__preview :deep(.markdown-preview),
.artifact-browser__preview :deep(.markdown-preview__render-area),
.artifact-browser__preview :deep(.markdown-preview__content) {
  min-width: 0;
}

.artifact-browser__preview :deep(.markdown) {
  overflow-wrap: anywhere;
}

.artifact-browser__preview :deep(.markdown table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
}

.artifact-browser__preview :deep(.markdown th),
.artifact-browser__preview :deep(.markdown td),
.artifact-browser__preview :deep(.markdown code) {
  overflow-wrap: anywhere;
}

.artifact-browser__preview :deep(.markdown pre),
.artifact-browser__preview :deep(.code-block) {
  max-width: 100%;
  min-width: 0;
}

.artifact-browser__drawer-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.artifact-browser__drawer-title {
  font-size: 13px;
}

.artifact-browser__meta-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--app-hover-bg, #fafafa);
}

.artifact-browser__meta-row span {
  font-size: 11px;
  color: var(--app-muted, #666);
}

.artifact-browser__meta-row code {
  white-space: pre-wrap;
  word-break: break-word;
}

.artifact-browser__modal-titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: calc(100% - 44px);
  min-width: 0;
}

.artifact-browser__modal-titlebar span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.artifact-browser__compare-modal {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.artifact-browser__compare-panes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  min-height: 0;
}

.artifact-browser__compare-diff {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 14px;
  overflow: hidden;
  background: var(--app-bg, #fff);
  min-height: 0;
}

.artifact-browser__compare-pane {
  border: 1px solid var(--app-border, #e8e8e8);
  border-radius: 14px;
  overflow: hidden;
  background: var(--app-bg, #fff);
  min-height: 0;
}

.artifact-browser__compare-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--app-border, #e8e8e8);
  background: color-mix(in srgb, var(--app-bg, #fff) 96%, #fafbfd);
  font-size: 12px;
}

.artifact-browser__compare-head--diff {
  align-items: flex-start;
}

.artifact-browser__compare-head--diff > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.artifact-browser__compare-version-control {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--app-muted, #667085);
}

.artifact-browser__compare-version-control select {
  min-height: 28px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 8px;
  background: var(--app-bg, #fff);
  color: var(--app-text, #1f2937);
  font-size: 12px;
}

.artifact-browser__compare-head code {
  min-width: 0;
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-muted, #667085);
}

.artifact-browser__compare-body {
  height: min(62vh, 720px);
  overflow: hidden;
}

.artifact-browser__compare-diff-body {
  height: min(66vh, 760px);
  min-height: 420px;
}

:global(.artifact-browser__compare-modal-wrap--fullscreen.ant-modal-wrap) {
  overflow: hidden !important;
}

:global(.artifact-browser__compare-modal-wrap--fullscreen .ant-modal) {
  width: 100vw !important;
  max-width: 100vw !important;
  height: 100dvh !important;
  min-height: 100dvh !important;
  max-height: 100dvh !important;
  margin: 0 !important;
  top: 0 !important;
  padding-bottom: 0 !important;
}

:global(.artifact-browser__compare-modal-wrap--fullscreen .ant-modal-content) {
  display: flex;
  flex-direction: column;
  height: 100dvh !important;
  max-height: 100dvh !important;
  border-radius: 0;
  overflow: hidden;
}

:global(.artifact-browser__compare-modal-wrap--fullscreen .ant-modal-body) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden !important;
}

:global(.artifact-browser__compare-modal-wrap--fullscreen) .artifact-browser__compare-modal,
:global(.artifact-browser__compare-modal-wrap--fullscreen) .artifact-browser__compare-diff,
:global(.artifact-browser__compare-modal-wrap--fullscreen) .artifact-browser__compare-pane {
  height: 100%;
  max-height: none;
  min-height: 0;
}

:global(.artifact-browser__compare-modal-wrap--fullscreen) .artifact-browser__compare-diff,
:global(.artifact-browser__compare-modal-wrap--fullscreen) .artifact-browser__compare-pane {
  display: flex;
  flex-direction: column;
}

:global(.artifact-browser__compare-modal-wrap--fullscreen) .artifact-browser__compare-panes {
  flex: 1 1 auto;
  min-height: 0;
}

:global(.artifact-browser__compare-modal-wrap--fullscreen) .artifact-browser__compare-body,
:global(.artifact-browser__compare-modal-wrap--fullscreen) .artifact-browser__compare-diff-body {
  flex: 1 1 auto;
  height: auto;
  max-height: none;
  min-height: 0;
}

.artifact-browser__compare-modal--fullscreen,
.artifact-browser__compare-modal--fullscreen .artifact-browser__compare-diff,
.artifact-browser__compare-modal--fullscreen .artifact-browser__compare-pane {
  height: 100%;
  max-height: none;
  min-height: 0;
}

.artifact-browser__compare-modal--fullscreen .artifact-browser__compare-diff,
.artifact-browser__compare-modal--fullscreen .artifact-browser__compare-pane {
  display: flex;
  flex-direction: column;
}

.artifact-browser__compare-modal--fullscreen .artifact-browser__compare-panes,
.artifact-browser__compare-modal--fullscreen .artifact-browser__compare-body,
.artifact-browser__compare-modal--fullscreen .artifact-browser__compare-diff-body {
  flex: 1 1 auto;
  height: auto;
  max-height: none;
  min-height: 0;
}

.artifact-browser__compare-note {
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, #faad14 35%, var(--app-border, #e8e8e8));
  border-radius: 12px;
  background: color-mix(in srgb, #faad14 10%, var(--app-bg, #fff));
  color: #8a5a00;
  font-size: 12px;
}

.artifact-browser__empty {
  border: 1px dashed var(--app-border, #d9d9d9);
  border-radius: 12px;
  padding: 28px;
  text-align: center;
  color: var(--app-muted, #999);
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 180px;
}

.artifact-browser__detail > .artifact-browser__empty {
  flex: 1 1 auto;
  min-height: 0;
}

@media (max-width: 1200px) {
  .artifact-browser__body {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(240px, 38vh) minmax(0, 1fr);
  }

  .artifact-browser__compare-modal {
    gap: 10px;
  }

  .artifact-browser__compare-panes {
    grid-template-columns: 1fr;
  }

  .artifact-browser__file-rail {
    flex-direction: column;
  }

  .artifact-browser__overflow-trigger {
    width: 100%;
  }
}

:root[data-theme="dark"] .artifact-browser__list,
:root[data-theme="dark"] .artifact-browser__detail-card,
:root[data-theme="dark"] .artifact-browser__artifact-item,
:root[data-theme="dark"] .artifact-browser__preview,
:root[data-theme="dark"] .artifact-browser__fold,
:root[data-theme="dark"] .artifact-browser__compare-diff,
:root[data-theme="dark"] .artifact-browser__compare-pane {
  border-color: #303030;
}

:root[data-theme="dark"] .artifact-browser__list,
:root[data-theme="dark"] .artifact-browser__detail-card,
:root[data-theme="dark"] .artifact-browser__compare-diff,
:root[data-theme="dark"] .artifact-browser__compare-pane {
  background: transparent;
}

:root[data-theme="dark"] .artifact-browser__artifact-item--selected,
:root[data-theme="dark"] .artifact-browser__compare-head,
:root[data-theme="dark"] .artifact-browser__meta-row,
:root[data-theme="dark"] .artifact-browser__ghost,
:root[data-theme="dark"] .artifact-browser__file-tab,
:root[data-theme="dark"] .artifact-browser__compare-version-control select,
:root[data-theme="dark"] .artifact-browser__overflow-trigger {
  background: #1a2230;
  color: #d6dbe4;
}

:root[data-theme="dark"] .artifact-browser__file-tab-badge {
  background: rgba(64, 132, 255, 0.16);
}
</style>

