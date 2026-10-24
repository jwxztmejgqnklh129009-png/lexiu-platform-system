import { computed, onUnmounted, ref, watch } from 'vue'
import type { ThemeChoice } from './demo'

function savedTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem('lexiu-appearance')
    return saved === 'light' || saved === 'dark' ? saved : 'auto'
  } catch { return 'auto' }
}
export const themeChoice = ref<ThemeChoice>(savedTheme())

export function useAppearance() {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const systemDark = ref(query.matches)
  const update = () => { systemDark.value = query.matches }
  query.addEventListener('change', update)
  onUnmounted(() => query.removeEventListener('change', update))
  const theme = computed(() => themeChoice.value === 'auto' ? (systemDark.value ? 'dark' : 'light') : themeChoice.value)
  watch([theme, themeChoice], () => {
    document.documentElement.dataset.theme = theme.value
    document.documentElement.style.colorScheme = theme.value
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.value === 'dark' ? '#14171D' : '#F5F6F8')
    try { localStorage.setItem('lexiu-appearance', themeChoice.value) } catch { /* Browser can disable storage. */ }
  }, { immediate: true })
  return { theme }
}
