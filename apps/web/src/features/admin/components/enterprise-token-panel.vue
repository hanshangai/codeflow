<script setup lang="ts">
import { computed } from "vue";
import EnterpriseTokenQuotaTab from "../../account/components/enterprise-token-quota-tab.vue";
import { useConfigStore } from "../../../store/config";

defineOptions({ name: "EnterpriseTokenPanel" });

const config = useConfigStore();

const isEnterpriseAdmin = computed(() => config.accountRole === "enterprise_admin" && Boolean(config.userSummary?.enterpriseId));
const managedEnterpriseId = computed(() => isEnterpriseAdmin.value ? config.userSummary?.enterpriseId ?? null : null);
</script>

<template>
  <div class="enterprise-token-panel">
    <a-alert
      v-if="!isEnterpriseAdmin"
      type="warning"
      show-icon
      message="当前账号无企业 Token 管理权限"
    />

    <div v-else class="enterprise-token-panel__content">
      <EnterpriseTokenQuotaTab
        :enterprise-id="managedEnterpriseId"
        :allow-purchase="true"
      />
    </div>
  </div>
</template>

<style scoped>
.enterprise-token-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.enterprise-token-panel__selector {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 12px 16px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-bg);
}

.enterprise-token-panel__selector-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.enterprise-token-panel__selector-copy strong {
  color: var(--app-text);
  font-size: 14px;
  line-height: 1.5;
}

.enterprise-token-panel__selector-copy span {
  color: var(--app-muted);
  font-size: 12px;
  line-height: 1.5;
}

.enterprise-token-panel__selector-input {
  flex: 0 1 420px;
  width: min(420px, 50%);
}

.enterprise-token-panel__empty {
  display: grid;
  flex: 1;
  place-items: center;
  min-height: 280px;
}

.enterprise-token-panel__content {
  flex: 1;
  min-width: 0;
}

@media (max-width: 900px) {
  .enterprise-token-panel__selector {
    align-items: stretch;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
  }

  .enterprise-token-panel__selector-input {
    flex-basis: auto;
    width: 100%;
  }
}
</style>
