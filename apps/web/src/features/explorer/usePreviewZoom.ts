import { computed, ref, watch, type Ref } from "vue";

export type PreviewZoomKind = "code" | "markdown" | "image" | "diff";

const ZOOM_RANGES: Record<PreviewZoomKind, { min: number; max: number; step: number }> = {
  code: { min: 0.4, max: 1.8, step: 0.1 },
  markdown: { min: 0.3, max: 1.8, step: 0.1 },
  diff: { min: 0.4, max: 1.8, step: 0.1 },
  image: { min: 0.3, max: 3, step: 0.25 },
};

function roundScale(v: number): number {
  return Math.round(v * 100) / 100;
}

function clampScale(kind: PreviewZoomKind, v: number): number {
  const range = ZOOM_RANGES[kind];
  return roundScale(Math.min(range.max, Math.max(range.min, v)));
}

export function usePreviewZoom(kind: Ref<PreviewZoomKind | null>) {
  const scale = ref(1);

  watch(kind, () => {
    scale.value = 1;
  }, { immediate: true });

  const canZoom = computed(() => Boolean(kind.value));
  const scaleLabel = computed(() => `${Math.round(scale.value * 100)}%`);
  const canZoomIn = computed(() => {
    if (!kind.value) return false;
    return scale.value < ZOOM_RANGES[kind.value].max;
  });
  const canZoomOut = computed(() => {
    if (!kind.value) return false;
    return scale.value > ZOOM_RANGES[kind.value].min;
  });

  function zoomIn(): void {
    if (!kind.value) return;
    scale.value = clampScale(kind.value, scale.value + ZOOM_RANGES[kind.value].step);
  }

  function zoomOut(): void {
    if (!kind.value) return;
    scale.value = clampScale(kind.value, scale.value - ZOOM_RANGES[kind.value].step);
  }

  function resetZoom(): void {
    scale.value = 1;
  }

  return {
    scale,
    scaleLabel,
    canZoom,
    canZoomIn,
    canZoomOut,
    zoomIn,
    zoomOut,
    resetZoom,
  };
}
