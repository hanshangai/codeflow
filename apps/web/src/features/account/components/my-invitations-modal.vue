<script setup lang="ts">
import { ReloadOutlined } from "@ant-design/icons-vue";
import type { MyInvitationInviteeItem } from "@codeflowai/shared";
import { message } from "ant-design-vue";
import { ref, watch } from "vue";

import { listMyInvitations } from "../../../api/account";
import { useApiContext } from "../../../composables/useApiContext";
import { formatTimestamp } from "../accountDisplay";

defineOptions({ name: "MyInvitationsModal" });

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (event: "close"): void }>();
const { ctx } = useApiContext();

const items = ref<MyInvitationInviteeItem[]>([]);
const loading = ref(false);
const errorMessage = ref("");
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
let requestSequence = 0;

const columns = [
  { title: "注册姓名", dataIndex: "fullName", key: "fullName", width: 180 },
  { title: "邮箱", dataIndex: "maskedEmail", key: "maskedEmail", width: 240 },
  { title: "注册时间", dataIndex: "registeredAt", key: "registeredAt", width: 190 },
] as const;

/** 加载本人邀请记录；序号用于阻止翻页时旧响应覆盖新页。 */
async function loadInvitations(): Promise<void> {
  const sequence = ++requestSequence;
  loading.value = true;
  errorMessage.value = "";
  try {
    const result = await listMyInvitations(ctx.value, { page: page.value, pageSize: pageSize.value });
    if (sequence !== requestSequence) return;
    if (!result.ok) {
      errorMessage.value = result.message || "邀请记录加载失败";
      message.error(errorMessage.value);
      return;
    }
    items.value = result.items;
    total.value = result.total;
    page.value = result.page;
    pageSize.value = result.pageSize;
  } catch (error) {
    if (sequence !== requestSequence) return;
    errorMessage.value = error instanceof Error ? `邀请记录加载失败：${error.message}` : "邀请记录加载失败";
    message.error(errorMessage.value);
  } finally {
    if (sequence === requestSequence) loading.value = false;
  }
}

/** 切换分页并重新查询，页容量变化时回到第一页。 */
function changePage(nextPage: number, nextPageSize: number): void {
  page.value = nextPageSize === pageSize.value ? nextPage : 1;
  pageSize.value = nextPageSize;
  void loadInvitations();
}

/** 关闭查询弹窗并作废仍在途的响应。 */
function close(): void {
  requestSequence += 1;
  loading.value = false;
  emit("close");
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    page.value = 1;
    void loadInvitations();
  },
);
</script>

<template>
  <a-modal
    :open="open"
    title="我的邀请记录"
    :width="720"
    :footer="null"
    destroy-on-close
    @cancel="close"
  >
    <div class="my-invitations">
      <header class="my-invitations__toolbar">
        <span>共 {{ total }} 人</span>
        <a-button aria-label="刷新邀请记录" :loading="loading" @click="loadInvitations">
          <template #icon><ReloadOutlined /></template>
        </a-button>
      </header>

      <div class="my-invitations__feedback">
        <a-alert v-if="errorMessage" type="error" show-icon :message="errorMessage" />
      </div>

      <div class="my-invitations__table">
        <a-table
          :columns="columns"
          :data-source="items"
          :loading="loading"
          :pagination="false"
          :row-key="(record: MyInvitationInviteeItem) => `${record.maskedEmail}:${record.registeredAt}`"
          :scroll="{ x: 610, y: 300 }"
          size="small"
        >
          <template #emptyText>暂无邀请记录</template>
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'fullName'">{{ record.fullName || "未填写" }}</template>
            <template v-else-if="column.key === 'registeredAt'">{{ formatTimestamp(record.registeredAt) }}</template>
          </template>
        </a-table>
      </div>

      <a-pagination
        v-if="total > 0"
        :current="page"
        :page-size="pageSize"
        :total="total"
        :page-size-options="['10', '20', '50', '100']"
        show-size-changer
        show-quick-jumper
        @change="changePage"
        @show-size-change="changePage"
      />
    </div>
  </a-modal>
</template>

<style scoped>
.my-invitations {
  display: grid;
  grid-template-rows: 36px 40px 360px 32px;
  gap: 12px;
  height: 504px;
}

.my-invitations__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 36px;
  color: var(--app-muted);
}

.my-invitations__table {
  height: 360px;
  min-height: 360px;
  overflow: hidden;
  border: 1px solid var(--app-border);
  border-radius: 8px;
}

.my-invitations__feedback {
  min-height: 40px;
  overflow: hidden;
}

.my-invitations :deep(.ant-pagination) {
  justify-content: flex-end;
  margin: 0;
}

@media (max-width: 640px) {
  .my-invitations :deep(.ant-pagination) {
    justify-content: flex-start;
    overflow-x: auto;
  }
}
</style>
