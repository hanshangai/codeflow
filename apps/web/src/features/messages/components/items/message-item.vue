<script setup lang="ts">
import { computed, ref } from "vue";
import { message } from "ant-design-vue";
import { RightOutlined, DownOutlined, CopyOutlined, CodeOutlined, EyeOutlined, RollbackOutlined, DeleteOutlined, LoadingOutlined, FullscreenExitOutlined, FullscreenOutlined } from "@ant-design/icons-vue";
import type { ConversationMessage, EngineType, TurnId, TextFileAttachment, WorkspaceId } from "@codeflowai/shared";

import { copyToClipboard } from "@/composables/useClipboard";
import { useApiContext } from "@/composables/useApiContext";
import MarkdownContent from "../../../markdown/MarkdownContent.vue";
import HtmlPreview from "../../../explorer/components/html-preview.vue";
import MarkdownPreview from "../../../explorer/components/markdown-preview.vue";
import { loadWorkspaceFilePreview, type WorkspaceFilePreviewResult } from "../../../explorer/workspaceFilePreview";
import IconClaude from "@/shared/icons/IconClaude.vue";
import IconCodex from "@/shared/icons/IconCodex.vue";
import AccountAvatar from "../../../account/components/account-avatar.vue";
import MessageImageThumbs from "../message-image-thumbs.vue";
import { useConfigStore } from "../../../../store/config";
import { useUiStore, type PreviewWindow } from "../../../../store/ui";
import { useWorkspacesStore } from "../../../../store/workspaces";

defineOptions({ name: "MessageItem" });

type TextAttachmentPreviewKind = "markdown" | "html" | "code";

type Props = {
  item: ConversationMessage;
  engine?: EngineType;
  workspaceId?: WorkspaceId | null;
  /** bare 模式：不渲染外层 .msg-row 和头像（由父级 assistant-group 统一提供）。 */
  bare?: boolean;
  /** 是否允许回滚到该条用户消息（仅 completed turn 可回滚）。 */
  canRollback?: boolean;
  /** 操作中：禁用回滚等写操作按钮。 */
  busy?: boolean;
  /** 删除只取决于当前写入状态，不受正在输出影响。 */
  canDelete?: boolean;
  deleteBusy?: boolean;
};

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: "rollback", turnId: TurnId): void;
  (e: "deleteMessage", itemId: string): void;
}>();
const showDelete = computed(() => props.canDelete && !String(props.item.id).startsWith("local_user_"));
const config = useConfigStore();
const workspaces = useWorkspacesStore();
const { ctx } = useApiContext();

  const engineLabel = computed(() => {
    const eng = props.engine ?? "codex";
    return eng === "claude" ? "CC" : "CX";
  });

  const copying = ref(false);
  const copyingEngineCall = ref(false);
  const engineCallDetailsOpen = ref(false);
  /** 是否显示原文（未渲染的 markdown 源码）。 */
  const showRaw = ref(false);

const ui = useUiStore();

const previewFile = ref<TextFileAttachment | null>(null);
const previewOpen = ref(false);
const previewFullscreen = ref(false);
const previewFileKind = computed<TextAttachmentPreviewKind>(() => detectTextAttachmentPreviewKind(previewFile.value?.name ?? ""));
const previewFullscreenTitle = computed(() => previewFullscreen.value ? "还原附件预览" : "全屏查看附件预览");
const previewModalWidth = computed(() => previewFullscreen.value ? "100vw" : "70%");
const previewModalStyle = computed(() => previewFullscreen.value ? { top: "0", paddingBottom: "0" } : { top: "10%" });
const previewBodyStyle = computed(() =>
  previewFullscreen.value
    ? { height: "calc(100dvh - 56px)", maxHeight: "calc(100dvh - 56px)", overflow: "hidden" }
    : { maxHeight: "70vh", overflow: "auto" });
const previewWrapClassName = computed(() =>
  previewFullscreen.value
    ? "message-attachment-preview-modal message-attachment-preview-modal--fullscreen"
    : "message-attachment-preview-modal");


/** 复制消息文本到剪贴板（仅浏览器端）。 */
async function copyMessageText(): Promise<void> {
  if (copying.value) return;
  copying.value = true;
  try {
    await copyToClipboard(props.item.text ?? "");
    message.success("已复制");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "复制失败");
  } finally {
    copying.value = false;
  }
}

/** 复制引擎调用追踪 JSON（用于排障）。 */
async function copyEngineCallJson(): Promise<void> {
  const call = props.item.engineCall;
  if (!call || copyingEngineCall.value) return;
  copyingEngineCall.value = true;
  try {
    await copyToClipboard(JSON.stringify(call, null, 2));
    message.success("已复制");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "复制失败");
  } finally {
    copyingEngineCall.value = false;
  }
}

