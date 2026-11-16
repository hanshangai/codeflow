<script setup lang="ts">
defineOptions({ name: "AuthShell" });

const props = withDefaults(defineProps<{
  title: string;
  subtitle?: string;
  variant?: "default" | "mobile-login";
}>(), {
  subtitle: "",
  variant: "default",
});
</script>

<template>
  <div class="auth-shell" :class="`auth-shell--${props.variant}`">
    <div class="auth-shell__frame">
      <div class="auth-shell__backdrop" />
      <div class="auth-shell__inner">
        <section class="auth-shell__card">
          <div class="auth-shell__hero">
            <div class="auth-shell__logo-wrap">
              <img src="/favicon.svg" alt="CodeFlow" class="auth-shell__logo" />
            </div>
            <div class="auth-shell__header">
              <h2>{{ props.title }}</h2>
              <p v-if="props.subtitle">{{ props.subtitle }}</p>
            </div>
          </div>
          <slot />
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auth-shell {
  --auth-shell-max-width: 2440px;
  --auth-viewport-height: 100vh;
  --auth-shell-pad-top: clamp(24px, 4vh, 48px);
  --auth-shell-pad-bottom: clamp(24px, 4vh, 48px);
  --auth-shell-pad-start: clamp(20px, 3vw, 40px);
  --auth-shell-pad-end: clamp(16px, 2.4vw, 48px);
  --auth-shell-inner-pad-block: clamp(18px, 2vh, 28px);
  --auth-shell-inner-pad-start: clamp(18px, 2vw, 28px);
  --auth-shell-inner-pad-end: clamp(96px, 7.8vw, 152px);
  --auth-card-width: min(370px, 100%);
  --auth-card-padding-block: 24px;
  --auth-card-padding-inline-start: 11px;
  --auth-card-padding-inline-end: 5px;
  --auth-backdrop-image: url("/images/auth/codeflow-login-light.svg");
  --auth-backdrop-position: 11% center;
  --auth-backdrop-filter: none;
  --auth-backdrop-scale: 1;
  --auth-backdrop-overlay: none;
  --auth-backdrop-overlay-opacity: 0;
  position: relative;
  min-height: 100vh;
  min-height: var(--auth-viewport-height);
  padding:
    var(--auth-shell-pad-top)
    var(--auth-shell-pad-end)
    var(--auth-shell-pad-bottom)
    var(--auth-shell-pad-start);
  display: flex;
  justify-content: center;
  background: color-mix(in srgb, var(--app-bg) 92%, #eef3f8);
}

:root[data-theme="dark"] .auth-shell {
  --auth-backdrop-image: url("/images/auth/codeflow-login-dark.svg");
  --auth-backdrop-position: 11% center;
  --auth-backdrop-filter: none;
  --auth-backdrop-scale: 1;
  --auth-backdrop-overlay: none;
  --auth-backdrop-overlay-opacity: 0;
}

@supports (height: 100dvh) {
  .auth-shell {
    --auth-viewport-height: 100dvh;
  }
}

.auth-shell__frame {
  position: relative;
  width: min(100%, var(--auth-shell-max-width));
  min-height: calc(var(--auth-viewport-height) - var(--auth-shell-pad-top) - var(--auth-shell-pad-bottom));
  flex: 0 1 auto;
  display: flex;
}

.auth-shell__backdrop {
  position: absolute;
  inset: 0;
  overflow: hidden;
  isolation: isolate;
  pointer-events: none;
  border-radius: 38px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.08);
  box-shadow:
    0 36px 100px rgba(15, 23, 42, 0.12),
    inset 0 1px 0 rgba(255, 255, 255, 0.56);
}

.auth-shell__backdrop::before,
.auth-shell__backdrop::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.auth-shell__backdrop::before {
  background-image: var(--auth-backdrop-image);
  background-repeat: no-repeat;
  background-position: var(--auth-backdrop-position);
  background-size: cover;
  opacity: 1;
  filter: var(--auth-backdrop-filter);
  transform: scale(var(--auth-backdrop-scale));
  transform-origin: center;
  will-change: transform, filter;
}

.auth-shell__backdrop::after {
  background: var(--auth-backdrop-overlay);
  opacity: var(--auth-backdrop-overlay-opacity);
}

.auth-shell__inner {
  position: relative;
  z-index: 1;
  width: 100%;
  min-height: 100%;
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding:
    var(--auth-shell-inner-pad-block)
    var(--auth-shell-inner-pad-end)
    var(--auth-shell-inner-pad-block)
    var(--auth-shell-inner-pad-start);
}

