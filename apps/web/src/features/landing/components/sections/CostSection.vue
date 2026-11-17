<script setup lang="ts">
import { Coins, KeyRound } from "lucide-vue-next";
</script>

<template>
  <section class="cost panel">
    <div><span class="eyebrow">把预算花在有价值的研发上</span><h2>Token 流量折扣<br />让研发预算更从容</h2><p>内置模型 Token 流量享折扣。<br />模型选择更灵活，使用成本更清楚。</p></div>
    <div class="cost__options">
      <article><Coins :size="24" aria-hidden="true" /><h3>平台内置模型服务</h3><p>对应内置模型与渠道享优惠 Token 价格，具体价格在账号内模型价格与 Token 充值页面查看。</p><span>按实际用量计费</span></article>
      <article><KeyRound :size="24" aria-hidden="true" /><h3>继续使用自己的 Key</h3><p>沿用已有的模型渠道，按供应商规则计费。平台流量折扣仅适用于对应内置服务。</p><span>自由选择接入方式</span></article>
    </div>
  </section>
</template>

<style scoped>
.cost { display: grid; grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); gap: 50px; align-items: center; }
.cost h2 { margin: 16px 0; font-size: clamp(26px, 2.8vw, 36px); line-height: 1.45; letter-spacing: -.04em; }
.cost p { font-size: 14px; line-height: 1.9; color: var(--landing-muted); }
.cost__options { display: grid; gap: 16px; }
.cost article { position: relative; padding: 24px 25px 24px 65px; border: 1px solid var(--landing-border); border-radius: 14px; background: var(--landing-panel-solid); }
.cost article svg { position: absolute; left: 23px; top: 26px; color: var(--app-accent); }
.cost article h3 { margin: 0 0 9px; font-size: 17px; }
.cost article p { margin: 0 0 12px; font-size: 13px; }
.cost article span { color: var(--app-accent); font-size: 12px; }
</style>
