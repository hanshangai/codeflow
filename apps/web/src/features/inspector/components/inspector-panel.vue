<script setup lang="ts">
import { computed, ref } from "vue";
import type { ConversationProcess, ConversationTool } from "@codeflowai/shared";
import { RightOutlined, DownOutlined, CloseOutlined } from "@ant-design/icons-vue";

import { useChatStore } from "../../../store/chat";
import { useConfigStore } from "../../../store/config";
import { useUiStore } from "../../../store/ui";
import { useApiContext } from "../../../composables/useApiContext";

import EngineEventsPanel from "./engine-events-panel.vue";
import ProcessDetails from "../../messages/components/process-details.vue";

defineOptions({ name: "InspectorPanel" });

const config = useConfigStore();
const chat = useChatStore();
const ui = useUiStore();
const { ctx } = useApiContext();

/* ---- Tab 切换 ---- */
const activeTab = ref<"tools" | "events">("tools");

const thread = computed(() => chat.selectedThread);
const conversation = computed(() => chat.selectedDisplayConversation);

/* ---- 工具类型判断 ---- */
const EXPLORE_TOOL_TYPES = new Set([
  "commandexecution", "command_execution", "bash",
  "read_file", "readfile", "read",
  "search_files", "searchfiles", "search",
  "list_files", "listfiles", "list_directory", "listdirectory", "list",
]);

function isExploreType(tool: ConversationTool): boolean {
  return EXPLORE_TOOL_TYPES.has(String(tool.toolType ?? "").toLowerCase());
}

/* ---- 聚合分组 ---- */
type InspectorGroup =
  | { type: "process"; key: string; process: ConversationProcess }
  | { type: "explore"; key: string; label: string; tools: ConversationTool[] }
  | { type: "tool"; key: string; tool: ConversationTool };

/** 保留轻量过程入口，工具明细仅在所属过程展开时读取。 */
const groupedTools = computed<InspectorGroup[]>(() => {
  const c = conversation.value;
  if (!c) return [];

  const groups: InspectorGroup[] = [];
  let pending: ConversationTool[] = [];

  function flush(): void {
    if (pending.length > 0) {
      const key = pending.map((t) => t.id).join("_");
      groups.push({ type: "explore", key, label: `探索（${pending.length} 步）`, tools: [...pending] });
      pending = [];
    }
  }

  for (const tool of c.items) {
    if (tool.kind === "process") {
      flush();
      groups.push({ type: "process", key: String(tool.id), process: tool });
      continue;
    }
    if (tool.kind !== "tool") continue;
    if (isExploreType(tool)) {
      pending.push(tool);
    } else {
      flush();
      groups.push({ type: "tool", key: String(tool.id), tool });
    }
  }
  flush();
  return groups;
});

/* ---- 展开状态管理 ---- */
const expandedGroups = ref(new Set<string>());

function toggleGroup(key: string): void {
  if (expandedGroups.value.has(key)) {
    expandedGroups.value.delete(key);
  } else {
    expandedGroups.value.add(key);
  }
}

/* ---- 工具详情弹窗 ---- */
const toolModalOpen = ref(false);
const selectedTool = ref<ConversationTool | null>(null);

function openToolDetail(tool: ConversationTool): void {
  selectedTool.value = tool;
  toolModalOpen.value = true;
}

function closeToolDetail(): void {
  toolModalOpen.value = false;
  selectedTool.value = null;
}

/** 获取工具状态的标签和颜色。 */
function isTodoListTool(tool: ConversationTool): boolean {
  return tool.toolType === "update_plan" || tool.toolType === "todowrite";
}

function statusTag(tool: ConversationTool): { label: string; color: string } {
  if (tool.status === "started") return { label: "进行中", color: "orange" };
  if (tool.status === "completed") return { label: isTodoListTool(tool) ? "已更新" : "已完成", color: "green" };
  if (tool.status === "incomplete") return { label: "收尾缺失", color: "gold" };
  if (tool.status === "failed") return { label: "失败", color: "red" };
  return { label: "未知", color: "default" };
}

/** 获取 explore 组的汇总状态。 */
function groupStatus(tools: ConversationTool[]): { label: string; color: string } {
  if (tools.some((t) => t.status === "started")) return { label: "进行中", color: "orange" };
  if (tools.some((t) => t.status === "failed")) return { label: "部分失败", color: "red" };
  if (tools.some((t) => t.status === "incomplete")) return { label: "收尾缺失", color: "gold" };
  return { label: "已完成", color: "green" };
}
</script>

