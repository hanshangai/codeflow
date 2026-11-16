<script setup lang="ts">
import type { ConversationUserInputRequest, WorkspaceId } from "@codeflowai/shared";
import type { PendingInteractionItem } from "../chatTypes";

import ApprovalRequestItem from "../../messages/components/items/approval-request-item.vue";
import UserInputRequestItem from "../../messages/components/items/user-input-request-item.vue";

defineOptions({ name: "PendingInteractionStack" });

type UserInputAnswers = Record<string, { answers: string[] }>;
type UserInputResumeWithInput = (payload: { item: ConversationUserInputRequest; answers: UserInputAnswers; text: string }) => Promise<void>;

const props = withDefaults(defineProps<{
  items: PendingInteractionItem[];
  workspaceId?: WorkspaceId;
  userInputResumeWithInput?: UserInputResumeWithInput;
  active?: boolean;
}>(), { active: undefined });
</script>

<template>
  <div class="pending-interaction-stack">
    <template v-for="item in items" :key="item.id">
      <ApprovalRequestItem
        v-if="item.kind === 'approvalRequest'"
        :item="item"
        :workspace-id="props.workspaceId"
        compact
      />
      <UserInputRequestItem
        v-else-if="item.kind === 'userInputRequest'"
        :item="item"
        compact
        :inline="item.delivery === 'async'"
        :workspace-id="props.workspaceId"
        :resume-with-input="props.userInputResumeWithInput"
        :active="props.active"
      />
    </template>
  </div>
</template>

<style scoped>
.pending-interaction-stack {
  display: grid;
  gap: 8px;
}
</style>
