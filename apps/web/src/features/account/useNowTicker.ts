import { onBeforeUnmount, onMounted, ref } from "vue";

export function useNowTicker(intervalMs = 1000) {
  const now = ref(Date.now());
  let timer: number | null = null;

  onMounted(() => {
    timer = window.setInterval(() => {
      now.value = Date.now();
    }, intervalMs);
  });

  onBeforeUnmount(() => {
    if (timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  });

  return now;
}