.auth-shell__card {
  position: relative;
  width: var(--auth-card-width);
  padding:
    var(--auth-card-padding-block)
    var(--auth-card-padding-inline-end)
    var(--auth-card-padding-block)
    var(--auth-card-padding-inline-start);
  max-height: calc(
    var(--auth-viewport-height)
    - var(--auth-shell-pad-top)
    - var(--auth-shell-pad-bottom)
    - (var(--auth-shell-inner-pad-block) * 2)
  );
  display: grid;
  gap: 22px;
  align-content: start;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
  border-radius: 30px;
  border: 1px solid color-mix(in srgb, var(--app-accent) 16%, rgba(219, 156, 106, 0.28));
  background: color-mix(in srgb, var(--app-panel-bg) 92%, rgba(255, 250, 244, 0.8));
  box-shadow:
    0 22px 56px rgba(15, 23, 42, 0.08),
    0 14px 36px rgba(217, 121, 87, 0.05);
  backdrop-filter: blur(18px);
}

.auth-shell__card::-webkit-scrollbar {
  width: 8px;
}

.auth-shell__card::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--app-accent) 28%, rgba(15, 23, 42, 0.18));
}

.auth-shell__card::-webkit-scrollbar-track {
  background: transparent;
}

.auth-shell__hero {
  display: flex;
  align-items: center;
  gap: 16px;
}

.auth-shell__logo-wrap {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  flex: 0 0 auto;
}

.auth-shell__logo {
  width: 60px;
  height: 60px;
  display: block;
  filter: drop-shadow(0 16px 36px rgba(201, 100, 66, 0.18));
}

.auth-shell__header {
  display: grid;
  gap: 4px;
}

.auth-shell__header h2 {
  margin: 0;
  font-size: 28px;
  line-height: 1.15;
  color: var(--app-text);
}

.auth-shell__header p {
  margin: 0;
  color: var(--app-muted);
  line-height: 1.6;
}

@media (min-width: 1600px) {
  .auth-shell {
    --auth-shell-inner-pad-end: clamp(116px, 8vw, 188px);
    --auth-card-width: min(370px, 100%);
    --auth-card-padding-block: 26px;
    --auth-backdrop-position: 9% center;
  }
}

@media (min-width: 2560px) {
  .auth-shell {
    --auth-shell-max-width: 2360px;
    --auth-shell-pad-top: clamp(28px, 4vh, 60px);
    --auth-shell-pad-bottom: clamp(28px, 4vh, 60px);
    --auth-shell-inner-pad-end: clamp(148px, 8vw, 236px);
    --auth-card-width: min(370px, 100%);
    --auth-card-padding-block: 30px;
    --auth-backdrop-position: 7% center;
    --auth-backdrop-scale: 1;
  }
}

@media (min-width: 2560px) and (min-height: 1400px) {
  .auth-shell {
    --auth-backdrop-position: 7% 46%;
  }
}

@media (min-aspect-ratio: 21/9) and (min-width: 1600px) {
  .auth-shell {
    --auth-shell-max-width: 2280px;
    --auth-shell-inner-pad-end: clamp(132px, 8.5vw, 220px);
    --auth-backdrop-position: 3% center;
  }
}

@media (max-height: 920px) and (min-width: 901px) {
  .auth-shell {
    --auth-shell-pad-top: 8px;
    --auth-shell-pad-bottom: 8px;
    --auth-shell-pad-start: 14px;
    --auth-shell-pad-end: 12px;
    --auth-shell-inner-pad-block: 8px;
    --auth-shell-inner-pad-start: 14px;
    --auth-shell-inner-pad-end: clamp(84px, 7vw, 132px);
    --auth-card-width: min(370px, 100%);
    --auth-card-padding-block: 14px;
  }

  .auth-shell__card {
    gap: 12px;
    border-radius: 24px;
  }

  .auth-shell__hero {
    gap: 10px;
  }

  .auth-shell__logo {
    width: 40px;
    height: 40px;
  }

  .auth-shell__header {
    gap: 2px;
  }

  .auth-shell__header h2 {
    font-size: 22px;
  }

  .auth-shell__header p {
    font-size: 13px;
    line-height: 1.35;
  }
}

@media (max-height: 760px) and (min-width: 901px) {
  .auth-shell {
    --auth-shell-pad-top: 6px;
    --auth-shell-pad-bottom: 6px;
    --auth-shell-inner-pad-block: 6px;
    --auth-shell-pad-end: 10px;
    --auth-shell-inner-pad-end: clamp(76px, 6.5vw, 116px);
    --auth-card-width: min(342px, 100%);
    --auth-card-padding-block: 12px;
  }

  .auth-shell__card {
    gap: 10px;
    border-radius: 22px;
  }

  .auth-shell__logo {
    width: 36px;
    height: 36px;
  }

  .auth-shell__header h2 {
    font-size: 20px;
  }

  .auth-shell__header p {
    font-size: 12px;
  }
}

