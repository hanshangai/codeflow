<script setup lang="ts">
import { ref, watch } from "vue";
import { message } from "ant-design-vue";
import {
  PlusOutlined,
  DeleteOutlined,
  HolderOutlined,
  PlayCircleOutlined,
  StopOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  RocketOutlined,
  BugOutlined,
  BuildOutlined,
  CloudUploadOutlined,
  CodeOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  ToolOutlined,
} from "@ant-design/icons-vue";
import type { TerminalAction, TerminalShellOption } from "@codeflowai/shared";

import { useConfigStore } from "../../../store/config";
import { useApiContext } from "../../../composables/useApiContext";
import { saveTerminalActions } from "../../../api/terminal";

const props = defineProps<{
  open: boolean;
  actions: TerminalAction[];
  shellOptions: TerminalShellOption[];
}>();

const emit = defineEmits<{
  (e: "update:open", v: boolean): void;
  (e: "saved", actions: TerminalAction[]): void;
}>();

const config = useConfigStore();
const { ctx } = useApiContext();

const localActions = ref<TerminalAction[]>([]);
const saving = ref(false);

const iconOptions = [
  { value: "play", label: "Play", icon: PlayCircleOutlined, color: "#52c41a" },
  { value: "stop", label: "Stop", icon: StopOutlined, color: "#ff4d4f" },
  { value: "reload", label: "Reload", icon: ReloadOutlined, color: "#1677ff" },
  { value: "rocket", label: "Rocket", icon: RocketOutlined, color: "#722ed1" },
  { value: "bug", label: "Bug", icon: BugOutlined, color: "#eb2f96" },
  { value: "build", label: "Build", icon: BuildOutlined, color: "#fa8c16" },
  { value: "upload", label: "Upload", icon: CloudUploadOutlined, color: "#13c2c2" },
  { value: "code", label: "Code", icon: CodeOutlined, color: "#2f54eb" },
  { value: "database", label: "Database", icon: DatabaseOutlined, color: "#faad14" },
  { value: "experiment", label: "Experiment", icon: ExperimentOutlined, color: "#a0d911" },
  { value: "tool", label: "Tool", icon: ToolOutlined, color: "#8c8c8c" },
];

const colorOptions = [
  { value: "default", label: "Default", bg: "#8c8c8c" },
  { value: "primary", label: "Primary", bg: "var(--app-accent)" },
  { value: "danger", label: "Danger", bg: "#ff4d4f" },
  { value: "success", label: "Success", bg: "#52c41a" },
  { value: "warning", label: "Warning", bg: "#faad14" },
  { value: "purple", label: "Purple", bg: "#722ed1" },
  { value: "cyan", label: "Cyan", bg: "#13c2c2" },
];

watch(
  () => props.open,
  (open) => {
    if (open) {
      localActions.value = props.actions.map((a) => ({ ...a }));
    }
  },
);

