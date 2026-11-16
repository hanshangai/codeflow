<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { CloseOutlined, PlusOutlined, DeleteOutlined } from "@ant-design/icons-vue";
import type { FeedbackAttachmentInput, FeedbackType } from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { useConfigStore } from "../../../store/config";
import { useUiStore } from "../../../store/ui";
import { submitFeedback } from "../../../api/feedback";
import { subscribeDesktopFeedbackRequested, takeDesktopFeedbackRequest } from "../../../services/desktop";
import { compressImageFile } from "../../composer/useComposerAttachments";

defineOptions({ name: "FeedbackModal" });

const props = defineProps<{ open: boolean; source?: "user_menu" | "slash_command" }>();
const sourceOverride = ref<"tray" | null>(null);
const activeSource = computed(() => sourceOverride.value ?? props.source ?? "user_menu");
const emit = defineEmits<{ "update:open": [value: boolean] }>();

const config = useConfigStore();
const ui = useUiStore();
const { ctx } = useApiContext();

type ImageItem = FeedbackAttachmentInput & { previewUrl: string; size: number };
const typeOptions: Array<{ key: FeedbackType; label: string }> = [
  { key: "bug", label: "问题反馈" },
  { key: "feature", label: "功能建议" },
  { key: "other", label: "其他" },
];
const type = ref<FeedbackType>("bug");
const title = ref("");
const content = ref("");
const contactEmail = ref("");
const images = ref<ImageItem[]>([]);
const submitting = ref(false);
const errorText = ref("");
const ticketNo = ref("");
const fileInput = ref<HTMLInputElement | null>(null);

const isLoggedIn = computed(() => config.authMode === "account" && config.hasActiveSession);
const contactRequired = computed(() => !isLoggedIn.value);
const canSubmit = computed(() => content.value.trim().length >= 10 && content.value.trim().length <= 2000
  && (!contactRequired.value || Boolean(contactEmail.value.trim())) && !submitting.value);
const contentCount = computed(() => content.value.length);
const environment = computed(() => ({
  appVersion: config.clientVersion,
  clientVersion: config.desktopClient?.version ?? config.clientVersion,
  platform: config.desktopClient?.platform ?? (typeof navigator !== "undefined" ? navigator.platform : null),
  mainView: ui.mainView,
  workspaceId: config.workspaceId,
}));

watch(() => props.open, (open) => {
  if (!open) { sourceOverride.value = null; return; }
  ticketNo.value = "";
  errorText.value = "";
  if (isLoggedIn.value && !contactEmail.value) contactEmail.value = config.userSummary?.email ?? "";
}, { immediate: true });

let stopFeedbackSubscription: (() => void) | null = null;
onMounted(() => {
  stopFeedbackSubscription = subscribeDesktopFeedbackRequested(() => {
    void takeDesktopFeedbackRequest();
    sourceOverride.value = "tray";
    emit("update:open", true);
  });
  void takeDesktopFeedbackRequest().then((pending) => {
    if (!pending) return;
    sourceOverride.value = "tray";
    emit("update:open", true);
  });
});
onUnmounted(() => stopFeedbackSubscription?.());

function close(): void {
  if (submitting.value) return;
  emit("update:open", false);
}

function openFilePicker(): void {
  fileInput.value?.click();
}

async function onFilesSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  errorText.value = "";
  for (const file of files) {
    if (images.value.length >= 3) { errorText.value = "最多上传 3 张截图"; break; }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { errorText.value = "截图只支持 PNG、JPEG 或 WebP"; continue; }
    try {
      const compressed = await compressImageFile(file, 1024 * 1024);
      if (!compressed) { errorText.value = "截图压缩后仍超过 1MB，请换一张"; continue; }
      const match = /^data:([^;]+);base64,(.*)$/u.exec(compressed.dataUrl);
      if (!match) { errorText.value = "截图处理失败"; continue; }
      images.value.push({ name: file.name || "screenshot", mimeType: match[1] as ImageItem["mimeType"],
        dataBase64: match[2]!, previewUrl: compressed.dataUrl, size: compressed.size });
    } catch {
      errorText.value = "截图处理失败，请换一张";
    }
  }
}

