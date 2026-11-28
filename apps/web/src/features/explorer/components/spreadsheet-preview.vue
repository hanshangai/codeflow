<script setup lang="ts">
import { computed, ref } from "vue";
import { CopyOutlined } from "@ant-design/icons-vue";
import { message } from "ant-design-vue";
import type { FsSpreadsheetCellValue, FsSpreadsheetPreviewResponseBody } from "@codeflowai/shared";

import { copyToClipboard } from "@/composables/useClipboard";

defineOptions({ name: "SpreadsheetPreview" });

const props = defineProps<{
  preview: FsSpreadsheetPreviewResponseBody;
}>();

const emit = defineEmits<{
  (e: "sheetChange", sheetName: string): void;
}>();

type SelectedCell = {
  address: string;
  value: string;
};

const selectedCell = ref<SelectedCell | null>(null);
const copyingCell = ref(false);

/** 确保单元格详情弹框浮在文件预览窗口之上。 */
const CELL_DETAIL_MODAL_Z_INDEX = 3000;

const columnIndexes = computed(() => {
  const rowMax = props.preview.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const count = Math.max(props.preview.columnCount, rowMax);
  return Array.from({ length: count }, (_, index) => index);
});

const summaryText = computed(() => {
  const parts = [`${props.preview.rowCount} 行`, `${props.preview.columnCount} 列`];
  if (props.preview.truncatedRows || props.preview.truncatedColumns) parts.push("已截断");
  return parts.join(" · ");
});

/** 把列下标转换为 Excel 风格列名。 */
function columnName(index: number): string {
  let n = index + 1;
  let label = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

/** 把单元格值转换为稳定显示文本。 */
function cellText(value: FsSpreadsheetCellValue | undefined): string {
  if (value == null) return "";
  return String(value);
}

/** 生成单元格坐标，如 A1 / AB12。 */
function cellAddress(rowIndex: number, columnIndex: number): string {
  return `${columnName(columnIndex)}${rowIndex + 1}`;
}

/** 打开单元格详情，展示当前预览范围内的完整单元格值。 */
function openCellDetail(rowIndex: number, columnIndex: number, value: FsSpreadsheetCellValue | undefined): void {
  selectedCell.value = {
    address: cellAddress(rowIndex, columnIndex),
    value: cellText(value),
  };
}

/** 关闭单元格详情弹框。 */
function closeCellDetail(): void {
  selectedCell.value = null;
}

/** 复制当前单元格完整内容。 */
async function copySelectedCell(): Promise<void> {
  if (!selectedCell.value || copyingCell.value) return;
  copyingCell.value = true;
  try {
    await copyToClipboard(selectedCell.value.value);
    message.success("已复制单元格内容");
  } catch (error) {
    message.error(error instanceof Error ? error.message : "复制失败");
  } finally {
    copyingCell.value = false;
  }
}

/** 处理工作表切换，由父级决定是否重新请求预览。 */
function onSheetChange(event: Event): void {
  const nextSheet = String((event.target as HTMLSelectElement | null)?.value ?? "").trim();
  if (!nextSheet || nextSheet === props.preview.sheetName) return;
  emit("sheetChange", nextSheet);
}
</script>

<template>
  <div class="spreadsheet-preview">
    <div class="spreadsheet-preview__toolbar">
      <label class="spreadsheet-preview__sheet">
        <span>工作表</span>
        <select :value="preview.sheetName" @change="onSheetChange">
          <option v-for="sheet in preview.sheets" :key="sheet.name" :value="sheet.name">
            {{ sheet.name }}
          </option>
        </select>
      </label>
      <span class="spreadsheet-preview__summary">{{ summaryText }}</span>
    </div>

    <div class="spreadsheet-preview__table-wrap">
      <table class="spreadsheet-preview__table">
        <thead>
          <tr>
            <th class="spreadsheet-preview__corner"></th>
            <th v-for="column in columnIndexes" :key="column">
              {{ columnName(column) }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, rowIndex) in preview.rows" :key="rowIndex">
            <th class="spreadsheet-preview__row-head">{{ rowIndex + 1 }}</th>
            <td
              v-for="column in columnIndexes"
              :key="column"
              class="spreadsheet-preview__cell"
              :title="cellText(row[column])"
              role="button"
              tabindex="0"
              @dblclick="openCellDetail(rowIndex, column, row[column])"
              @keydown.enter.prevent="openCellDetail(rowIndex, column, row[column])"
              @keydown.space.prevent="openCellDetail(rowIndex, column, row[column])"
            >
              {{ cellText(row[column]) }}
            </td>
          </tr>
          <tr v-if="preview.rows.length === 0">
            <td class="spreadsheet-preview__empty" :colspan="columnIndexes.length + 1">当前工作表没有可预览内容</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="preview.truncatedRows || preview.truncatedColumns" class="spreadsheet-preview__note">
      仅显示前 {{ preview.maxRows }} 行、{{ preview.maxColumns }} 列。
    </div>

    <a-modal
      :open="selectedCell != null"
      :footer="null"
      :z-index="CELL_DETAIL_MODAL_Z_INDEX"
      width="720px"
      :body-style="{ padding: '12px 16px 16px' }"
      @cancel="closeCellDetail"
    >
      <template #title>
        <div class="spreadsheet-preview__cell-title">
          <span>{{ preview.sheetName }} · {{ selectedCell?.address }}</span>
          <a-tooltip title="复制" placement="bottom" :overlay-style="{ zIndex: CELL_DETAIL_MODAL_Z_INDEX + 1 }">
            <a-button size="small" type="text" aria-label="复制" :disabled="copyingCell" @click="copySelectedCell">
              <CopyOutlined />
            </a-button>
          </a-tooltip>
        </div>
      </template>
      <textarea
        class="spreadsheet-preview__cell-text"
        readonly
        :value="selectedCell?.value ?? ''"
        aria-label="单元格完整内容"
      ></textarea>
    </a-modal>
  </div>
</template>

<style scoped>
.spreadsheet-preview {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--app-bg, #fff);
}

.spreadsheet-preview__toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
}

