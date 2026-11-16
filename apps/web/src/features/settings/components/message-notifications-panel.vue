<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { message } from "ant-design-vue";
import type { MessageNotificationChannel, MyMessageNotificationChannelConfigView, UpdateMessageNotificationChannelConfigInput } from "@codeflowai/shared";

import { useApiContext } from "../../../composables/useApiContext";
import { getMyMessageNotificationConfig, updateMyMessageNotificationConfig } from "../../../api/message-notifications";
import { isCancelledRequestError } from "../../../api/request";
import { trackProductEvent } from "../../../analytics/analytics";

defineOptions({ name: "MessageNotificationsPanel" });

const props = withDefaults(defineProps<{ surface?: "default" | "h5" }>(), {
  surface: "default",
});

type ChannelForm = {
  enabled: boolean;
  webhook: string;
  webhookConfigured: boolean;
  secret: string;
  secretConfigured: boolean;
  keyword: string;
  atMobilesText: string;
  atUserIdsText: string;
  atAll: boolean;
  updatedAt: number;
};

const loading = ref(false);
const saving = ref(false);
const guideOpen = ref(false);
const guideChannel = ref<MessageNotificationChannel>("dingtalk");
const activeChannel = ref<MessageNotificationChannel>("dingtalk");

const dingtalk = reactive<ChannelForm>(createEmptyForm());
const wecom = reactive<ChannelForm>(createEmptyForm());
const guideTitle = computed(() => guideChannel.value === "dingtalk" ? "钉钉群机器人配置指引" : "企业微信群机器人配置指引");

/** 创建前端表单默认值。 */
function createEmptyForm(): ChannelForm {
  return {
    enabled: false,
    webhook: "",
    webhookConfigured: false,
    secret: "",
    secretConfigured: false,
    keyword: "",
    atMobilesText: "",
    atUserIdsText: "",
    atAll: false,
    updatedAt: 0,
  };
}

/** 拉取当前账号消息通知配置。 */
async function loadConfig(): Promise<void> {
  loading.value = true;
  try {
    const { ctx } = useApiContext();
    const res = await getMyMessageNotificationConfig(ctx.value);
    if (!res.ok) {
      message.error(res.message);
      return;
    }
    applyConfig(dingtalk, res.channels.dingtalk);
    applyConfig(wecom, res.channels.wecom);
  } finally {
    loading.value = false;
  }
}

/** 将接口视图写回表单，当前用户配置直接回填到输入框。 */
function applyConfig(form: ChannelForm, config: MyMessageNotificationChannelConfigView): void {
  form.enabled = config.enabled;
  form.webhook = config.webhook;
  form.webhookConfigured = config.webhookConfigured;
  form.secret = config.secret;
  form.secretConfigured = config.secretConfigured;
  form.keyword = config.keyword;
  form.atMobilesText = config.atMobiles.join("\n");
  form.atUserIdsText = config.atUserIds.join("\n");
  form.atAll = config.atAll;
  form.updatedAt = config.updatedAt;
}

/** 保存当前账号消息通知配置。 */
async function saveConfig(): Promise<void> {
  saving.value = true;
  try {
    const { ctx } = useApiContext();
    const res = await updateMyMessageNotificationConfig(ctx.value, {
      dingtalk: buildChannelPayload(dingtalk, true),
      wecom: buildChannelPayload(wecom, false),
    });
    if (!res.ok) {
      trackProductEvent("settings_save_failed", { settings_panel: "message_notifications", settings_action: "save", source: "settings", error_code_group: "request_rejected" });
      message.error(res.message);
      return;
    }
    applyConfig(dingtalk, res.channels.dingtalk);
    applyConfig(wecom, res.channels.wecom);
    message.success("消息通知配置已保存");
    trackProductEvent("settings_save_success", { settings_panel: "message_notifications", settings_action: "save", source: "settings" });
  } catch (error) {
    if (!isCancelledRequestError(error)) {
      trackProductEvent("settings_save_failed", { settings_panel: "message_notifications", settings_action: "save", source: "settings", error_code_group: "request_error" });
    }
    throw error;
  } finally {
    saving.value = false;
  }
}