function removeImage(index: number): void {
  images.value.splice(index, 1);
}

function validate(): string {
  if (content.value.trim().length < 10) return "详细描述至少 10 个字符";
  if (content.value.trim().length > 2000) return "详细描述不能超过 2000 个字符";
  if (contactRequired.value && !contactEmail.value.trim()) return "未登录提交请填写联系方式";
  if (contactEmail.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(contactEmail.value.trim())) return "联系方式不是合法邮箱";
  return "";
}

async function submit(): Promise<void> {
  if (submitting.value) return;
  const issue = validate();
  if (issue) { errorText.value = issue; return; }
  submitting.value = true;
  errorText.value = "";
  try {
    const result = await submitFeedback(ctx.value, {
      type: type.value,
      title: title.value.trim() || undefined,
      content: content.value.trim(),
      contactEmail: isLoggedIn.value ? contactEmail.value.trim() || undefined : contactEmail.value.trim(),
      source: activeSource.value,
      environment: environment.value,
      attachments: images.value.map(({ name, mimeType, dataBase64 }) => ({ name, mimeType, dataBase64 })),
    }, isLoggedIn.value);
    ticketNo.value = result.ticketNo;
    content.value = "";
    title.value = "";
    images.value = [];
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : "反馈提交失败，请稍后重试";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <a-modal :open="props.open" :footer="null" :width="720" centered :mask-closable="false"
    wrap-class-name="feedback-modal-host" @cancel="close">
    <template #closeIcon><CloseOutlined /></template>
    <div class="feedback-modal">
      <header class="feedback-modal__header">
        <div>
          <h2>{{ ticketNo ? "反馈已提交" : "意见反馈" }}</h2>
          <p>{{ ticketNo ? "我们已收到你的反馈，会尽快处理。" : "遇到问题或有建议，告诉我们" }}</p>
        </div>
      </header>

      <div v-if="ticketNo" class="feedback-modal__success">
        <div class="feedback-modal__success-icon">✓</div>
        <div class="feedback-modal__ticket">工单编号：<strong>{{ ticketNo }}</strong></div>
        <p>需要补充信息时，我们会通过你留下的联系方式联系你。</p>
        <a-button type="primary" @click="close">完成</a-button>
      </div>

      <template v-else>
        <div class="feedback-modal__types">
          <button v-for="item in typeOptions" :key="item.key" type="button"
            :class="{ active: type === item.key }" @click="type = item.key">{{ item.label }}</button>
        </div>

        <label class="feedback-modal__field">
          <span>标题 <small>（选填）</small></span>
          <a-input v-model:value="title" :maxlength="120" placeholder="一句话描述问题或建议" />
        </label>

        <label class="feedback-modal__field">
          <span>详细描述</span>
          <a-textarea v-model:value="content" :rows="5" :maxlength="2000" placeholder="请描述操作步骤、预期结果和实际结果…" />
          <small class="feedback-modal__count">{{ contentCount }} / 2000</small>
        </label>

        <label class="feedback-modal__field">
          <span>联系方式 <small>{{ contactRequired ? "（必填）" : "（选填）" }}</small></span>
          <a-input v-model:value="contactEmail" :placeholder="contactRequired ? '请填写邮箱，方便我们联系你' : 'user@example.com'" />
        </label>

        <div class="feedback-modal__field">
          <span>截图 <small>（选填，最多 3 张）</small></span>
          <div class="feedback-modal__images">
            <div v-for="(image, index) in images" :key="image.name + index" class="feedback-modal__image">
              <img :src="image.previewUrl" :alt="image.name" />
              <button type="button" aria-label="移除截图" @click="removeImage(index)"><DeleteOutlined /></button>
            </div>
            <button v-if="images.length < 3" type="button" class="feedback-modal__upload" @click="openFilePicker">
              <PlusOutlined />
              <span>添加截图</span>
            </button>
          </div>
          <input ref="fileInput" class="feedback-modal__file" type="file" accept="image/png,image/jpeg,image/webp" multiple @change="onFilesSelected" />
        </div>

        <a-alert v-if="errorText" type="error" show-icon :message="errorText" />

        <p class="feedback-modal__privacy">请勿在描述中填写密码、Key 等敏感信息。提交后可在工单中查看处理状态。</p>

        <footer class="feedback-modal__actions">
          <a-button @click="close">取消</a-button>
          <a-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">提交反馈</a-button>
        </footer>
      </template>
    </div>
  </a-modal>
</template>

<style scoped>
/* 全局弹框样式把 content 内边距压到 8px，这里恢复常规留白，并限制高度避免小屏溢出。 */
:global(.feedback-modal-host .ant-modal-content) {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 48px);
  padding: 0;
  border-radius: 14px;
}
:global(.feedback-modal-host .ant-modal-body) {
  min-height: 0;
  overflow-y: auto;
  padding: 26px 28px 22px;
}
:global(.feedback-modal-host .ant-modal-close) {
  top: 18px;
  right: 18px;
  width: 32px;
  height: 32px;
  border-radius: 8px;
}
.feedback-modal { display: grid; gap: 16px; color: var(--app-text); }
.feedback-modal__header { padding-right: 32px; }
.feedback-modal__header h2 { margin: 0; font-size: 18px; line-height: 1.4; font-weight: 600; }
.feedback-modal__header p { margin: 6px 0 0; color: var(--app-muted); font-size: 13px; }
.feedback-modal__types { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 4px; border-radius: 10px; background: var(--app-bg-secondary); }
.feedback-modal__types button { padding: 8px; border: 0; border-radius: 8px; background: transparent; color: var(--app-muted); font: inherit; font-size: 13px; cursor: pointer; }
.feedback-modal__types button.active { background: var(--app-panel-bg); color: var(--app-text); font-weight: 600; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08); }
.feedback-modal__field { display: grid; gap: 8px; font-size: 13px; font-weight: 600; }
.feedback-modal__field small { color: var(--app-muted); font-weight: 400; }
.feedback-modal__count { justify-self: end; color: var(--app-muted); font-weight: 400; }
.feedback-modal__images { display: flex; flex-wrap: wrap; gap: 10px; }
.feedback-modal__image { position: relative; width: 84px; height: 62px; border: 1px solid var(--app-border); border-radius: 8px; overflow: hidden; }
.feedback-modal__image img { width: 100%; height: 100%; object-fit: cover; }
.feedback-modal__image button { position: absolute; top: 3px; right: 3px; display: grid; place-items: center; width: 20px; height: 20px; border: 0; border-radius: 50%; background: rgba(0,0,0,.55); color: #fff; cursor: pointer; }
.feedback-modal__upload { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; width: 84px; height: 62px; border: 1px dashed var(--app-border); border-radius: 8px; background: transparent; color: var(--app-muted); font-size: 11px; cursor: pointer; }
.feedback-modal__file { display: none; }
.feedback-modal__privacy { margin: 0; color: var(--app-muted); font-size: 12px; line-height: 1.6; }
.feedback-modal__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; padding-top: 16px; border-top: 1px solid var(--app-divider); }
.feedback-modal__success { display: grid; justify-items: center; gap: 14px; padding: 16px 0 4px; text-align: center; }
.feedback-modal__success-icon { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 50%; background: #e8f5ec; color: #2f7d4a; font-size: 26px; }
.feedback-modal__success p { margin: 0; color: var(--app-muted); font-size: 13px; line-height: 1.7; }
.feedback-modal__ticket { padding: 10px 12px; border-radius: 10px; background: var(--app-bg-secondary); color: var(--app-muted); font-size: 12px; }
.feedback-modal__ticket strong { color: var(--app-text); }
</style>
