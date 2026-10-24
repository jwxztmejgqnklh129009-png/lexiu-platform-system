import { computed, watch } from 'vue'
import { persistedRef, uid, nowText } from '../persistence'
import { session } from '../session'

export type AccountRole = 'staff' | 'admin'
export type DemoAccount = {
  id: string; username: string; name: string; role: AccountRole; active: boolean
  passwordDigest: string; createdAt: string; lastLogin: string
}
export const DEFAULT_DEMO_PASSWORD = 'Demo1234!'
const defaultDigest = '7dbb7f051b44d7d54584a7bc6c32f00da5a3b5e6973485b9fb176fe56346b3e3'
const seedAccounts = (): DemoAccount[] => [
  { id: 'staff-demo', username: 'staff', name: '演示员工A', role: 'staff', active: true, passwordDigest: defaultDigest, createdAt: '初始演示数据', lastLogin: '' },
  { id: 'admin-demo', username: 'admin', name: '演示管理员', role: 'admin', active: true, passwordDigest: defaultDigest, createdAt: '初始演示数据', lastLogin: '' },
]

export const accounts = persistedRef<DemoAccount[]>('accounts', seedAccounts())
export const activeAccounts = computed(() => accounts.value.filter(account => account.active))
export const currentAccount = computed(() => session.signedIn ? accounts.value.find(account => account.active && account.id === session.accountId) : undefined)
export const accountLedger = computed(() => accounts.value.map(({ passwordDigest: _omitted, ...text }) => text))

function requireAdmin() {
  if (!session.signedIn || session.role !== 'admin' || currentAccount.value?.role !== 'admin') throw new Error('请使用演示管理员账号操作')
}

async function digest(password: string) {
  if (!globalThis.crypto?.subtle) throw new Error('当前环境无法进行演示密码校验，请使用本机 localhost 预览')
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(password))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

function openSession(account: DemoAccount) {
  Object.assign(session, { role: account.role, accountId: account.id, name: account.name, signedIn: true, roleSheet: false })
}

export async function login(username: string, password: string) {
  const loginName = username.trim()
  if (!loginName || loginName.length > 64 || !password || password.length > 256) throw new Error('请检查演示账号和密码长度')
  const passwordDigest = await digest(password)
  const account = accounts.value.find(candidate => candidate.active && candidate.username === loginName && candidate.passwordDigest === passwordDigest)
  if (!account) throw new Error('演示账号或密码不正确，账号也可能已停用')
  accounts.value = accounts.value.map(candidate => candidate.id === account.id ? { ...candidate, lastLogin: nowText() } : candidate)
  openSession(account)
  return account
}

export function logout() {
  Object.assign(session, { role: 'staff', accountId: '', name: '', signedIn: false, roleSheet: false })
}

/** A deliberate demo shortcut, separate from the simulated password form. */
export function switchDemoRole(role: AccountRole) {
  const preferredId = role === 'admin' ? 'admin-demo' : 'staff-demo'
  const account = activeAccounts.value.find(candidate => candidate.role === role && candidate.id === preferredId)
    || activeAccounts.value.find(candidate => candidate.role === role)
  if (!account) return false
  openSession(account)
  return true
}

export async function createAccount(input: { username: string; name: string; role: AccountRole; password?: string }) {
  requireAdmin()
  const username = input.username.trim()
  const name = input.name.trim() || username
  if (!username) throw new Error('请填写登录账号')
  if (username.length > 60) throw new Error('登录账号不能超过60字')
  if (name.length > 60) throw new Error('姓名不能超过60字')
  if (!['staff', 'admin'].includes(input.role)) throw new Error('角色不在可选范围内')
  const password = input.password || DEFAULT_DEMO_PASSWORD
  if (password.length < 6 || password.length > 200) throw new Error('演示密码须为6–200位')
  const passwordDigest = await digest(password)
  requireAdmin()
  const old = accounts.value.find(candidate => candidate.username === username)
  if (old?.active) throw new Error('账号已存在')
  const account: DemoAccount = {
    id: old?.id || uid('account'), username, name, role: input.role, active: true,
    passwordDigest, createdAt: old?.createdAt || nowText(), lastLogin: '',
  }
  accounts.value = old ? accounts.value.map(candidate => candidate.id === old.id ? account : candidate) : [...accounts.value, account]
  return { account, reused: !!old, usedDefaultPassword: !input.password }
}

export function deletionReason(account: DemoAccount) {
  if (account.id === session.accountId) return '当前正在使用的账号不能删除'
  if (account.role === 'admin' && activeAccounts.value.filter(candidate => candidate.role === 'admin').length <= 1) return '至少要保留一个管理员账号'
  return ''
}

export function deleteAccount(id: string) {
  requireAdmin()
  const account = activeAccounts.value.find(candidate => candidate.id === id)
  if (!account) throw new Error('账号不存在，或已被删除')
  const reason = deletionReason(account)
  if (reason) throw new Error(reason)
  accounts.value = accounts.value.map(candidate => candidate.id === id ? { ...candidate, active: false } : candidate)
}

export async function changePassword(current: string, next: string) {
  const account = currentAccount.value
  if (!account) throw new Error('请先登录演示账号')
  if (!current) throw new Error('请填写当前演示密码')
  if (next.length < 6 || next.length > 200) throw new Error('新演示密码须为6–200位')
  const previousDigest = await digest(current)
  if (previousDigest !== account.passwordDigest) throw new Error('当前演示密码不正确')
  const passwordDigest = await digest(next)
  const latest = currentAccount.value
  if (!latest || latest.id !== account.id || latest.passwordDigest !== previousDigest) throw new Error('演示身份已改变，请重新登录后再试')
  accounts.value = accounts.value.map(candidate => candidate.id === account.id ? { ...candidate, passwordDigest } : candidate)
  logout()
}

export function resetAccounts() {
  accounts.value = seedAccounts()
  switchDemoRole('staff')
}

// Keep another local tab's account suspension in sync with this demo session.
watch(accounts, (next, previous) => {
  if (!session.signedIn) return
  const account = next.find(candidate => candidate.active && candidate.id === session.accountId)
  const oldAccount = previous.find(candidate => candidate.id === session.accountId)
  if (!account || oldAccount && account.passwordDigest !== oldAccount.passwordDigest) logout()
  else Object.assign(session, { role: account.role, name: account.name })
}, { deep: true, flush: 'sync' })