/** 构造单通道保存载荷，空 Webhook/Secret 会按用户输入清空。 */
function buildChannelPayload(form: ChannelForm, includeSecret: boolean): UpdateMessageNotificationChannelConfigInput {
  return {
    enabled: form.enabled,
    webhook: form.webhook.trim(),
    secret: includeSecret ? form.secret.trim() : undefined,
    keyword: includeSecret ? form.keyword.trim() : "",
    atMobiles: parseMultiLine(form.atMobilesText),
    atUserIds: parseMultiLine(form.atUserIdsText),
    atAll: form.atAll,
  };
}

/** 解析换行或逗号分隔的 @ 列表。 */
function parseMultiLine(value: string): string[] {
  const seen = new Set<string>();
  String(value ?? "").split(/[\n,]/g).forEach((item) => {
    const text = item.trim();
    if (text) seen.add(text);
  });
  return [...seen];
}

/** 打开指定通道的操作指引弹窗。 */
function openGuide(channel: MessageNotificationChannel): void {
  guideChannel.value = channel;
  guideOpen.value = true;
}

/** 格式化最后更新时间。 */
function formatUpdatedAt(value: number): string {
  if (!value || value <= 0) return "尚未保存";
  return new Date(value).toLocaleString("zh-CN");
}

onMounted(() => {
  void loadConfig();
});
</script>

