<script setup lang="ts">
import {
  BookOpenCheck,
  Building2,
  CloudCog,
  Handshake,
  Headphones,
  Laptop,
  MessagesSquare,
  Radio,
  ShieldCheck,
  Workflow,
} from "lucide-vue-next";
import { computed, ref, watch } from "vue";

import { useApiContext } from "../../../composables/useApiContext";
import {
  createDefaultSiteContactInfo,
  fetchPublicSiteContactInfo,
  getCachedPublicSiteContactInfo,
} from "../../../composables/siteContactInfo";
import LandingNav from "./LandingNav.vue";
import LandingRecords from "./LandingRecords.vue";

defineOptions({ name: "ContactPage" });

const emit = defineEmits<{
  (e: "open-settings"): void;
  (e: "enter-app"): void;
}>();

const { ctx } = useApiContext();
const contactInfo = ref(getCachedPublicSiteContactInfo() ?? createDefaultSiteContactInfo());
const hasWechatGroupQrImage = computed(() => Boolean(contactInfo.value.wechatGroupQrImage));
const hasOfficialAccountQrImage = computed(() => Boolean(contactInfo.value.officialAccountQrImage));

watch(
  () => ctx.value.serverWsOrigin,
  () => {
    void (async () => {
      contactInfo.value = await fetchPublicSiteContactInfo(ctx.value);
    })();
  },
  { immediate: true },
);
</script>