.spreadsheet-preview__sheet {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12px;
  color: var(--app-muted, #666);
}

.spreadsheet-preview__sheet select {
  max-width: 220px;
  min-height: 28px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 6px;
  padding: 2px 8px;
  background: var(--app-bg, #fff);
  color: var(--app-text, #1f2937);
}

.spreadsheet-preview__summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--app-muted, #666);
}

.spreadsheet-preview__table-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.spreadsheet-preview__table {
  width: max-content;
  min-width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
  font-size: 12px;
  line-height: 1.5;
}

.spreadsheet-preview__table th,
.spreadsheet-preview__table td {
  min-width: 120px;
  max-width: 260px;
  height: 30px;
  padding: 5px 8px;
  border-right: 1px solid var(--app-divider, #f0f0f0);
  border-bottom: 1px solid var(--app-divider, #f0f0f0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: var(--app-bg, #fff);
}

.spreadsheet-preview__cell {
  cursor: pointer;
}

.spreadsheet-preview__cell:focus-visible {
  outline: 2px solid #1677ff;
  outline-offset: -2px;
}

.spreadsheet-preview__table thead th,
.spreadsheet-preview__row-head,
.spreadsheet-preview__corner {
  position: sticky;
  background: var(--app-hover-bg, #fafafa);
  color: var(--app-muted, #667085);
  font-weight: 600;
  z-index: 1;
}

.spreadsheet-preview__table thead th {
  top: 0;
}

.spreadsheet-preview__corner,
.spreadsheet-preview__row-head {
  left: 0;
  min-width: 52px;
  max-width: 52px;
  text-align: center;
}

.spreadsheet-preview__corner {
  z-index: 2;
}

.spreadsheet-preview__empty {
  height: 160px;
  text-align: center;
  color: var(--app-muted, #666);
}

.spreadsheet-preview__note {
  flex: 0 0 auto;
  padding: 6px 12px;
  border-top: 1px solid var(--app-divider, #f0f0f0);
  font-size: 12px;
  color: var(--app-muted, #666);
}

.spreadsheet-preview__cell-title {
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% - 44px);
  min-width: 0;
}

.spreadsheet-preview__cell-title span {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.spreadsheet-preview__cell-text {
  width: 100%;
  min-height: 320px;
  max-height: 68vh;
  padding: 10px 12px;
  border: 1px solid var(--app-border, #d9d9d9);
  border-radius: 6px;
  resize: vertical;
  overflow: auto;
  color: var(--app-text, #1f2937);
  background: var(--app-bg, #fff);
  font-family: Consolas, "SFMono-Regular", Menlo, Monaco, monospace;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
}
</style>
