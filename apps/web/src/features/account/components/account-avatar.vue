<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { initialsOf } from "../accountDisplay";

defineOptions({ name: "AccountAvatar" });

const props = withDefaults(defineProps<{
  displayName?: string | null;
  avatarUrl?: string | null;
  size?: number;
  shape?: "circle" | "rounded";
}>(), {
  displayName: "",
  avatarUrl: null,
  size: 40,
  shape: "circle",
});

/** 未上传头像时按名称稳定挑选一个内置动物头像。 */
const DEFAULT_AVATAR_KEYS = ["cat", "dog", "rabbit", "fox", "panda", "bear"] as const;

const normalizedDisplayName = computed(() => String(props.displayName ?? "").trim() || "用户");
const normalizedAvatarUrl = computed(() => String(props.avatarUrl ?? "").trim());
const imageFailed = ref(false);
const defaultAvatarUrl = computed(() => {
  let hash = 0;
  for (const char of normalizedDisplayName.value) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return `/images/avatars/${DEFAULT_AVATAR_KEYS[hash % DEFAULT_AVATAR_KEYS.length]}.svg`;
});
const resolvedAvatarUrl = computed(() => imageFailed.value ? "" : normalizedAvatarUrl.value || defaultAvatarUrl.value);
const hasImage = computed(() => Boolean(resolvedAvatarUrl.value));
const avatarStyle = computed(() => ({
  "--account-avatar-size": `${Math.max(24, Number(props.size ?? 40) || 40)}px`,
}));
const fallbackText = computed(() => initialsOf(normalizedDisplayName.value));

/** 头像或名称变化后重新尝试加载，避免错误状态粘住新头像。 */
watch([normalizedAvatarUrl, normalizedDisplayName], () => { imageFailed.value = false; });
</script>

<template>
  <span
    class="account-avatar"
    :class="[`account-avatar--${shape}`, { 'account-avatar--image': hasImage }]"
    :style="avatarStyle"
    :title="normalizedDisplayName"
  >
    <img v-if="hasImage" :src="resolvedAvatarUrl" :alt="`${normalizedDisplayName} 的头像`" class="account-avatar__image"
      @error="imageFailed = true" />
    <span v-else class="account-avatar__fallback">{{ fallbackText }}</span>
  </span>
</template>

<style scoped>
.account-avatar {
  width: var(--account-avatar-size);
  height: var(--account-avatar-size);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  user-select: none;
  flex: 0 0 auto;
  background: linear-gradient(135deg, var(--app-accent), #eb8a57);
  color: #fff;
  box-shadow: 0 12px 24px rgba(217, 119, 87, 0.18);
}

.account-avatar--circle {
  border-radius: 50%;
}

.account-avatar--rounded {
  border-radius: min(24px, calc(var(--account-avatar-size) * 0.34));
}

.account-avatar--image {
  background: color-mix(in srgb, var(--app-panel-bg) 94%, #ffffff);
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.12);
}

.account-avatar__image {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.account-avatar__fallback {
  font-size: calc(var(--account-avatar-size) * 0.36);
  font-weight: 800;
  line-height: 1;
  letter-spacing: 0.02em;
}
</style>