<template>
  <div class="inspector">
    <div class="inspector__header">
      <div class="inspector__title">调试面板</div>
      <a-space :size="8">
        <div class="inspector__sub">事件序号：{{ chat.activeWorkspaceLastEventSeq }}</div>
        <a-button type="text" size="small" title="关闭调试" @click="ui.toggleInspector()">
          <template #icon><CloseOutlined /></template>
        </a-button>
      </a-space>
    </div>

    <a-empty v-if="!thread" description="请选择会话" />

    <template v-else>
      <div class="inspector__section">
        <div class="inspector__section-title">会话信息</div>
        <div class="inspector__kv"><span class="k">标题</span><span class="v">{{ thread.title }}</span></div>
        <div class="inspector__kv"><span class="k">会话ID</span><span class="v mono">{{ thread.id }}</span></div>
        <div class="inspector__kv"><span class="k">引擎</span><span class="v">{{ thread.engine }}</span></div>
        <div class="inspector__kv">
          <span class="k">引擎会话ID</span>
          <span class="v mono">{{ conversation?.engineSessionId ?? "-" }}</span>
        </div>
        <div class="inspector__kv">
          <span class="k">{{ conversation?.runningTurnStartedAt ? '运行中' : '上次轮次' }}</span>
          <span class="v mono">{{ conversation?.runningTurnId ?? "-" }}</span>
        </div>
      </div>

      <!-- Tab 切换 -->
      <div class="inspector__tabs">
        <div
          class="inspector__tab"
          :class="{ 'inspector__tab--active': activeTab === 'tools' }"
          @click="activeTab = 'tools'"
        >
          工具
        </div>
        <div
          class="inspector__tab"
          :class="{ 'inspector__tab--active': activeTab === 'events' }"
          @click="activeTab = 'events'"
        >
          事件
        </div>
      </div>

      <!-- 工具 Tab -->
      <div v-if="activeTab === 'tools'" class="inspector__section inspector__section--scroll">
        <div v-if="!groupedTools.length" class="inspector__muted">暂无工具事件。</div>

        <template v-for="group in groupedTools" :key="group.key">
          <ProcessDetails
            v-if="group.type === 'process'"
            :key="`${config.workspaceId}:${thread.id}:${chat.threadContentEpochByThreadId[thread.id] ?? 0}:${group.key}`"
            :item="group.process"
            :workspace-id="config.workspaceId ?? undefined"
            :thread-id="thread.id"
            :api-context="ctx"
            tools-only
          />
          <!-- 探索聚合组 -->
          <div v-else-if="group.type === 'explore'" class="inspector__group">
            <div class="inspector__group-header" @click="toggleGroup(group.key)">
              <div class="inspector__group-title">
                <span class="inspector__group-arrow"><DownOutlined v-if="expandedGroups.has(group.key)" /><RightOutlined v-else /></span>
                <span>{{ group.label }}</span>
                <a-tag :color="groupStatus(group.tools).color" style="margin-left: auto">
                  {{ groupStatus(group.tools).label }}
                </a-tag>
              </div>
            </div>
            <div v-if="expandedGroups.has(group.key)" class="inspector__group-body">
              <div
                v-for="t in group.tools"
                :key="t.id"
                class="inspector__tool inspector__tool--nested"
                @click="openToolDetail(t)"
              >
                <div class="inspector__tool-title">
                  <span>{{ t.title }}</span>
                  <a-tag :color="statusTag(t).color">{{ statusTag(t).label }}</a-tag>
                </div>
                <div class="inspector__tool-sub mono">#{{ t.id }}</div>
                <div v-if="t.durationMs != null" class="inspector__tool-sub">耗时：{{ t.durationMs }}ms</div>
              </div>
            </div>
          </div>

          <!-- 独立工具 -->
          <div v-else class="inspector__tool" @click="openToolDetail(group.tool)">
            <div class="inspector__tool-title">
              <span>{{ group.tool.title }}</span>
              <a-tag :color="statusTag(group.tool).color">{{ statusTag(group.tool).label }}</a-tag>
            </div>
            <div class="inspector__tool-sub mono">#{{ group.tool.id }}</div>
            <div v-if="group.tool.durationMs != null" class="inspector__tool-sub">耗时：{{ group.tool.durationMs }}ms</div>
            <div v-if="group.tool.changes?.length" class="inspector__tool-sub">变更：{{ group.tool.changes.length }} 个文件</div>
          </div>
        </template>
      </div>

      <!-- 事件 Tab -->
      <div v-if="activeTab === 'events'" class="inspector__section inspector__section--scroll">
        <EngineEventsPanel :thread-id="thread.id" />
      </div>
    </template>
  </div>

  <a-modal
    :open="toolModalOpen"
    title="工具详情"
    :footer="null"
    @cancel="closeToolDetail"
    width="70%"
    :style="{ top: 'max(56px, 10%)' }"
    :body-style="{ maxHeight: '70vh', overflow: 'auto' }"
  >
    <div v-if="selectedTool" style="display: grid; gap: 10px">
      <div class="inspector__muted">类型：{{ selectedTool.toolType }}，状态：{{ selectedTool.status }}</div>
      <pre v-if="selectedTool.detail" class="msg__pre">{{ selectedTool.detail }}</pre>
      <pre v-if="selectedTool.output" class="msg__pre msg__pre--output">{{ selectedTool.output }}</pre>
    </div>
  </a-modal>
</template>