@media (max-width: 900px) {
  .auth-shell {
    --auth-shell-pad-top: 20px;
    --auth-shell-pad-bottom: 30px;
    --auth-shell-pad-start: 14px;
    --auth-shell-pad-end: 14px;
    --auth-shell-inner-pad-block: 12px;
    --auth-shell-inner-pad-start: 12px;
    --auth-shell-inner-pad-end: 12px;
  }

  .auth-shell__frame {
    min-height: auto;
  }

  .auth-shell__backdrop {
    display: none;
  }

  .auth-shell__inner {
    min-height: auto;
    align-items: flex-start;
  }

  .auth-shell__card {
    width: 100%;
    padding: 22px 5px 22px 11px;
    max-height: none;
    overflow-y: visible;
    scrollbar-gutter: auto;
  }

  .auth-shell__logo {
    width: 52px;
    height: 52px;
  }

  .auth-shell--mobile-login {
    --auth-shell-pad-top: max(18px, env(safe-area-inset-top));
    --auth-shell-pad-bottom: max(22px, env(safe-area-inset-bottom));
    min-height: 100dvh;
    background:
      radial-gradient(circle at 12% 4%, rgba(255, 244, 205, 0.95), transparent 34%),
      radial-gradient(circle at 92% 88%, rgba(40, 139, 103, 0.22), transparent 42%),
      linear-gradient(150deg, #eef4e7 0%, #dce9df 52%, #c9ddd6 100%);
  }

  .auth-shell--mobile-login .auth-shell__frame {
    width: min(100%, 430px);
    min-height: calc(100dvh - var(--auth-shell-pad-top) - var(--auth-shell-pad-bottom));
  }

  .auth-shell--mobile-login .auth-shell__backdrop {
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .auth-shell--mobile-login .auth-shell__backdrop::before,
  .auth-shell--mobile-login .auth-shell__backdrop::after {
    opacity: 0;
  }

  .auth-shell--mobile-login .auth-shell__inner {
    align-items: flex-start;
    padding: 0;
  }

  .auth-shell--mobile-login .auth-shell__card {
    width: 100%;
    padding: 24px 20px;
    border: 1px solid rgba(31, 90, 76, 0.14);
    border-radius: 28px;
    background: rgba(255, 253, 246, 0.92);
    box-shadow: 0 24px 60px rgba(39, 75, 63, 0.16);
    backdrop-filter: blur(18px);
  }

  .auth-shell--mobile-login .auth-shell__hero {
    align-items: flex-start;
  }

  .auth-shell--mobile-login .auth-shell__header h2 {
    font: 700 28px/1.12 Georgia, "Times New Roman", serif;
  }
}

:root[data-theme="dark"] .auth-shell--mobile-login {
  --app-muted: #bbc8be;
  background:
    radial-gradient(circle at 12% 6%, rgba(203, 131, 83, 0.16), transparent 38%),
    radial-gradient(circle at 91% 88%, rgba(73, 143, 107, 0.15), transparent 44%),
    linear-gradient(155deg, #171d1b 0%, #202b27 56%, #1b2624 100%);
}

:root[data-theme="dark"] .auth-shell--mobile-login .auth-shell__card {
  border-color: rgba(202, 223, 207, 0.18);
  background: rgba(35, 43, 40, 0.96);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.32);
}

:root[data-theme="dark"] .auth-shell--mobile-login :deep(.auth-login__form input::placeholder) {
  color: #b3c3b5;
}

:root[data-theme="dark"] .auth-shell--mobile-login :deep(.auth-login__form .ant-input),
:root[data-theme="dark"] .auth-shell--mobile-login :deep(.auth-login__form .ant-input-affix-wrapper) {
  background: #1b2421;
  border-color: rgba(186, 205, 192, 0.24);
}

:root[data-theme="dark"] .auth-shell--mobile-login :deep(.auth-login__footer .ant-btn-link) {
  color: #f4b395;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .auth-shell--mobile-login {
    --app-muted: #bbc8be;
    background:
      radial-gradient(circle at 12% 6%, rgba(203, 131, 83, 0.16), transparent 38%),
      radial-gradient(circle at 91% 88%, rgba(73, 143, 107, 0.15), transparent 44%),
      linear-gradient(155deg, #171d1b 0%, #202b27 56%, #1b2624 100%);
  }

  :root:not([data-theme]) .auth-shell--mobile-login .auth-shell__card {
    border-color: rgba(202, 223, 207, 0.18);
    background: rgba(35, 43, 40, 0.96);
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.32);
  }

  :root:not([data-theme]) .auth-shell--mobile-login :deep(.auth-login__form input::placeholder) {
    color: #b3c3b5;
  }

  :root:not([data-theme]) .auth-shell--mobile-login :deep(.auth-login__form .ant-input),
  :root:not([data-theme]) .auth-shell--mobile-login :deep(.auth-login__form .ant-input-affix-wrapper) {
    background: #1b2421;
    border-color: rgba(186, 205, 192, 0.24);
  }

  :root:not([data-theme]) .auth-shell--mobile-login :deep(.auth-login__footer .ant-btn-link) {
    color: #f4b395;
  }
}
</style>