function addAction() {
  localActions.value.push({
    id: `action_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    label: "",
    command: "",
    shell: null,
    cwd: null,
    icon: null,
    color: null,
    order: localActions.value.length,
    autoRun: false,
    enabled: true,
  });
}

function removeAction(index: number) {
  localActions.value.splice(index, 1);
}

async function save() {
  if (!config.workspaceId) return;
  saving.value = true;
  try {
    const saved = await saveTerminalActions(ctx.value, {
      workspaceId: config.workspaceId,
      actions: localActions.value,
    });
    message.success("操作配置已保存");
    emit("saved", saved);
  } catch (e) {
    message.error(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <a-modal
    :open="props.open"
    title="自定义操作"
    :width="680"
    @cancel="emit('update:open', false)"
    @ok="save"
    :confirm-loading="saving"
    ok-text="保存"
    cancel-text="取消"
  >
    <div class="tae">
      <div v-if="!localActions.length" class="tae__empty">
        暂无自定义操作，点击下方按钮添加
      </div>

      <div v-for="(action, idx) in localActions" :key="action.id" class="tae__card">
        <div class="tae__card-header">
          <HolderOutlined class="tae__drag-handle" />
          <span class="tae__card-num">#{{ idx + 1 }}</span>
          <span class="tae__enabled-switch">
            <a-switch v-model:checked="action.enabled" size="small" />
            <span class="tae__switch-label">启用</span>
          </span>
          <span class="tae__card-spacer" />
          <span class="tae__auto-run-switch">
            <ThunderboltOutlined :style="{ color: action.autoRun ? 'var(--app-accent)' : 'var(--app-muted)', fontSize: '12px' }" />
            <a-switch v-model:checked="action.autoRun" size="small" />
            <span class="tae__switch-label">自动</span>
          </span>
          <a-button type="text" danger @click="removeAction(idx)">
            <DeleteOutlined />
          </a-button>
        </div>

        <div class="tae__card-body">
          <div class="tae__row">
            <div class="tae__field tae__field--name">
              <label class="tae__label">名称</label>
              <a-input v-model:value="action.label" placeholder="按钮显示文字" />
            </div>
            <div class="tae__field tae__field--shell">
              <label class="tae__label">终端类型</label>
              <a-select
                v-model:value="action.shell"
                placeholder="自动检测（默认）"
                allow-clear
                :options="props.shellOptions"
                style="width: 100%"
              />
            </div>
            <div class="tae__field tae__field--cwd">
              <label class="tae__label">工作目录（仅 workspace 内）</label>
              <a-input v-model:value="action.cwd" placeholder="可选，默认 workspace；支持相对路径" allow-clear />
            </div>
          </div>

          <div class="tae__field">
            <label class="tae__label">命令</label>
            <a-textarea
              v-model:value="action.command"
              placeholder="执行的命令，支持多行"
              :auto-size="{ minRows: 2, maxRows: 6 }"
              style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px"
            />
          </div>

          <div class="tae__row">
            <div class="tae__field tae__field--visual">
              <label class="tae__label">图标</label>
              <a-select v-model:value="action.icon" placeholder="无" allow-clear style="width: 100%">
                <a-select-option v-for="opt in iconOptions" :key="opt.value" :value="opt.value">
                  <span style="display: inline-flex; align-items: center; gap: 6px">
                    <component :is="opt.icon" :style="{ color: opt.color }" />
                    {{ opt.label }}
                  </span>
                </a-select-option>
              </a-select>
            </div>
            <div class="tae__field tae__field--visual">
              <label class="tae__label">颜色</label>
              <a-select v-model:value="action.color" placeholder="Default" allow-clear style="width: 100%">
                <a-select-option v-for="opt in colorOptions" :key="opt.value" :value="opt.value">
                  <span style="display: inline-flex; align-items: center; gap: 6px">
                    <span :style="{ width: '12px', height: '12px', borderRadius: '3px', background: opt.bg, display: 'inline-block' }" />
                    {{ opt.label }}
                  </span>
                </a-select-option>
              </a-select>
            </div>
            <div style="flex: 1" />
          </div>
        </div>
      </div>

      <a-button type="dashed" block @click="addAction" style="margin-top: 4px">
        <PlusOutlined /> 添加操作
      </a-button>
    </div>
  </a-modal>
</template>

<style scoped>
.tae {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 60vh;
  overflow-y: auto;
}

.tae__auto-run-switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.tae__enabled-switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 4px;
}

.tae__switch-label {
  font-size: 12px;
  color: var(--app-muted);
  user-select: none;
}

.tae__empty {
  text-align: center;
  color: var(--app-muted);
  padding: 24px 0;
  font-size: 13px;
}

.tae__card {
  border: 1px solid var(--app-divider);
  border-radius: 8px;
  overflow: hidden;
}

.tae__card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--app-code-header-bg);
  border-bottom: 1px solid var(--app-divider);
}

.tae__drag-handle {
  color: var(--app-muted);
  cursor: grab;
  font-size: 12px;
}

.tae__card-num {
  font-size: 12px;
  color: var(--app-muted);
  font-weight: 500;
}

.tae__card-spacer {
  flex: 1;
}

.tae__card-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tae__row {
  display: flex;
  gap: 10px;
}

.tae__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tae__field--name {
  flex: 1;
}

.tae__field--shell {
  width: 170px;
  flex-shrink: 0;
}

.tae__field--cwd {
  flex: 1;
}

.tae__field--visual {
  width: 140px;
  flex-shrink: 0;
}

.tae__label {
  font-size: 12px;
  color: var(--app-muted);
  line-height: 1;
}
</style>

