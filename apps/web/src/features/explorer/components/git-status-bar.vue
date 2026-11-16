<script setup lang="ts">
import { computed } from "vue";
import { BranchesOutlined, ArrowUpOutlined, ArrowDownOutlined, CheckCircleOutlined, ExclamationCircleOutlined } from "@ant-design/icons-vue";
import type { GitStatusResult } from "@codeflowai/shared";

defineOptions({ name: "GitStatusBar" });

const props = defineProps<{
  status: GitStatusResult;
}>();

const changeCount = computed(() => {
  return (props.status.staged?.length ?? 0) + (props.status.unstaged?.length ?? 0) + (props.status.untracked?.length ?? 0);
});

const isClean = computed(() => changeCount.value === 0);
</script>

<template>
  <div class="git-status-bar" v-if="status.isRepo">
    <BranchesOutlined class="git-status-bar__icon" />
    <span class="git-status-bar__branch">{{ status.branch ?? 'detached' }}</span>
    <template v-if="status.ahead > 0 || status.behind > 0">
      <span v-if="status.ahead > 0" class="git-status-bar__sync" title="Ahead">
        <ArrowUpOutlined /> {{ status.ahead }}
      </span>
      <span v-if="status.behind > 0" class="git-status-bar__sync" title="Behind">
        <ArrowDownOutlined /> {{ status.behind }}
      </span>
    </template>
    <slot name="after-branch" />
    <span class="git-status-bar__spacer" />
    <slot>
      <span :class="isClean ? 'git-status-bar__clean' : 'git-status-bar__dirty'">
        <CheckCircleOutlined v-if="isClean" />
        <ExclamationCircleOutlined v-else />
        {{ isClean ? 'Clean' : `${changeCount} 变更` }}
      </span>
    </slot>
  </div>
</template>

<style scoped>
.git-status-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 6px 0;
  font-size: 12px;
  background: transparent;
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
  flex-shrink: 0;
}

.git-status-bar__icon {
  color: var(--app-accent, #c96442);
}

.git-status-bar__branch {
  font-weight: 600;
}

.git-status-bar__sync {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--app-muted);
}

.git-status-bar__spacer {
  flex: 1;
}

.git-status-bar__clean {
  color: var(--app-success, #52c41a);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.git-status-bar__dirty {
  color: var(--app-warning, #faad14);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
</style>