<template>
  <div class="message-config-panel" :class="`message-config-panel--${props.surface}`">
    <div class="message-config-panel__header">
      <div>
        <h2 class="message-config-panel__title">待办通知</h2>
        <p class="message-config-panel__subtitle">配置后，待办信息会通过机器人发送到钉钉群或企业微信群。</p>
      </div>
      <a-button :loading="loading" @click="loadConfig">刷新</a-button>
    </div>

    <div v-if="props.surface === 'h5'" class="message-config-panel__channel-switch" role="tablist" aria-label="通知渠道">
      <button type="button" role="tab" :aria-selected="activeChannel === 'dingtalk'" :class="{ active: activeChannel === 'dingtalk' }" @click="activeChannel = 'dingtalk'">钉钉</button>
      <button type="button" role="tab" :aria-selected="activeChannel === 'wecom'" :class="{ active: activeChannel === 'wecom' }" @click="activeChannel = 'wecom'">企业微信</button>
    </div>

    <a-spin :spinning="loading">
      <div class="message-config-panel__grid">
        <section
          v-if="props.surface !== 'h5' || activeChannel === 'dingtalk'"
          class="message-config-card"
          :class="{ 'message-config-card--enabled': dingtalk.enabled }"
        >
          <div class="message-config-card__title-row">
            <div>
              <h3>钉钉群机器人</h3>
              <span>支持 Webhook、加签 Secret、关键词和 @ 配置。</span>
            </div>
            <a-button size="small" @click="openGuide('dingtalk')">操作指引</a-button>
          </div>

          <div class="message-config-card__form">
            <label class="message-config-field message-config-field--switch">
              <span>启用钉钉通知</span>
              <a-switch v-model:checked="dingtalk.enabled" size="small" />
            </label>

            <div class="message-config-field">
              <span>Webhook</span>
              <a-input
                v-model:value="dingtalk.webhook"
                autocomplete="off"
                data-1p-ignore="true"
                data-form-type="other"
                data-lpignore="true"
                name="message-notification-dingtalk-webhook"
                type="text"
                size="small"
                :placeholder="dingtalk.webhookConfigured ? '请输入新的机器人 Webhook' : '请输入钉钉机器人 Webhook'"
              />
            </div>

            <div class="message-config-field">
              <span>加签 Secret</span>
              <a-input
                v-model:value="dingtalk.secret"
                autocomplete="off"
                data-1p-ignore="true"
                data-form-type="other"
                data-lpignore="true"
                name="message-notification-dingtalk-secret"
                type="text"
                size="small"
                :placeholder="dingtalk.secretConfigured ? '请输入新的加签 Secret' : '可选，建议开启加签后填写 Secret'"
              />
            </div>

            <div class="message-config-field-pair">
              <div class="message-config-field message-config-field--textarea">
                <span>@ 手机号</span>
                <a-textarea v-model:value="dingtalk.atMobilesText" :rows="2" placeholder="一行一个手机号，或用英文逗号分隔" />
              </div>

              <div class="message-config-field message-config-field--textarea">
                <span>@ 用户ID</span>
                <a-textarea v-model:value="dingtalk.atUserIdsText" :rows="2" placeholder="一行一个钉钉用户ID，或用英文逗号分隔" />
              </div>
            </div>

            <div class="message-config-field">
              <span>关键词</span>
              <a-input v-model:value="dingtalk.keyword" size="small" placeholder="可选，例如 CodeFlow" />
            </div>

            <label class="message-config-field message-config-field--switch">
              <span>@ 所有人</span>
              <a-switch v-model:checked="dingtalk.atAll" size="small" />
            </label>

            <div class="message-config-card__meta">更新时间：{{ formatUpdatedAt(dingtalk.updatedAt) }}</div>
          </div>
        </section>

        <section
          v-if="props.surface !== 'h5' || activeChannel === 'wecom'"
          class="message-config-card"
          :class="{ 'message-config-card--enabled': wecom.enabled }"
        >
          <div class="message-config-card__title-row">
            <div>
              <h3>企业微信群机器人</h3>
              <span>支持 Webhook、@ 手机号、@ 用户ID 和 @ 所有人。</span>
            </div>
            <a-button size="small" @click="openGuide('wecom')">操作指引</a-button>
          </div>

          <div class="message-config-card__form">
            <label class="message-config-field message-config-field--switch">
              <span>启用企业微信通知</span>
              <a-switch v-model:checked="wecom.enabled" size="small" />
            </label>

            <div class="message-config-field">
              <span>Webhook</span>
              <a-input
                v-model:value="wecom.webhook"
                autocomplete="off"
                data-1p-ignore="true"
                data-form-type="other"
                data-lpignore="true"
                name="message-notification-wecom-webhook"
                type="text"
                size="small"
                :placeholder="wecom.webhookConfigured ? '请输入新的机器人 Webhook' : '请输入企业微信群机器人 Webhook'"
              />
            </div>

            <div class="message-config-field-pair">
              <div class="message-config-field message-config-field--textarea">
                <span>@ 手机号</span>
                <a-textarea v-model:value="wecom.atMobilesText" :rows="2" placeholder="一行一个手机号，或用英文逗号分隔" />
              </div>

              <div class="message-config-field message-config-field--textarea">
                <span>@ 用户ID</span>
                <a-textarea v-model:value="wecom.atUserIdsText" :rows="2" placeholder="一行一个企业微信用户ID，或用英文逗号分隔" />
              </div>
            </div>

            <label class="message-config-field message-config-field--switch">
              <span>@ 所有人</span>
              <a-switch v-model:checked="wecom.atAll" size="small" />
            </label>

            <div class="message-config-card__meta">更新时间：{{ formatUpdatedAt(wecom.updatedAt) }}</div>
          </div>
        </section>
      </div>
    </a-spin>

    <div class="message-config-panel__footer">
      <a-button type="primary" :loading="saving" @click="saveConfig">保存配置</a-button>
    </div>

    <a-modal
      v-model:open="guideOpen"
      :title="guideTitle"
      :footer="null"
      :width="props.surface === 'h5' ? '100%' : 720"
      :wrap-class-name="props.surface === 'h5' ? 'h5-message-guide-modal' : undefined"
      class="message-config-guide-modal"
    >
      <ol v-if="guideChannel === 'dingtalk'" class="message-config-guide">
        <li>打开钉钉目标群，进入“群设置”或“智能群助手”。</li>
        <li>添加“自定义机器人”，安全设置建议选择“加签”，并记录 Webhook 与 Secret。</li>
        <li>如选择关键词安全策略，建议添加关键词“CodeFlow”，并在本页同步填写关键词。</li>
        <li>如果企业开启 IP 白名单，请将部署 Server 的出口 IP 加入白名单。</li>
        <li>回到本页填写 Webhook、Secret 和 @ 配置，启用后保存。</li>
      </ol>
      <ol v-else class="message-config-guide">
        <li>打开企业微信目标群，进入“群设置”。</li>
        <li>选择“群机器人”，新增或复制已有机器人的 Webhook。</li>
        <li>如企业限制机器人来源 IP，请将部署 Server 的出口 IP 加入允许列表。</li>
        <li>回到本页填写 Webhook 和 @ 配置，启用后保存。</li>
      </ol>
    </a-modal>
  </div>