const engineCallTitle = computed(() => {
  const call = props.item.engineCall;
  if (!call) return "";
  if (call.kind === "spawn") return `spawn / ${call.engine}`;
  if (call.kind === "jsonrpc") return `jsonrpc / ${call.transport}`;
  return "unknown";
});

function openTextFilePreview(f: TextFileAttachment): void {
  if (isMobile) {
    const kind = detectTextAttachmentPreviewKind(f.name);
    const previewType: PreviewWindow["previewType"] = kind === "markdown"
      ? "markdown"
      : kind === "html"
        ? "html"
        : "code";
    const win: PreviewWindow = {
      id: `msg-file-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      filePath: f.name,
      type: "file",
      previewType,
      content: f.text,
      base64: null,
      mimeType: null,
      diffOriginal: null,
      diffModified: null,
      diffStaged: false,
      diffVersionOld: null,
      diffVersionNew: null,
      cascadeIndex: 0,
      zIndex: 0,
    };
    ui.pushMobilePage({ type: "explorer-preview", context: { win } });
    return;
  }
  previewFile.value = f;
  previewOpen.value = true;
}

/** 将工作区文件预览结果转换为统一预览窗口字段。 */
function previewFields(result: WorkspaceFilePreviewResult): Pick<PreviewWindow, "previewType" | "content" | "base64" | "mimeType" | "spreadsheet"> {
  return {
    previewType: result.previewType,
    content: result.preview?.content ?? null,
    base64: result.preview?.base64 ?? null,
    mimeType: result.preview?.mimeType ?? result.spreadsheet?.mimeType ?? null,
    spreadsheet: result.spreadsheet ?? null,
  };
}

/** 打开 Markdown 消息中引用的工作区文件，避免相对链接触发浏览器路由跳转。 */
async function openWorkspaceFilePreview(filePath: string): Promise<void> {
  const workspaceId = props.workspaceId ?? null;
  if (!workspaceId) {
    message.warning("请先选择工作区");
    return;
  }

  try {
    const result = await loadWorkspaceFilePreview(ctx.value, workspaceId, filePath);
    const win: PreviewWindow = {
      id: `msg-workspace-file-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      workspaceId,
      filePath,
      type: "file",
      ...previewFields(result),
      diffOriginal: null,
      diffModified: null,
      diffStaged: false,
      diffVersionOld: null,
      diffVersionNew: null,
      cascadeIndex: ui.explorerPreviewWindows.length,
      zIndex: 0,
    };

    if (isMobile) {
      ui.pushMobilePage({ type: "explorer-preview", context: { win } });
      return;
    }
    ui.openPreviewWindow(win);
  } catch (error) {
    message.error(error instanceof Error ? error.message : "读取文件失败");
  }
}

/** 按附件文件名判断预览方式；附件不绑定工作区，只渲染文本本身。 */
function detectTextAttachmentPreviewKind(fileName: string): TextAttachmentPreviewKind {
  const ext = String(fileName ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  return "code";
}

const copyingFile = ref(false);

async function copyFileText(): Promise<void> {
  if (copyingFile.value || !previewFile.value) return;
  copyingFile.value = true;
  try {
    await copyToClipboard(previewFile.value.text);
    message.success("已复制");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "复制失败");
  } finally {
    copyingFile.value = false;
  }
}

/** 关闭消息附件预览并清理当前附件引用。 */
function closeTextFilePreview(): void {
  previewFullscreen.value = false;
  previewOpen.value = false;
  previewFile.value = null;
}

/** 切换消息附件预览全屏状态，保留当前附件内容。 */
function togglePreviewFullscreen(): void {
  previewFullscreen.value = !previewFullscreen.value;
}

const isMobile = typeof window !== "undefined" && window.innerWidth <= 767;
const userAvatarSize = isMobile ? 24 : 28;
const workspaceRootPath = computed(() => props.workspaceId ? workspaces.byId.get(props.workspaceId)?.path ?? null : null);
const userDisplayName = computed(() => config.userSummary?.fullName?.trim() || "用户");
const userAvatarUrl = computed(() => config.userSummary?.avatarUrl ?? null);
const showActionBar = computed(() => Boolean(props.item.text && !(props.item.role === "assistant" && props.item.format === "plain")));
const messageTimeLabel = computed(() => formatMessageTime(props.item.createdAt, "short"));
const messageTimeTitle = computed(() => formatMessageTime(props.item.createdAt, "full"));
const showMetadataBar = computed(() => showActionBar.value || Boolean(messageTimeLabel.value));

function requestRollback(): void {
  if (props.busy) return;
  if (!props.canRollback) return;
  if (props.item.role !== "user") return;
  const id = String(props.item.turnId ?? "").trim();
  if (!id) return;
  emit("rollback", id as TurnId);
}