<template>
  <div class="contact-page">
    <LandingNav @open-settings="emit('open-settings')" @enter-app="emit('enter-app')" />

    <main class="contact-page__main">
      <section class="contact-page__hero" aria-labelledby="contact-company-title">
        <div class="contact-page__hero-copy">
          <p class="contact-page__eyebrow">
            <Building2 :size="16" aria-hidden="true" />
            关于汉熵科技
          </p>
          <h1 id="contact-company-title">汉熵科技</h1>
          <p class="contact-page__hero-lead">专注企业 AI 软件研发产品与工程化实践</p>
          <p>
            汉熵科技成立于 2026 年 3 月，总部位于武汉。团队成员具备软件产品、工程架构与 AI 应用实践经验，持续探索大模型如何进入真实的软件研发与交付流程。
          </p>
          <p>
            我们围绕企业知识、研发流程和 AI 执行建设可落地的软件研发基础设施，让团队能够在统一边界内使用 AI、复用知识、协同交付并持续改进研发方法。
          </p>
          <p>我们的目标是让 AI 研发能力沉淀为企业可复制的软件交付能力，持续服务高质量、可规模化的软件研发。</p>
        </div>

        <div class="contact-page__product-position" aria-labelledby="contact-product-title">
          <div class="contact-page__product-brand">
            <img src="/favicon.svg" alt="" class="contact-page__product-logo" />
            <span>核心产品</span>
          </div>
          <strong class="contact-page__product-name">CodeFlow</strong>
          <h2 id="contact-product-title">面向软件交付企业的 AI 研发中台</h2>
          <p>
            连接企业知识、研发流程与 AI 执行，将 AI Coding 从个人单点提效升级为可协作、可治理、可度量的端到端交付能力。
          </p>
          <ul class="contact-page__product-points">
            <li><strong>连接</strong><span>统一承接需求、知识、工作流、Agent、工具与交付产物</span></li>
            <li><strong>执行</strong><span>让多 Agent 按流程、职责、输入输出和质量门禁协作</span></li>
            <li><strong>沉淀</strong><span>让运行证据、会话结论和工作流经验持续转化为企业资产</span></li>
          </ul>
        </div>
      </section>

      <section class="contact-page__capabilities" aria-labelledby="contact-capabilities-title">
        <header class="contact-page__section-head">
          <span class="contact-page__section-kicker">产品能力</span>
          <h2 id="contact-capabilities-title">把 AI Coding 组织成企业交付能力</h2>
          <p>CodeFlow 以自研工作流编排为核心，把企业知识、多 Agent 协作、质量治理和本地执行连接成完整的软件交付体系。</p>
        </header>

        <div class="contact-page__capability-grid">
          <article class="contact-page__capability-item">
            <span class="contact-page__capability-icon"><BookOpenCheck :size="22" aria-hidden="true" /></span>
            <h3>企业知识持续可用</h3>
            <p>从源码、需求文档、研发规范和历史交付物建立知识基线，并将会话与工作流经验形成候选，经审核后受控写回。</p>
          </article>

          <article class="contact-page__capability-item">
            <span class="contact-page__capability-icon"><Workflow :size="22" aria-hidden="true" /></span>
            <h3>端到端流程可执行</h3>
            <p>自研编排运行时覆盖需求、设计、开发、验证、评审和 Git 交付，通过结构化产物与精确返工控制任务推进。</p>
          </article>

          <article class="contact-page__capability-item">
            <span class="contact-page__capability-icon"><ShieldCheck :size="22" aria-hidden="true" /></span>
            <h3>协作与治理有边界</h3>
            <p>共享工作区统一知识、权限和文件传输边界，质量门禁、运行证据与编排度量共同支撑审计和研发复盘。</p>
          </article>

          <article class="contact-page__capability-item">
            <span class="contact-page__capability-icon"><Laptop :size="22" aria-hidden="true" /></span>
            <h3>代码与工具贴近本地</h3>
            <p>Host Client 在受控工作区内连接代码仓库、文件、终端和 Git，让关键研发操作在客户实际工程环境中完成。</p>
          </article>
        </div>
      </section>

      <section class="contact-page__delivery" aria-labelledby="contact-delivery-title">
        <header class="contact-page__section-head contact-page__section-head--compact">
          <span class="contact-page__section-kicker">合作方式</span>
          <h2 id="contact-delivery-title">从快速启用到企业深度共建</h2>
          <p>根据团队协作与系统集成需求，选择适合团队的落地方式。</p>
        </header>

        <div class="contact-page__delivery-list">
          <article class="contact-page__delivery-item">
            <CloudCog :size="21" aria-hidden="true" />
            <div>
              <h3>SaaS 服务</h3>
              <p>平台在线使用，代码和项目文件保留在本地工作区，适合快速试用与团队协作。</p>
            </div>
          </article>
          <article class="contact-page__delivery-item">
            <Handshake :size="21" aria-hidden="true" />
            <div>
              <h3>联合定制开发</h3>
              <p>基于 CodeFlow 编排、知识与治理底座，联合建设专属工作流、连接器和行业能力。</p>
            </div>
          </article>
        </div>
      </section>

      <section class="contact-page__contact" aria-labelledby="contact-channel-title">
        <header class="contact-page__section-head contact-page__section-head--center">
          <span class="contact-page__section-kicker">联系我们</span>
          <h2 id="contact-channel-title">产品试用、企业引入与合作咨询</h2>
        </header>

        <div class="contact-page__panel">
          <article class="contact-page__item contact-page__item--qr">
            <span class="contact-page__label"><MessagesSquare :size="16" aria-hidden="true" />微信群</span>
            <div
              class="contact-page__qr-panel"
              :class="{ 'contact-page__qr-panel--empty': !hasWechatGroupQrImage }"
            >
              <img
                v-if="hasWechatGroupQrImage"
                :src="contactInfo.wechatGroupQrImage"
                alt="微信群二维码"
                class="contact-page__qr-image"
              />
              <span v-else class="contact-page__value contact-page__value--plain">待补充</span>
              <p v-if="hasWechatGroupQrImage" class="contact-page__qr-caption">扫码加入微信群</p>
            </div>
          </article>

          <article class="contact-page__item contact-page__item--qr">
            <span class="contact-page__label"><Radio :size="16" aria-hidden="true" />公众号</span>
            <div
              class="contact-page__qr-panel"
              :class="{ 'contact-page__qr-panel--empty': !hasOfficialAccountQrImage }"
            >
              <img
                v-if="hasOfficialAccountQrImage"
                :src="contactInfo.officialAccountQrImage"
                alt="公众号二维码"
                class="contact-page__qr-image"
              />
              <span v-else class="contact-page__value contact-page__value--plain">待补充</span>
              <p v-if="hasOfficialAccountQrImage" class="contact-page__qr-caption">扫码关注公众号</p>
            </div>
          </article>

          <article class="contact-page__item contact-page__item--qr">
            <span class="contact-page__label"><Headphones :size="16" aria-hidden="true" />客服</span>
            <div class="contact-page__qr-panel">
              <img
                src="/images/landing/customer-service-qr.png"
                alt="客服二维码"
                class="contact-page__qr-image"
              />
              <p class="contact-page__qr-caption">扫码添加客服</p>
            </div>
          </article>
        </div>
      </section>
    </main>

    <LandingRecords />
  </div>
