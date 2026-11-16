<script setup lang="ts">
import { useViewport } from "../../../composables/useViewport";
import MessageNotificationsPanel from "../../settings/components/message-notifications-panel.vue";

defineOptions({ name: "AdminMobileSettingsPanel" });
const { mode } = useViewport();
</script>

<template>
  <section class="admin-mobile-settings-panel">
    <div class="admin-mobile-settings-panel__content">
      <MessageNotificationsPanel :surface="mode === 'mobile' ? 'h5' : 'default'" />
    </div>
  </section>
</template>

<style scoped>
.admin-mobile-settings-panel {
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
}

.admin-mobile-settings-panel__content {
  min-height: 0;
  overflow: auto;
}
</style>
