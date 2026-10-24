import { ref, watch, type Ref } from 'vue'

export const storageProblem = ref('')
const prefix = 'lexiu-demo-v1:'
const cells = new Map<string, Ref<unknown>>()
const external = new Set<string>()
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))

export function persistedRef<T>(key: string, initial: T): Ref<T> {
  const fullKey = prefix + key
  if (cells.has(fullKey)) return cells.get(fullKey) as Ref<T>
  let value = copy(initial)
  try {
    const text = localStorage.getItem(fullKey)
    if (text) {
      const saved = JSON.parse(text)
      const sameType = Array.isArray(initial) ? Array.isArray(saved) : typeof saved === typeof initial && saved !== null
      if (sameType) value = saved
      else storageProblem.value = '部分演示记录格式异常，已恢复初始内容。'
    }
  } catch { storageProblem.value = '本浏览器暂时不能读取演示记录，当前操作仅在本次打开期间保留。' }
  const state = ref(value) as Ref<T>
  cells.set(fullKey, state as Ref<unknown>)
  watch(state, next => {
    if (external.has(fullKey)) return
    try { localStorage.setItem(fullKey, JSON.stringify(next)) }
    catch { storageProblem.value = '浏览器存储空间不足或已禁用保存，请先导出演示台账。当前修改可能在刷新后丢失。' }
  }, { deep: true, flush: 'sync' })
  return state
}

window.addEventListener('storage', event => {
  if (!event.key?.startsWith(prefix) || !event.newValue || !cells.has(event.key)) return
  try {
    const saved = JSON.parse(event.newValue)
    const state = cells.get(event.key)!
    if (Array.isArray(state.value) !== Array.isArray(saved) || typeof state.value !== typeof saved) return
    external.add(event.key)
    state.value = saved
    external.delete(event.key)
  } catch { /* Ignore a partial or incompatible change from another tab. */ }
})

export const uid = (label = 'demo') => `${label}-${crypto.randomUUID()}`
export function nowText() {
  const date = new Date()
  const two = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}
