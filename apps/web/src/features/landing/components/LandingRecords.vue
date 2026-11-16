<script setup lang="ts">
defineOptions({ name: "LandingRecords" });
</script>

<template>
  <footer class="landing-records">
    <div class="landing-records__inner">
      <div class="landing-records__copyright">@2026 汉熵科技</div>
      <div class="landing-records__links">
        <a
          class="landing-records__link"
          href="https://beian.miit.gov.cn/"
          target="_blank"
          rel="noopener noreferrer"
        >
          鄂ICP备2026015393号-1
        </a>
        <a
          class="landing-records__link landing-records__link--with-icon"
          href="https://beian.mps.gov.cn/#/query/webSearch?code=42018502008742"
          target="_blank"
          rel="noopener noreferrer"
        >
          <img src="/images/beian-gongan.png" alt="" aria-hidden="true" />
          鄂公网安备42018502008742号
        </a>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.landing-records {
  padding: 6px 0 18px;
}

.landing-records__inner {
  width: min(1180px, calc(100% - 32px));
  margin: 0 auto;
  padding: 8px 0 0;
  border-top: 1px solid var(--landing-border, rgba(123, 104, 78, 0.12));
  display: flex;
  justify-content: center;
  gap: 2px 14px;
  flex-wrap: wrap;
  text-align: center;
}

.landing-records__copyright {
  font-size: 12px;
  line-height: 1.5;
  color: var(--landing-muted-soft, rgba(31, 26, 22, 0.5));
}

.landing-records__links {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px 12px;
  flex-wrap: wrap;
}

.landing-records__link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--landing-muted-soft, rgba(31, 26, 22, 0.5));
  font-size: 12px;
  line-height: 1.5;
  text-decoration: none;
}

.landing-records__link:hover {
  color: var(--landing-muted-strong, rgba(31, 26, 22, 0.75));
  text-decoration: underline;
}

.landing-records__link--with-icon img {
  width: 14px;
  height: 14px;
  object-fit: contain;
  flex-shrink: 0;
  opacity: 0.72;
}

@media (max-width: 767px) {
  .landing-records {
    padding: 2px 0 12px;
  }

  .landing-records__inner {
    padding-top: 8px;
    justify-content: center;
    text-align: center;
  }

  .landing-records__links {
    justify-content: center;
    gap: 3px 10px;
  }
}
</style>