</template>

<style scoped>
.contact-page {
  --landing-nav-bg: rgba(247, 248, 246, 0.94);
  --landing-panel: rgba(255, 255, 255, 0.94);
  --landing-border: rgba(55, 69, 63, 0.14);
  --landing-text: #1b211f;
  --landing-muted: rgba(27, 33, 31, 0.66);
  --landing-muted-soft: rgba(27, 33, 31, 0.54);
  --landing-accent-wash: rgba(201, 100, 66, 0.11);
  --landing-warning: #a85237;
  min-height: 100vh;
  overflow-y: auto;
  scrollbar-gutter: stable;
  background: #f6f7f5;
  color: #1b211f;
}

.contact-page__main {
  display: grid;
  width: min(1180px, calc(100% - 48px));
  margin: 0 auto;
  padding: 0 0 84px;
}

.contact-page__hero {
  display: grid;
  grid-template-columns: minmax(0, 1.04fr) minmax(0, 0.96fr);
  gap: 64px;
  align-items: start;
  padding: 16px 0 48px;
  border-bottom: 1px solid rgba(55, 69, 63, 0.14);
}

.contact-page__hero-copy {
  display: grid;
  gap: 16px;
  max-width: 660px;
}

.contact-page__eyebrow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  margin: 0;
  color: #216653;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0;
}

.contact-page__hero-copy h1 {
  margin: 0;
  color: #17201d;
  font-size: 48px;
  line-height: 1.08;
  letter-spacing: 0;
}

.contact-page__hero-copy .contact-page__hero-lead {
  color: #263c34;
  font-size: 21px;
  font-weight: 700;
  line-height: 1.5;
}

.contact-page__hero-copy p {
  margin: 0;
  width: 100%;
  color: rgba(27, 33, 31, 0.7);
  font-size: 16px;
  line-height: 1.82;
}

.contact-page__product-position {
  display: grid;
  gap: 14px;
  min-width: 0;
  padding-left: 48px;
  border-left: 1px solid rgba(55, 69, 63, 0.18);
}

.contact-page__product-brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: rgba(27, 33, 31, 0.56);
  font-size: 12px;
  font-weight: 700;
}

.contact-page__product-logo {
  display: block;
  width: 32px;
  height: 32px;
}

.contact-page__product-name {
  color: #c96442;
  font-size: 18px;
  line-height: 1.3;
}

.contact-page__product-position h2 {
  margin: 0;
  color: #17201d;
  font-size: 30px;
  line-height: 1.32;
  letter-spacing: 0;
}

.contact-page__product-position > p {
  margin: 0;
  color: rgba(27, 33, 31, 0.7);
  font-size: 15px;
  line-height: 1.76;
}

.contact-page__product-points {
  display: grid;
  margin: 4px 0 0;
  padding: 0;
  list-style: none;
}

.contact-page__product-points li {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid rgba(55, 69, 63, 0.12);
}

.contact-page__product-points strong {
  color: #216653;
  font-size: 13px;
}

.contact-page__product-points span {
  color: rgba(27, 33, 31, 0.68);
  font-size: 13px;
  line-height: 1.65;
}

.contact-page__capabilities,
.contact-page__delivery,
.contact-page__contact {
  padding: 52px 0;
}

.contact-page__capabilities,
.contact-page__delivery {
  border-bottom: 1px solid rgba(55, 69, 63, 0.14);
}

.contact-page__section-head {
  display: grid;
  gap: 8px;
  max-width: 760px;
  margin-bottom: 24px;
}

.contact-page__section-head--compact {
  max-width: 680px;
}

.contact-page__section-head--center {
  justify-items: center;
  max-width: 760px;
  margin-right: auto;
  margin-left: auto;
  text-align: center;
}

.contact-page__section-kicker {
  color: #a85237;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0;
}

.contact-page__section-head h2 {
  margin: 0;
  color: #17201d;
  font-size: 29px;
  line-height: 1.32;
  letter-spacing: 0;
}

.contact-page__section-head p {
  margin: 0;
  color: rgba(27, 33, 31, 0.66);
  font-size: 15px;
  line-height: 1.72;
}

.contact-page__capability-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.contact-page__capability-item {
  display: grid;
  align-content: start;
  gap: 12px;
  min-height: 220px;
  padding: 22px;
  border: 1px solid rgba(55, 69, 63, 0.14);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 10px 28px rgba(36, 52, 46, 0.06);
}

