<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { DownOutlined, GiftOutlined, MenuOutlined, MessageOutlined, PoweroffOutlined, ReloadOutlined, UserOutlined } from "@ant-design/icons-vue";
import type { AccessContext, AccountRole } from "@codeflowai/shared";

import { formatAccountRole, formatAccountRoleTag } from "../accountDisplay";
import AccountAvatar from "./account-avatar.vue";

defineOptions({ name: "UserMenuTrigger" });

const COPY = {
  account: "个人信息",
  redemption: "流量兑换",
  feedback: "意见反馈",
  checkUpdate: "检查更新",
  exitApp: "退出应用",
} as const;

const props = defineProps<{
  displayName: string;
  avatarUrl?: string | null;
  accountRole: AccountRole | null;
  accessContext?: AccessContext | null;
  enterpriseName?: string | null;
  pendingInviteCount?: number;
  hideDisplayName?: boolean;
  hideRedemption?: boolean;
  /** 仅桌面壳提供检查更新与退出应用；网页端不展示这两项。 */
  showCheckUpdate?: boolean;
  showExitApp?: boolean;
}>();

const emit = defineEmits<{
  (e: "open-account"): void;
  (e: "open-redemption"): void;
  (e: "open-feedback"): void;
  (e: "check-update"): void;
  (e: "exit-app"): void;
}>();

const pendingInviteCount = computed(() => Math.max(0, Number(props.pendingInviteCount ?? 0)));
const roleTagColor = computed(() => props.accountRole === "super_admin" ? undefined : formatAccountRoleTag(props.accountRole, props.accessContext));
const visibleEnterpriseName = computed(() => (
  props.accessContext?.editionType === "ENTERPRISE"
    ? null
    : String(props.enterpriseName ?? "").trim() || null
));
const summaryTitle = computed(() => {
  const parts = [props.displayName, formatAccountRole(props.accountRole, props.accessContext)];
  if (visibleEnterpriseName.value) parts.push(visibleEnterpriseName.value);
  return parts.filter(Boolean).join(" · ");
});

// 受控 open 状态：菜单动作先主动关闭下拉层，避免弹框/抽屉与菜单浮层叠加。
const dropdownOpen = ref(false);

/** antd 自身/外部触发的 open 变化统一写回受控状态。 */
function handleOpenChange(next: boolean): void {
  dropdownOpen.value = next;
}

/** 普通菜单动作先关闭下拉层，避免后续弹框/抽屉与菜单浮层叠加。 */
async function emitMenuAction(action: "open-account" | "open-redemption" | "open-feedback" | "check-update" | "exit-app"): Promise<void> {
  dropdownOpen.value = false;
  await nextTick();
  if (action === "open-account") emit("open-account");
  else if (action === "open-redemption") emit("open-redemption");
  else if (action === "open-feedback") emit("open-feedback");
  else if (action === "check-update") emit("check-update");
  else emit("exit-app");
}
</script>

<template>
  <a-dropdown
    :open="dropdownOpen"
    :trigger="['click']"
    placement="bottomRight"
    overlay-class-name="account-menu-dropdown"
    @update:open="handleOpenChange"
  >
    <button
      class="user-menu-trigger"
      :class="{ 'user-menu-trigger--compact': hideDisplayName }"
      type="button"
      :title="summaryTitle"
      :aria-label="summaryTitle"
    >
      <span class="user-menu-trigger__avatar-wrap">
        <AccountAvatar class="user-menu-trigger__avatar" :display-name="displayName" :avatar-url="avatarUrl" :size="hideDisplayName ? 30 : 28" />
        <span v-if="pendingInviteCount > 0" class="user-menu-trigger__badge">{{ pendingInviteCount }}</span>
      </span>
      <span v-if="!hideDisplayName" class="user-menu-trigger__meta">
        <strong class="user-menu-trigger__name">{{ displayName }}</strong>
        <a-tag
          class="user-menu-trigger__role"
          :class="{ 'user-menu-trigger__role--super-admin': accountRole === 'super_admin' }"
          :color="roleTagColor"
          :bordered="false"
        >
          {{ formatAccountRole(accountRole, accessContext) }}
        </a-tag>
        <span v-if="visibleEnterpriseName" class="user-menu-trigger__enterprise">{{ visibleEnterpriseName }}</span>
      </span>
      <MenuOutlined v-if="hideDisplayName" class="user-menu-trigger__arrow user-menu-trigger__arrow--compact" />
      <DownOutlined v-else class="user-menu-trigger__arrow" />
    </button>
    <template #overlay>
      <a-menu>
        <a-menu-item key="account" @click="emitMenuAction('open-account')">
          <UserOutlined />
          {{ COPY.account }}
        </a-menu-item>
        <a-menu-item v-if="!hideRedemption" key="redemption" @click="emitMenuAction('open-redemption')">
          <GiftOutlined />
          {{ COPY.redemption }}
        </a-menu-item>
        <a-menu-item key="feedback" @click="emitMenuAction('open-feedback')">
          <MessageOutlined />
          {{ COPY.feedback }}
        </a-menu-item>
        <a-menu-item v-if="showCheckUpdate" key="check-update" @click="emitMenuAction('check-update')">
          <ReloadOutlined />
          {{ COPY.checkUpdate }}
        </a-menu-item>
        <template v-if="showExitApp">
          <a-menu-divider />
          <a-menu-item key="exit-app" @click="emitMenuAction('exit-app')">
            <PoweroffOutlined />
            {{ COPY.exitApp }}
          </a-menu-item>
        </template>
      </a-menu>
    </template>
  </a-dropdown>
