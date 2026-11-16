<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, inject, type Ref } from "vue";

defineOptions({ name: "VirtualGroup" });

type Props = {
  groupKey: string;
  estimatedHeight?: number;
  alwaysRender?: boolean;
};

const props = withDefaults(defineProps<Props>(), {
  estimatedHeight: 120,
  alwaysRender: false,
});

const scrollRoot = inject<Ref<HTMLElement | null>>("virtualScrollRoot", ref(null));
const heightCache = inject<Map<string, number>>("virtualHeightCache", new Map());

const rootEl = ref<HTMLElement | null>(null);
const visible = ref(props.alwaysRender);
const knownHeight = ref(heightCache.get(props.groupKey) ?? props.estimatedHeight);

let intersectionObs: IntersectionObserver | null = null;
let resizeObs: ResizeObserver | null = null;

/** Record current element height into cache (only when real content is rendered). */
function captureHeight(): void {
  const el = rootEl.value;
  if (!el) return;
  if (!visible.value && !props.alwaysRender) return;
  const h = el.offsetHeight;
  if (h > 0) {
    knownHeight.value = h;
    heightCache.set(props.groupKey, h);
  }
}

function setupIntersectionObserver(): void {
  teardownIntersectionObserver();
  if (props.alwaysRender || !rootEl.value) return;

  intersectionObs = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && !visible.value) {
          visible.value = true;
        } else if (!entry.isIntersecting && visible.value) {
          captureHeight();
          visible.value = false;
        }
      }
    },
    {
      root: scrollRoot.value ?? null,
      rootMargin: "200px 0px",
    },
  );

  intersectionObs.observe(rootEl.value);
}

function teardownIntersectionObserver(): void {
  if (intersectionObs) {
    intersectionObs.disconnect();
    intersectionObs = null;
  }
}

function setupResizeObserver(): void {
  teardownResizeObserver();
  if (!rootEl.value) return;

  resizeObs = new ResizeObserver(() => captureHeight());
  resizeObs.observe(rootEl.value);
}

function teardownResizeObserver(): void {
  if (resizeObs) {
    resizeObs.disconnect();
    resizeObs = null;
  }
}

onMounted(() => {
  const cached = heightCache.get(props.groupKey);
  if (cached != null) knownHeight.value = cached;

  setupIntersectionObserver();
  setupResizeObserver();
});

onUnmounted(() => {
  teardownIntersectionObserver();
  teardownResizeObserver();
});

watch(() => scrollRoot.value, () => {
  if (!props.alwaysRender) setupIntersectionObserver();
});

watch(() => props.alwaysRender, (val) => {
  if (val) {
    visible.value = true;
    teardownIntersectionObserver();
  } else {
    setupIntersectionObserver();
  }
});
</script>

<template>
  <div ref="rootEl" class="virtual-group">
    <template v-if="visible || alwaysRender">
      <slot />
    </template>
    <div v-else :style="{ height: knownHeight + 'px' }" class="virtual-group__placeholder" />
  </div>
</template>
