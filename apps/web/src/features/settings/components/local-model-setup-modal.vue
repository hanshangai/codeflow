<script setup lang="ts">
import { KeyOutlined, LockOutlined, RightOutlined, UserOutlined } from "@ant-design/icons-vue";

defineOptions({ name: "LocalModelSetupModal" });

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ dismiss: []; configure: []; login: [] }>();
</script>

<template>
  <a-modal
    :open="props.open"
    :footer="null"
    :width="460"
    centered
    :mask-closable="false"
    @cancel="emit('dismiss')"
  >
    <div class="local-model-guide">
      <div class="local-model-guide__icon"><KeyOutlined /></div>
      <h3 class="local-model-guide__title">开始使用前，先接入一个模型</h3>
      <p class="local-model-guide__desc">当前未登录，本机也没有检测到可用的模型配置。选择一种方式继续。</p>

      <button type="button" class="local-model-guide__option local-model-guide__option--primary" @click="emit('configure')">
        <span class="local-model-guide__option-icon"><KeyOutlined /></span>
        <span class="local-model-guide__option-body">
          <span class="local-model-guide__option-title">
            配置自己的模型 Key
            <span class="local-model-guide__tag">不上传</span>
          </span>
          <span class="local-model-guide__option-desc">支持 Claude / Codex，使用已有 Key 或自定义供应商。Key 只保存在本机。</span>
        </span>
        <RightOutlined class="local-model-guide__arrow" />
      </button>

      <button type="button" class="local-model-guide__option" @click="emit('login')">
        <span class="local-model-guide__option-icon local-model-guide__option-icon--muted"><UserOutlined /></span>
        <span class="local-model-guide__option-body">
          <span class="local-model-guide__option-title">登录账号</span>
          <span class="local-model-guide__option-desc">使用平台内置中转 Key（Codex），登录后自动启用</span>
        </span>
        <RightOutlined class="local-model-guide__arrow local-model-guide__arrow--muted" />
      </button>

      <div class="local-model-guide__privacy">
        <LockOutlined class="local-model-guide__lock" />
        <span><strong>私有 Key 只保存在本机</strong>，不会上传到平台或账号，也不会同步到其他设备。</span>
      </div>

      <button type="button" class="local-model-guide__later" @click="emit('dismiss')">暂不配置，先浏览</button>
    </div>
  </a-modal>
</template>

<style scoped>
.local-model-guide {
  display: grid;
  gap: 12px;
}

.local-model-guide__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--app-accent) 12%, var(--app-panel-bg));
  color: var(--app-accent);
  font-size: 24px;
}

.local-model-guide__title {
  margin: 2px 0 0;
  color: var(--app-text);
  font-size: 19px;
  font-weight: 600;
  line-height: 1.4;
}

.local-model-guide__desc {
  margin: 0 0 4px;
  color: var(--app-muted);
  font-size: 13px;
  line-height: 1.7;
}

.local-model-guide__option {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px;
  border: 1px solid var(--app-border);
  border-radius: 12px;
  background: var(--app-panel-bg);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.local-model-guide__option--primary {
  border-color: color-mix(in srgb, var(--app-accent) 32%, var(--app-border));
  background: color-mix(in srgb, var(--app-accent) 5%, var(--app-panel-bg));
}

.local-model-guide__option-icon {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--app-accent) 18%, var(--app-panel-bg));
  color: var(--app-accent);
  font-size: 18px;
}

.local-model-guide__option-icon--muted {
  background: var(--app-bg-secondary);
  color: var(--app-muted);
}

.local-model-guide__option-body {
  display: block;
  flex: 1;
  min-width: 0;
}

.local-model-guide__option-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--app-text);
  font-size: 14px;
  font-weight: 600;
}

.local-model-guide__tag {
  padding: 0 7px;
  border-radius: 9px;
  background: color-mix(in srgb, #2f7d4a 14%, var(--app-panel-bg));
  color: color-mix(in srgb, #2f7d4a 70%, var(--app-text));
  font-size: 11px;
  font-weight: 500;
  line-height: 18px;
}

.local-model-guide__option-desc {
  display: block;
  margin-top: 2px;
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
}

.local-model-guide__arrow {
  flex: 0 0 auto;
  color: var(--app-accent);
  font-size: 16px;
}

.local-model-guide__arrow--muted {
  color: var(--app-muted);
}

.local-model-guide__privacy {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 11px 12px;
  border-radius: 10px;
  background: var(--app-bg-secondary);
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.6;
}

.local-model-guide__privacy strong {
  color: var(--app-text);
  font-weight: 600;
}

.local-model-guide__lock {
  flex: 0 0 auto;
  margin-top: 2px;
  font-size: 16px;
}

.local-model-guide__later {
  padding: 4px 0 0;
  border: 0;
  background: transparent;
  color: var(--app-muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.local-model-guide__later:hover {
  color: var(--app-text);
}
</style>