function formatMessageTime(ts: number | null | undefined, mode: "short" | "full"): string {
  const value = Number(ts ?? 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  if (mode === "short") {
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}
</script>

<template>
  <div
    v-if="item.role !== 'assistant' || item.text || item.images?.length || item.files?.length"
    class="msg-row"
    :data-message-id="String(item.id)"
    :class="[item.role === 'user' ? 'msg-row--user' : 'msg-row--assistant', { 'msg-row--bare': bare }]"
  >
    <div v-if="!bare && item.role !== 'user'" class="msg-avatar msg-avatar--assistant" :class="`msg-avatar--${engine ?? 'codex'}`">
      <IconClaude v-if="(engine ?? 'codex') === 'claude'" :size="18" />
      <IconCodex v-else :size="16" />
    </div>
    <div v-if="!bare && item.role === 'user'" class="msg-avatar msg-avatar--user">
      <AccountAvatar :display-name="userDisplayName" :avatar-url="userAvatarUrl" :size="userAvatarSize" />
    </div>
    <div class="msg msg--message" :class="[item.role === 'user' ? 'msg--user' : 'msg--assistant']">
      <!-- 消息内容区 -->
      <div v-if="item.role === 'assistant' && item.format === 'plain'" class="msg__content msg__content--plain">
        <span>{{ item.text }}</span><span class="msg__cursor">▍</span>
      </div>
      <template v-else-if="item.role === 'assistant'">
        <div v-if="showRaw" class="msg__content msg__content--raw">{{ item.text }}</div>
        <MarkdownContent
          v-else
          :text="item.text"
          :workspace-id="props.workspaceId ?? null"
          :workspace-root-path="workspaceRootPath"
          @open-workspace-file="openWorkspaceFilePreview"
        />
      </template>
      <div v-else class="msg__content">{{ item.text }}</div>

      <MessageImageThumbs :images="item.images" :alt-prefix="item.role" />

      <div v-if="item.files?.length" class="msg__files">
        <a-tag v-for="f in item.files" :key="f.id" class="msg__file-tag" @click="openTextFilePreview(f)">
          {{ f.displayName || f.name }}
        </a-tag>
      </div>

      <!-- 底部操作栏：纯图标按钮 + 完整参数（右侧，移动端换行） -->
      <div v-if="showMetadataBar || showDelete" class="msg__actions">
        <template v-if="showActionBar">
          <a-tooltip title="复制" placement="bottom">
            <button type="button" class="msg__action-btn" :disabled="copying" @click="copyMessageText">
              <CopyOutlined />
            </button>
          </a-tooltip>
          <a-tooltip v-if="item.role === 'assistant' && item.format !== 'plain'" :title="showRaw ? '渲染' : '原文'" placement="bottom">
            <button
              type="button"
              class="msg__action-btn"
              :class="{ 'msg__action-btn--active': showRaw }"
              @click="showRaw = !showRaw"
            >
              <CodeOutlined v-if="!showRaw" />
              <EyeOutlined v-else />
            </button>
          </a-tooltip>
          <a-tooltip v-if="item.role === 'user' && item.turnId && props.canRollback" title="回滚" placement="bottom">
            <button type="button" class="msg__action-btn" :disabled="props.busy" @click="requestRollback">
              <RollbackOutlined />
            </button>
          </a-tooltip>
        </template>
        <a-tooltip v-if="showDelete" title="删除消息" placement="bottom">
          <button
            type="button"
            class="msg__action-btn msg__action-btn--danger"
            :disabled="deleteBusy"
            :aria-label="deleteBusy ? '正在删除消息' : '删除消息'"
            @click="emit('deleteMessage', String(item.id))"
          >
            <LoadingOutlined v-if="deleteBusy" spin />
            <DeleteOutlined v-else />
          </button>
        </a-tooltip>
        <span v-if="messageTimeLabel" class="msg__timestamp" :title="messageTimeTitle">{{ messageTimeLabel }}</span>
        <!-- 完整参数：右侧对齐（仅在调试侧栏开启时显示） -->
        <button
          v-if="item.role === 'user' && item.engineCall && ui.inspectorVisible"
          type="button"
          class="msg__detail-toggle"
          :class="{ 'msg__detail-toggle--align-end': !messageTimeLabel }"
          @click="engineCallDetailsOpen = !engineCallDetailsOpen"
        >
          <RightOutlined v-if="!engineCallDetailsOpen" style="font-size: 10px" />
          <DownOutlined v-else style="font-size: 10px" />
          完整参数
          <span class="msg__hint-inline">{{ engineCallTitle }}</span>
        </button>
      </div>

      <!-- 完整参数展开内容（仅在调试侧栏开启时显示） -->
      <div v-if="item.role === 'user' && item.engineCall && engineCallDetailsOpen && ui.inspectorVisible" class="msg__approval-details">
        <div style="display: flex; justify-content: flex-end; margin-bottom: 4px;">
          <button type="button" class="msg__mini-btn" @click.stop="copyEngineCallJson">
            {{ copyingEngineCall ? "..." : "复制 JSON" }}
          </button>
        </div>
        <pre class="msg__approval-details-body">{{ JSON.stringify(item.engineCall, null, 2) }}</pre>
      </div>
    </div>
  </div>

  <a-modal
    :open="previewOpen"
    :footer="null"
    @cancel="closeTextFilePreview"
    :width="previewModalWidth"
    :style="previewModalStyle"
    :body-style="previewBodyStyle"
    :wrap-class-name="previewWrapClassName"
  >
    <template #title>
      <div class="message-attachment-preview__titlebar">
        <span>附件预览</span>
        <a-tooltip :title="previewFullscreenTitle">
          <a-button size="small" type="text" :aria-label="previewFullscreenTitle" @click.stop="togglePreviewFullscreen">
            <component :is="previewFullscreen ? FullscreenExitOutlined : FullscreenOutlined" />
          </a-button>
        </a-tooltip>
      </div>
    </template>
    <div
      v-if="previewFile"
      class="message-attachment-preview"
      :class="{ 'message-attachment-preview--fullscreen': previewFullscreen }"
    >
      <div style="display: flex; justify-content: space-between; gap: 10px; align-items: center">
        <div style="display: grid; gap: 4px">
          <div class="mono">{{ previewFile.displayName || previewFile.name }}</div>
          <div v-if="previewFile.displayName && previewFile.displayName !== previewFile.name" style="font-size: 12px; color: var(--app-muted)">
            {{ previewFile.name }}
          </div>
        </div>
        <a-button size="small" type="text" title="复制" :disabled="copyingFile" @click="copyFileText"><CopyOutlined /></a-button>
      </div>
      <div v-if="previewFileKind === 'markdown' || previewFileKind === 'html'" class="message-attachment-preview__rendered">
        <MarkdownPreview
          v-if="previewFileKind === 'markdown'"
          :content="previewFile.text"
          :file-path="previewFile.name"
        />
        <HtmlPreview
          v-else
          :content="previewFile.text"
          :file-path="previewFile.name"
        />
      </div>
      <pre v-else class="msg__pre message-attachment-preview__text">{{ previewFile.text }}</pre>
    </div>
  </a-modal>

</template>

<style scoped>
.msg__action-btn--danger:hover:not(:disabled) {
  color: var(--ant-color-error, #ff4d4f);
  background: color-mix(in srgb, var(--ant-color-error, #ff4d4f) 10%, transparent);
}

.message-attachment-preview__titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: calc(100% - 44px);
  min-width: 0;
}

.message-attachment-preview__titlebar span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-attachment-preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.message-attachment-preview__rendered {
  height: 60vh;
  min-height: 320px;
  overflow: hidden;
}

.message-attachment-preview__text {
  max-height: 60vh;
  overflow: auto;
}

:global(.message-attachment-preview-modal--fullscreen.ant-modal-wrap) {
  overflow: hidden !important;
}

:global(.message-attachment-preview-modal--fullscreen .ant-modal) {
  width: 100vw !important;
  max-width: 100vw !important;
  height: 100dvh !important;
  min-height: 100dvh !important;
  max-height: 100dvh !important;
  margin: 0 !important;
  top: 0 !important;
  padding-bottom: 0 !important;
}

:global(.message-attachment-preview-modal--fullscreen .ant-modal-content) {
  display: flex;
  flex-direction: column;
  height: 100dvh !important;
  max-height: 100dvh !important;
  border-radius: 0;
  overflow: hidden;
}

:global(.message-attachment-preview-modal--fullscreen .ant-modal-body) {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden !important;
}

:global(.message-attachment-preview-modal--fullscreen) .message-attachment-preview {
  height: 100%;
}

:global(.message-attachment-preview-modal--fullscreen) .message-attachment-preview__rendered,
:global(.message-attachment-preview-modal--fullscreen) .message-attachment-preview__text {
  flex: 1 1 auto;
  height: auto;
  max-height: none;
  min-height: 0;
}

.message-attachment-preview--fullscreen {
  height: 100%;
}

.message-attachment-preview--fullscreen .message-attachment-preview__rendered,
.message-attachment-preview--fullscreen .message-attachment-preview__text {
  flex: 1 1 auto;
  height: auto;
  max-height: none;
  min-height: 0;
}
</style>
