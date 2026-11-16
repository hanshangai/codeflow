<script setup lang="ts">
import { useRouter } from "vue-router";

import {
  DATA_SECURITY_COMMITMENT_DATE,
  DATA_SECURITY_COMMITMENT_OBLIGATIONS,
  DATA_SECURITY_COMMITMENT_OPENING,
  DATA_SECURITY_COMMITMENT_PRINCIPLES,
  DATA_SECURITY_COMMITMENT_SCOPE,
  DATA_SECURITY_COMMITMENT_SUMMARY,
  DATA_SECURITY_COMMITMENT_TITLE,
} from "../data-security-commitment";
import LandingNav from "./LandingNav.vue";

defineOptions({ name: "DataSecurityCommitmentPage" });

const emit = defineEmits<{
  (e: "open-settings"): void;
  (e: "enter-app"): void;
}>();

const router = useRouter();

</script>

<template>
  <div class="security-page">
    <LandingNav @open-settings="emit('open-settings')" @enter-app="emit('enter-app')" />

    <main class="security-page__main">
      <section class="security-page__hero">
        <div class="security-page__breadcrumb">
          <button type="button" class="security-page__breadcrumb-link" @click="router.push('/')">首页</button>
          <span>/</span>
          <span>{{ DATA_SECURITY_COMMITMENT_TITLE }}</span>
        </div>
        <h1>{{ DATA_SECURITY_COMMITMENT_TITLE }}</h1>
        <p>{{ DATA_SECURITY_COMMITMENT_SUMMARY }}</p>
      </section>

      <section class="security-page__paper">
        <h2 class="security-page__title">{{ DATA_SECURITY_COMMITMENT_TITLE }}</h2>
        <p class="security-page__salutation">尊敬的用户：</p>
        <p>
          {{ DATA_SECURITY_COMMITMENT_OPENING }}
        </p>

        <h2>一、核心承诺</h2>
        <ol class="security-page__list">
          <li v-for="item in DATA_SECURITY_COMMITMENT_PRINCIPLES" :key="item">{{ item }}</li>
        </ol>

        <h2>二、安全义务</h2>
        <ol class="security-page__list">
          <li v-for="item in DATA_SECURITY_COMMITMENT_OBLIGATIONS" :key="item">{{ item }}</li>
        </ol>

        <h2>三、适用说明</h2>
        <p>
          {{ DATA_SECURITY_COMMITMENT_SCOPE }}
        </p>

        <p class="security-page__date">{{ DATA_SECURITY_COMMITMENT_DATE }}</p>
      </section>
    </main>
  </div>
</template>

<style scoped>
.security-page {
  min-height: 100vh;
  overflow-y: auto;
  background: linear-gradient(180deg, #faf9f6 0%, #f4eee6 40%, #f9f7f3 100%);
  color: #1f1a16;
}

.security-page__main {
  width: min(980px, calc(100% - 48px));
  margin: 0 auto;
  padding: 26px 0 58px;
}

.security-page__hero {
  padding: 30px 32px;
  border-radius: 28px;
  border: 1px solid rgba(123, 104, 78, 0.14);
  background:
    radial-gradient(circle at top right, rgba(209, 121, 52, 0.15), transparent 32%),
    rgba(255, 255, 255, 0.82);
  box-shadow: 0 24px 68px rgba(46, 33, 16, 0.08);
}

.security-page__breadcrumb {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  font-size: 13px;
  color: rgba(31, 26, 22, 0.56);
}

.security-page__breadcrumb-link {
  border: none;
  background: transparent;
  color: rgba(31, 26, 22, 0.62);
  font-size: 13px;
  cursor: pointer;
  padding: 0;
}

.security-page__breadcrumb-link:hover {
  color: #8c5620;
}

.security-page__hero h1 {
  margin: 14px 0 12px;
  font-size: clamp(30px, 4.2vw, 44px);
  letter-spacing: -0.03em;
}

.security-page__hero p {
  margin: 0;
  max-width: 760px;
  color: rgba(31, 26, 22, 0.68);
  font-size: 15px;
  line-height: 1.8;
}

.security-page__paper {
  margin-top: 18px;
  padding: 34px;
  border-radius: 28px;
  border: 1px solid rgba(123, 104, 78, 0.14);
  background: rgba(255, 255, 255, 0.88);
  box-shadow: 0 14px 42px rgba(46, 33, 16, 0.06);
}

.security-page__paper p {
  margin: 0;
  color: rgba(31, 26, 22, 0.86);
  font-size: 16px;
  line-height: 1.95;
  text-align: justify;
}

.security-page__salutation {
  margin-bottom: 8px !important;
  font-weight: 700;
}

.security-page__title {
  margin-top: 0 !important;
  text-align: center;
}

.security-page__paper h2 {
  margin: 26px 0 10px;
  font-size: 21px;
  line-height: 1.5;
}

.security-page__list {
  margin: 0;
  padding-left: 22px;
  display: grid;
  gap: 10px;
}

.security-page__list li {
  color: rgba(31, 26, 22, 0.86);
  font-size: 16px;
  line-height: 1.9;
  text-align: justify;
}

.security-page__date {
  margin-top: 26px !important;
  text-align: right !important;
  font-weight: 600;
}

@media (max-width: 767px) {
  .security-page__main {
    width: min(100%, calc(100% - 30px));
    padding: 18px 0 34px;
  }

  .security-page__hero,
  .security-page__paper {
    padding: 22px 16px;
    border-radius: 20px;
  }

  .security-page__hero h1 {
    font-size: clamp(26px, 8vw, 34px);
  }

  .security-page__paper p,
  .security-page__list li {
    font-size: 15px;
    line-height: 1.85;
  }

  .security-page__list {
    padding-left: 18px;
  }
}
</style>
