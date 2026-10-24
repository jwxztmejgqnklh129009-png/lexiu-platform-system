import { reactive, watch } from 'vue'

export type Role = 'staff' | 'admin'
const initial = { role: 'staff' as Role, accountId: 'staff-demo', name: '演示员工A', signedIn: true }
let restored = initial
try {
  const saved = JSON.parse(sessionStorage.getItem('lexiu-demo-session') || 'null')
  if (saved && ['staff', 'admin'].includes(saved.role) && typeof saved.accountId === 'string' && typeof saved.signedIn === 'boolean') restored = saved
} catch { /* A new session can always enter the demonstration. */ }
export const session = reactive({ ...restored, roleSheet: false })

export function saveSession() {
  try { sessionStorage.setItem('lexiu-demo-session', JSON.stringify(session)) } catch { /* In-memory session still works. */ }
}
watch(session, saveSession, { deep: true, flush: 'sync' })