</template>

<style scoped>
.message-config-panel {
  min-height: 0;
  min-width: 0;
  display: grid;
  gap: 12px;
  overflow: auto;
}

.message-config-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.message-config-panel__title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.25;
  color: var(--app-text);
}

.message-config-panel__subtitle {
  margin: 4px 0 0;
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.45;
}

.message-config-panel__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 10px;
}

.message-config-card {
  min-width: 0;
  border: 1px solid var(--app-divider);
  border-radius: 8px;
  background: var(--app-panel-bg);
  box-shadow: none;
  padding: 14px;
  display: grid;
  align-content: start;
  gap: 12px;
}

.message-config-card__title-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: flex-start;
}

.message-config-card__title-row h3 {
  margin: 0;
  font-size: 15px;
  color: var(--app-text);
}

.message-config-card__title-row span,
.message-config-field small,
.message-config-card__meta {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.4;
}

.message-config-card__form {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}

.message-config-field {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.message-config-field-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.message-config-field > span,
.message-config-field--switch > span {
  font-size: 12px;
  font-weight: 600;
  color: var(--app-text);
}

.message-config-field--switch {
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
}

.message-config-field--textarea :deep(textarea.ant-input) {
  min-height: 50px;
  resize: vertical;
}

.message-config-card__meta {
  grid-column: 1 / -1;
}

.message-config-panel__footer {
  display: flex;
  justify-content: flex-start;
  padding-top: 4px;
}

.message-config-guide {
  margin: 0;
  padding-left: 20px;
  display: grid;
  gap: 10px;
  line-height: 1.6;
}

:deep(.message-config-guide-modal .ant-modal-body) {
  max-height: min(62vh, 560px);
  overflow: auto;
}

@media (max-width: 1080px) {
  .message-config-panel__grid {
    grid-template-columns: 1fr;
  }
}

@media (max-height: 760px) and (min-width: 1081px) {
  .message-config-panel {
    gap: 8px;
  }

  .message-config-card {
    padding: 10px;
    gap: 8px;
  }

  .message-config-panel__subtitle {
    margin-top: 2px;
  }
}

@media (max-width: 720px) {
  .message-config-card {
    padding: 10px;
  }

  .message-config-field-pair {
    grid-template-columns: 1fr;
  }

  .message-config-panel__footer,
  .message-config-panel__footer :deep(.ant-btn) {
    width: 100%;
  }
}

/* H5 通过渠道分段切换单列表单，避免桌面双卡片和横向信息密度。 */
.message-config-panel--h5 {
  height: 100%;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  gap: 10px;
  overflow: hidden;
  padding: 2px 0 calc(14px + var(--safe-bottom, 0px));
}

.message-config-panel--h5 .message-config-panel__header {
  align-items: center;
  padding: 0 1px 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-divider) 78%, transparent);
}

.message-config-panel--h5 .message-config-panel__title {
  font-size: 18px;
}

.message-config-panel--h5 .message-config-panel__subtitle {
  max-width: 255px;
  font-size: 11px;
}

.message-config-panel--h5 .message-config-panel__header :deep(.ant-btn) {
  min-width: 44px;
  min-height: 40px;
  padding: 0 10px;
  border-radius: 12px;
}

.message-config-panel__channel-switch {
  height: 42px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 3px;
  padding: 3px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-bg-secondary) 88%, var(--app-surface));
}

.message-config-panel__channel-switch button {
  min-width: 0;
  border: 0;
  border-radius: 11px;
  color: var(--app-muted);
  background: transparent;
  font-size: 13px;
  font-weight: 650;
}