.contact-page__capability-icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 1px solid rgba(33, 102, 83, 0.14);
  border-radius: 8px;
  background: #edf4f1;
  color: #216653;
}

.contact-page__capability-item h3,
.contact-page__delivery-item h3 {
  margin: 0;
  color: #17201d;
  font-size: 16px;
  line-height: 1.4;
  letter-spacing: 0;
}

.contact-page__capability-item p,
.contact-page__delivery-item p {
  margin: 0;
  color: rgba(27, 33, 31, 0.65);
  font-size: 13px;
  line-height: 1.72;
}

.contact-page__delivery-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 28px;
}

.contact-page__delivery-item {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  padding-top: 18px;
  border-top: 2px solid rgba(201, 100, 66, 0.48);
  color: #a85237;
}

.contact-page__delivery-item > div {
  display: grid;
  gap: 7px;
}

.contact-page__panel {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-top: 24px;
}

.contact-page__item {
  display: grid;
  gap: 10px;
  min-height: 100%;
  padding: 22px;
  border: 1px solid rgba(55, 69, 63, 0.14);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 10px 28px rgba(36, 52, 46, 0.06);
}

.contact-page__item--qr {
  justify-items: center;
  align-content: start;
  text-align: center;
}

.contact-page__label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: #263c34;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0;
}

.contact-page__value {
  color: #17201d;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.32;
  word-break: break-word;
}

.contact-page__value--plain {
  font-size: 16px;
  font-weight: 400;
  line-height: 1.7;
}

.contact-page__qr-panel {
  display: grid;
  justify-items: center;
  align-content: start;
  width: 100%;
  min-height: 244px;
  gap: 10px;
}

.contact-page__qr-panel--empty {
  align-content: center;
}

.contact-page__qr-image {
  display: block;
  width: min(100%, 192px);
  max-height: 192px;
  object-fit: contain;
  border-radius: 6px;
  background: #fff;
  box-shadow: 0 8px 22px rgba(36, 52, 46, 0.1);
}

.contact-page__qr-caption {
  margin: 0;
  color: rgba(27, 33, 31, 0.62);
  font-size: 13px;
  line-height: 1.6;
}

@media (max-width: 1023px) {
  .contact-page__hero {
    gap: 36px;
  }

  .contact-page__product-position {
    padding-left: 32px;
  }

  .contact-page__capability-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .contact-page__capability-item {
    min-height: 190px;
  }
}

@media (max-width: 767px) {
  .contact-page {
    min-height: 100%;
    overflow: visible;
    scrollbar-gutter: auto;
  }

  .contact-page__main {
    width: min(100%, calc(100% - 28px));
    padding: 10px 0 52px;
  }

  .contact-page__hero {
    grid-template-columns: 1fr;
    gap: 30px;
    padding: 32px 0 38px;
  }

  .contact-page__hero-copy h1 {
    font-size: 36px;
  }

  .contact-page__hero-copy p {
    font-size: 15px;
    line-height: 1.72;
  }

  .contact-page__hero-copy .contact-page__hero-lead {
    font-size: 18px;
  }

  .contact-page__product-position {
    padding: 28px 0 0;
    border-top: 1px solid rgba(55, 69, 63, 0.18);
    border-left: none;
  }

  .contact-page__product-position h2,
  .contact-page__section-head h2 {
    font-size: 24px;
  }

  .contact-page__capabilities,
  .contact-page__delivery,
  .contact-page__contact {
    padding: 38px 0;
  }

  .contact-page__capability-grid,
  .contact-page__delivery-list,
  .contact-page__panel {
    grid-template-columns: 1fr;
  }

  .contact-page__capability-grid,
  .contact-page__panel {
    gap: 12px;
  }

  .contact-page__delivery-list {
    gap: 22px;
  }

  .contact-page__capability-item {
    min-height: 0;
    padding: 20px;
  }

  .contact-page__panel {
    margin-top: 16px;
  }

  .contact-page__item {
    padding: 20px;
  }

  .contact-page__value {
    font-size: 18px;
  }

  .contact-page__value--plain {
    font-size: 15px;
  }

  .contact-page__qr-panel {
    min-height: 224px;
  }

  .contact-page__qr-image {
    width: min(100%, 178px);
    max-height: 178px;
  }
}
</style>