</template>

<style scoped>
.user-menu-trigger {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  max-width: min(320px, 24vw);
  padding: 4px 9px 4px 4px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 12%, var(--app-border));
  border-radius: 999px;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--app-panel-bg) 96%, #fff 4%), color-mix(in srgb, var(--app-panel-bg) 88%, var(--app-bg) 12%));
  color: var(--app-text);
  cursor: pointer;
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}

/* 紧凑态只保留头像，箭头作为头像右下角的小徽标。 */
.user-menu-trigger--compact {
  max-width: none;
  gap: 0;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: none;
}

.user-menu-trigger:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--app-accent) 28%, var(--app-border));
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.09);
}

.user-menu-trigger--compact:hover {
  transform: none;
  box-shadow: none;
}

.user-menu-trigger--compact:hover .user-menu-trigger__avatar-wrap {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--app-panel-bg) 92%, transparent), 0 0 0 4px color-mix(in srgb, var(--app-accent) 34%, transparent);
}

.user-menu-trigger:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--app-accent) 42%, transparent);
  outline-offset: 3px;
}

.user-menu-trigger__avatar-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--app-panel-bg) 92%, transparent), 0 0 0 3px color-mix(in srgb, var(--app-accent) 16%, transparent);
}

.user-menu-trigger__avatar {
  display: block;
}

.user-menu-trigger__badge {
  position: absolute;
  top: -5px;
  right: -6px;
  min-width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  border-radius: 999px;
  background: #d03050;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  box-shadow: 0 8px 16px rgba(208, 48, 80, 0.22);
}

.user-menu-trigger__meta {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  text-align: left;
  white-space: nowrap;
}

.user-menu-trigger__name {
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  font-weight: 700;
  line-height: 1;
}

:deep(.user-menu-trigger__role.ant-tag) {
  margin-inline-end: 0;
  min-width: 0;
  padding: 0 7px;
  font-size: 11px;
  font-weight: 700;
  line-height: 19px;
  border-radius: 999px;
  flex: 0 0 auto;
}

:deep(.user-menu-trigger__role--super-admin.ant-tag) {
  background: color-mix(in srgb, #ff7043 14%, var(--app-panel-bg) 86%);
  color: color-mix(in srgb, #c2410c 78%, var(--app-text) 22%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, #ff7043 26%, transparent);
}

.user-menu-trigger__enterprise {
  max-width: 112px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1;
}

.user-menu-trigger__arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-text) 5%, transparent);
  color: color-mix(in srgb, var(--app-muted) 88%, var(--app-text) 12%);
  font-size: 10px;
  transition: background-color 0.16s ease, color 0.16s ease;
}

.user-menu-trigger:hover .user-menu-trigger__arrow {
  background: color-mix(in srgb, var(--app-accent) 12%, transparent);
  color: var(--app-text);
}

.user-menu-trigger__arrow--compact {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 14px;
  height: 14px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-bg);
  font-size: 9px;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12);
}

.user-menu-trigger--compact:hover .user-menu-trigger__arrow {
  background: color-mix(in srgb, var(--app-accent) 14%, var(--app-panel-bg));
  color: var(--app-text);
}

</style>

<style>
.account-menu-dropdown .ant-dropdown-menu {
  background: var(--app-panel-bg);
  border: 1px solid var(--app-border);
  box-shadow: 0 18px 42px rgba(15, 23, 42, 0.14);
}

.account-menu-dropdown .ant-dropdown-menu-item,
.account-menu-dropdown .ant-dropdown-menu-title-content {
  color: var(--app-text);
}

.account-menu-dropdown .ant-dropdown-menu-item:hover {
  background: color-mix(in srgb, var(--app-accent) 10%, var(--app-panel-bg));
}

.account-menu-dropdown .ant-dropdown-menu-item .anticon,
.account-menu-dropdown .ant-dropdown-menu-item svg {
  color: var(--app-text);
}

.account-menu-dropdown .ant-dropdown-menu-item-divider {
  background-color: var(--app-border);
}
</style>