.message-config-panel__channel-switch button.active {
  color: var(--app-accent);
  background: var(--app-surface);
  box-shadow: 0 3px 10px color-mix(in srgb, #000 7%, transparent);
}

.message-config-panel--h5 > .ant-spin {
  min-height: 0;
  overflow: hidden;
}

.message-config-panel--h5 .message-config-panel__grid {
  height: 100%;
  grid-template-columns: minmax(0, 1fr);
  overflow-y: auto;
  padding: 1px 1px 4px;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.message-config-panel--h5 .message-config-panel__grid::-webkit-scrollbar {
  display: none;
}

.message-config-panel--h5 .message-config-card {
  min-height: 0;
  align-content: start;
  gap: 13px;
  padding: 14px;
  border-radius: 18px;
  border-color: color-mix(in srgb, var(--app-divider) 82%, transparent);
  background: color-mix(in srgb, var(--app-surface) 96%, transparent);
  box-shadow: 0 10px 24px color-mix(in srgb, #000 5%, transparent);
}

.message-config-panel--h5 .message-config-card__title-row {
  align-items: center;
}

.message-config-panel--h5 .message-config-card__title-row h3 {
  font-size: 16px;
}

.message-config-panel--h5 .message-config-card__title-row span {
  display: block;
  max-width: 235px;
  margin-top: 3px;
  font-size: 11px;
}

.message-config-panel--h5 .message-config-card__title-row :deep(.ant-btn) {
  min-height: 38px;
  border-radius: 11px;
  padding-inline: 10px;
}

.message-config-panel--h5 .message-config-panel__footer {
  padding: 0 1px;
}

.message-config-panel--h5 .message-config-panel__footer :deep(.ant-btn) {
  width: 100%;
  min-height: 48px;
  border-radius: 14px;
  font-size: 14px;
  font-weight: 680;
}

:global(.h5-message-guide-modal) {
  display: flex;
  align-items: flex-end;
}

:global(.h5-message-guide-modal .ant-modal) {
  top: 0;
  width: 100% !important;
  max-width: 100%;
  margin: 0;
  padding: 0;
}

:global(.h5-message-guide-modal .ant-modal-content) {
  max-height: min(72dvh, 560px);
  overflow: hidden;
  border-radius: 24px 24px 0 0;
  padding: 0;
}

:global(.h5-message-guide-modal .ant-modal-header) {
  margin: 0;
  padding: 18px 20px 12px;
  border-bottom: 1px solid var(--app-divider);
}

:global(.h5-message-guide-modal .ant-modal-body) {
  max-height: min(58dvh, 440px);
  overflow-y: auto;
  padding: 14px 18px max(18px, min(env(safe-area-inset-bottom, 0px), 10px));
}

/* 桌面后台：外层容器已提供页面总标题与 Tab，这里收敛为内容区层级并强化卡片层次。
   全部规则限定在 --default 下，H5 分支样式不受影响。 */
.message-config-panel--default {
  gap: 14px;
  /* 外层 admin-mobile-settings-panel__content 负责滚动，避免出现嵌套滚动条。 */
  overflow: visible;
}

.message-config-panel--default .message-config-panel__header {
  align-items: center;
  padding-bottom: 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-divider) 78%, transparent);
}

.message-config-panel--default .message-config-panel__title {
  font-size: 17px;
  font-weight: 650;
}

.message-config-panel--default .message-config-panel__subtitle {
  margin-top: 3px;
}

.message-config-panel--default .message-config-panel__grid {
  gap: 14px;
}

.message-config-panel--default .message-config-card {
  gap: 14px;
  padding: 16px;
  border-radius: 12px;
  border-color: color-mix(in srgb, var(--app-divider) 88%, transparent);
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}

.message-config-panel--default .message-config-card:hover {
  border-color: color-mix(in srgb, var(--app-accent) 30%, var(--app-divider));
  box-shadow: 0 8px 22px color-mix(in srgb, #000 6%, transparent);
}

.message-config-panel--default .message-config-card__title-row {
  align-items: center;
  padding-bottom: 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--app-divider) 72%, transparent);
}

.message-config-panel--default .message-config-card__title-row h3 {
  position: relative;
  padding-left: 15px;
  font-size: 15px;
  font-weight: 650;
}

/* 卡片状态圆点：未启用为中性灰，启用后转为成功色并带光晕。 */
.message-config-panel--default .message-config-card__title-row h3::before {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  width: 7px;
  height: 7px;
  margin-top: -3.5px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--app-muted) 38%, transparent);
}

.message-config-panel--default .message-config-card--enabled .message-config-card__title-row h3::before {
  background: var(--app-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--app-success) 20%, transparent);
}

.message-config-panel--default .message-config-card__form {
  gap: 12px;
}

.message-config-panel--default .message-config-panel__footer {
  justify-content: flex-end;
  padding-top: 2px;
}
</style>
