<script setup lang="ts">
import { useRoute, useRouter } from "vue-router";
import { trackProductEvent } from "../../../analytics/analytics";
import { getDesktopMigrationRedirect } from "../desktopMigrationGuidance";

defineOptions({ name: "DesktopMigrationPage" });
const router = useRouter();
const route = useRoute();
/** 只回到原来的同源研发路由，不丢失查询与锚点。 */
async function continueWeb(): Promise<void> {
  trackProductEvent("desktop_migration_continue_web", { source: "migration_page" });
  await router.replace(getDesktopMigrationRedirect(route.query.redirect));
}
/** 下载是用户主动动作，不记作已安装或迁移完成。 */
function openDownload(): void {
  trackProductEvent("desktop_migration_download_clicked", { source: "migration_page" });
  void router.push("/download");
}
/** 迁移说明走应用内路由。 */
function openMigrationGuide(): void {
  void router.push({ path: "/download", hash: "#migration" });
}
</script>

<template>
  <main class="desktop-migration-guide">
    <section>
      <span>CodeFlow Desktop</span><h1>请迁移至 CodeFlow 桌面版</h1>
      <p>Web 工作台处于过渡阶段，建议使用桌面版完成日常研发工作。</p>
      <p>使用原账号登录，继续使用现有账号、企业和 Token 余额。</p>
      <img src="/images/landing/efficiency-workbench.png" alt="CodeFlow AI 研发工作台演示界面" />
      <div class="desktop-migration-guide__actions"><a-button type="primary" size="large" @click="openDownload">下载桌面版</a-button><a href="/download#migration" @click.prevent="openMigrationGuide">查看旧 Client 迁移说明</a></div>
      <p>下载并安装 → 使用原账号登录 → 在旧电脑上确认数据迁移</p>
      <a-button type="text" @click="continueWeb">暂时继续使用 Web</a-button>
    </section>
  </main>
</template>

<style scoped>
.desktop-migration-guide { flex: 1; min-height: 0; overflow: auto; background: var(--app-bg); color: var(--app-text); padding: 40px 24px; }
.desktop-migration-guide section { width: min(100%, 900px); margin: auto; text-align: center; }
.desktop-migration-guide section > span { color: var(--app-accent); font-weight: 700; }
.desktop-migration-guide h1 { font-size: clamp(28px, 4vw, 42px); }
.desktop-migration-guide p { color: var(--app-muted); line-height: 1.8; }
.desktop-migration-guide img { display: block; width: min(100%, 760px); margin: 28px auto; border: 1px solid var(--app-border); border-radius: 16px; }
.desktop-migration-guide__actions { display: flex; justify-content: center; align-items: center; flex-wrap: wrap; gap: 24px; margin: 28px 0; }
</style>
