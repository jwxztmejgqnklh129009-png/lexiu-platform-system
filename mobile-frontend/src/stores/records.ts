import { computed } from 'vue'
import { persistedRef, uid, nowText } from '../persistence'
import { session } from '../session'
import type { MediaRef } from '../media'
import type { DemoReview } from '../types'

export type RecordKind = 'company' | 'employee'
export type RecordStatus = 'approved' | 'pending' | 'rejected'
export type ExpiryMode = 'date' | 'longterm' | 'unknown'
export type RecordFields = {
  category: string; name: string; cert_type: string; cert_no: string; issuer: string
  holder: string; keeper: string; issue_date: string; expiry_mode: ExpiryMode
  expiry_date: string; remind_days: number; paper_location: string; note: string
}
export type CertificateRecord = RecordFields & {
  id: string; scope: RecordKind; flow_status: RecordStatus; created_by: string
  created_name: string; created_at: string; reject_reason: string
}
export type CertificateVersion = {
  id: string; cert_id: string; version_no: number; file: MediaRef; change_note: string
  status: RecordStatus | 'history'; uploaded_by: string; uploaded_name: string
  uploaded_at: string; reject_reason: string; reviewed_at?: string
}
export type RecordEdit = {
  id: string; cert_id: string; base: RecordFields; patch: Partial<RecordFields>
  status: RecordStatus; by: string; by_name: string; at: string; reason: string
}
export const recordCategories = ['消防', '文旅', '公安', '健康证', '其他']
export const recordFieldLabels: Record<keyof RecordFields, string> = {
  category: '资料分类', name: '资料名称', cert_type: '证件类型', cert_no: '证件编号', issuer: '签发单位',
  holder: '持有人', keeper: '保管人', issue_date: '签发日期', expiry_mode: '有效期类型',
  expiry_date: '有效期至', remind_days: '提醒天数', paper_location: '纸质存放位置', note: '备注',
}
const fieldKeys = Object.keys(recordFieldLabels) as (keyof RecordFields)[]
export function emptyRecordFields(): RecordFields {
  return { category: '其他', name: '', cert_type: '', cert_no: '', issuer: '', holder: '', keeper: '', issue_date: '', expiry_mode: 'date', expiry_date: '', remind_days: 15, paper_location: '', note: '' }
}
function dateOffset(days: number) {
  const d = new Date(); d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function seedRecords(): CertificateRecord[] {
  return [
    { ...emptyRecordFields(), id: 'company-license-demo', scope: 'company', category: '文旅', name: '娱乐经营许可证（演示）', cert_type: '经营许可', cert_no: 'DEMO-001', issuer: '演示签发单位', keeper: '演示保管人', expiry_date: dateOffset(12), paper_location: '办公室资料柜（演示）', flow_status: 'approved', created_by: 'admin-demo', created_name: '演示管理员', created_at: nowText(), reject_reason: '' },
    { ...emptyRecordFields(), id: 'company-fire-demo', scope: 'company', category: '消防', name: '消防检查资料（演示）', expiry_mode: 'longterm', paper_location: '消防资料柜（演示）', flow_status: 'approved', created_by: 'admin-demo', created_name: '演示管理员', created_at: nowText(), reject_reason: '' },
    { ...emptyRecordFields(), id: 'health-a-demo', scope: 'employee', category: '健康证', name: '演示员工 A 的健康证', holder: '演示员工 A', expiry_date: dateOffset(90), flow_status: 'approved', created_by: 'admin-demo', created_name: '演示管理员', created_at: nowText(), reject_reason: '' },
    { ...emptyRecordFields(), id: 'health-b-demo', scope: 'employee', category: '健康证', name: '演示员工 B 的健康证', holder: '演示员工 B', expiry_date: dateOffset(-3), flow_status: 'approved', created_by: 'admin-demo', created_name: '演示管理员', created_at: nowText(), reject_reason: '' },
    { ...emptyRecordFields(), id: 'company-pending-demo', scope: 'company', category: '其他', name: '待审核资料（演示）', expiry_mode: 'unknown', flow_status: 'pending', created_by: 'staff-demo', created_name: '演示员工A', created_at: nowText(), reject_reason: '' },
  ]
}
export const records = persistedRef<CertificateRecord[]>('records', seedRecords())
function seedVersions(): CertificateVersion[] {
  const file: MediaRef = { id: 'sample:record', name: '档案示例（非真实证件）.svg', mime: 'image/svg+xml', size: 0 }
  return [
    { id: 'record-version-current-demo', cert_id: 'company-license-demo', version_no: 1, file, change_note: '界面演示样张，不是真实证件', status: 'approved', uploaded_by: 'admin-demo', uploaded_name: '演示管理员', uploaded_at: nowText(), reject_reason: '' },
    { id: 'record-version-pending-demo', cert_id: 'company-license-demo', version_no: 2, file, change_note: '待审状态演示，审核前原版本保留', status: 'pending', uploaded_by: 'staff-demo', uploaded_name: '演示员工A', uploaded_at: nowText(), reject_reason: '' },
  ]
}
export const recordVersions = persistedRef<CertificateVersion[]>('record-versions', seedVersions())
export const recordEdits = persistedRef<RecordEdit[]>('record-edits', [])
const isAdmin = () => session.signedIn && session.role === 'admin'
function requireUser() { if (!session.signedIn) throw new Error('请先登录演示账户') }
function requireAdmin() { requireUser(); if (!isAdmin()) throw new Error('仅管理员可以执行此操作') }
export function canSeeRecord(row: CertificateRecord) {
  return session.signedIn && (isAdmin() || row.flow_status === 'approved' || row.created_by === session.accountId)
}
export const visibleRecords = computed(() => records.value.filter(canSeeRecord))
export function findRecord(id: string) { return visibleRecords.value.find(row => row.id === id) }
export function fieldsOf(row: RecordFields): RecordFields {
  return Object.fromEntries(fieldKeys.map(key => [key, row[key]])) as RecordFields
}
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(y!, m! - 1, d!)
  return date.getFullYear() === y && date.getMonth() === m! - 1 && date.getDate() === d
}
function cleanFields(input: RecordFields, scope: RecordKind): RecordFields {
  const result = { ...input }
  for (const key of fieldKeys) if (typeof result[key] === 'string') (result as unknown as Record<string, unknown>)[key] = String(result[key]).trim()
  if (!result.name) throw new Error('请填写资料名称')
  if (!recordCategories.includes(result.category)) throw new Error('请选择已有资料分类')
  if (!['date', 'longterm', 'unknown'].includes(result.expiry_mode)) throw new Error('请选择有效期类型')
  if (result.issue_date && !validDate(result.issue_date)) throw new Error('签发日期格式不正确')
  if (result.expiry_date && !validDate(result.expiry_date)) throw new Error('到期日期格式不正确')
  if (result.expiry_mode === 'date' && !result.expiry_date) throw new Error('请选择有效期至')
  if (!Number.isInteger(Number(result.remind_days)) || Number(result.remind_days) < 0 || Number(result.remind_days) > 3650) throw new Error('提醒天数须为 0–3650 的整数')
  result.remind_days = Number(result.remind_days)
  if (scope === 'employee') {
    if (!result.holder) throw new Error('请填写员工姓名')
    if (result.expiry_mode !== 'date' || !result.expiry_date) throw new Error('健康证须填写有效期至')
    result.category = '健康证'
  }
  return result
}
function requireRecord(id: string) {
  requireUser(); const row = findRecord(id)
  if (!row) throw new Error('该资料不存在或当前账户无权查看')
  return row
}
export function expiryOf(row: RecordFields) {
  if (row.expiry_mode === 'longterm') return { level: 'longterm', label: '长期有效', days: null }
  if (row.expiry_mode === 'unknown' || !row.expiry_date) return { level: 'unknown', label: '有效期待确认', days: null }
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const days = Math.round((new Date(`${row.expiry_date}T00:00:00`).getTime() - today.getTime()) / 86400000)
  if (days <= 0) return { level: 'expired', label: days === 0 ? '今天到期' : `已过期 ${-days} 天`, days }
  if (days <= 15) return { level: 'warning', label: `15 天内到期 · 剩 ${days} 天`, days }
  return { level: 'ok', label: '正常有效', days }
}
export const recordStatusText = (status: string) => ({ approved: '已生效', pending: '待审核', rejected: '已退回', history: '历史版本' }[status] || status)
export function visibleVersions(certId: string) {
  if (!findRecord(certId)) return []
  return recordVersions.value.filter(v => v.cert_id === certId && (isAdmin() || ['approved', 'history'].includes(v.status) || v.uploaded_by === session.accountId)).sort((a, b) => b.version_no - a.version_no)
}
export function versionOpenable(v: CertificateVersion) { return isAdmin() || ['approved', 'history'].includes(v.status) || (v.status === 'pending' && v.uploaded_by === session.accountId) }
export function currentVersion(certId: string) {
  const all = visibleVersions(certId)
  return all.find(v => v.status === 'approved') || all[0]
}
export function visibleRecordEdits(certId: string) {
  if (!findRecord(certId)) return []
  return recordEdits.value.filter(e => e.cert_id === certId && (isAdmin() || e.by === session.accountId)).slice().reverse()
}
export function createRecord(scope: RecordKind, input: RecordFields) {
  requireUser(); const fields = cleanFields(input, scope)
  const row: CertificateRecord = { ...fields, id: uid('cert'), scope, flow_status: isAdmin() ? 'approved' : 'pending', created_by: session.accountId, created_name: session.name, created_at: nowText(), reject_reason: '' }
  records.value.unshift(row); return row
}
export function updateRecord(id: string, input: RecordFields) {
  const row = requireRecord(id); const fields = cleanFields(input, row.scope)
  const base = fieldsOf(row)
  const patch: Partial<RecordFields> = {}
  for (const key of fieldKeys) if (base[key] !== fields[key]) (patch as Record<string, unknown>)[key] = fields[key]
  if (!Object.keys(patch).length) throw new Error('内容没有变化，无需重复提交')
  if (isAdmin()) Object.assign(row, patch)
  else recordEdits.value.push({ id: uid('cert-edit'), cert_id: id, base, patch, status: 'pending', by: session.accountId, by_name: session.name, at: nowText(), reason: '' })
}
export function validateRecordAttachment(file: MediaRef) {
  if (!/\.(pdf|jpe?g|png|docx?|xlsx?)$/i.test(file.name)) throw new Error('附件支持 PDF、JPG、PNG、Word 和 Excel')
  if (file.size <= 0 || file.size > 20 * 1024 * 1024) throw new Error('附件须为非空文件，且不得超过 20MB')
}
export function addRecordVersion(id: string, file: MediaRef, changeNote: string) {
  const row = requireRecord(id)
  validateRecordAttachment(file)
  const versions = recordVersions.value.filter(v => v.cert_id === id)
  const status = isAdmin() ? 'approved' : 'pending'
  if (isAdmin()) {
    for (const v of versions) if (v.status === 'approved') v.status = 'history'
    row.flow_status = 'approved'; row.reject_reason = ''
  }
  const version: CertificateVersion = { id: uid('cert-version'), cert_id: id, version_no: Math.max(0, ...versions.map(v => v.version_no)) + 1, file, change_note: changeNote.trim(), status, uploaded_by: session.accountId, uploaded_name: session.name, uploaded_at: nowText(), reject_reason: '' }
  recordVersions.value.push(version); return version
}
export function deleteRecord(id: string) {
  requireAdmin(); requireRecord(id)
  records.value = records.value.filter(r => r.id !== id)
  recordVersions.value = recordVersions.value.filter(v => v.cert_id !== id)
  recordEdits.value = recordEdits.value.filter(e => e.cert_id !== id)
}
export const recordReviews = computed<DemoReview[]>(() => [
  ...records.value.filter(r => r.flow_status === 'pending').map(r => ({ id: `records:record:${r.id}`, kind: 'cert', kindLabel: r.scope === 'company' ? '企业证照' : '员工健康证', title: r.name, sub: '新增资料', by: r.created_name, at: r.created_at, description: '审核资料信息。附件版本另有独立审核项。', sourcePath: `/records/${r.scope}/${r.id}`, fields: [{ label: '分类', value: r.category }, { label: '有效期', value: expiryOf(r).label }] })),
  ...recordVersions.value.filter(v => v.status === 'pending' && records.value.some(r => r.id === v.cert_id)).map(v => { const r = records.value.find(r => r.id === v.cert_id)!; return { id: `records:version:${v.id}`, kind: 'version', kindLabel: '证照附件', title: r.name, sub: `附件 v${v.version_no}`, by: v.uploaded_name, at: v.uploaded_at, description: v.change_note || '未填写版本说明', sourcePath: `/records/${r.scope}/${r.id}`, files: [v.file] } }),
  ...recordEdits.value.filter(e => e.status === 'pending' && records.value.some(r => r.id === e.cert_id)).map(e => { const r = records.value.find(r => r.id === e.cert_id)!; return { id: `records:edit:${e.id}`, kind: 'cert_edit', kindLabel: '证照修改', title: r.name, sub: '字段修改申请', by: e.by_name, at: e.at, description: '通过后才更新生效内容；原内容有变化时须重新提交。', sourcePath: `/records/${r.scope}/${r.id}`, fields: Object.entries(e.patch).map(([k, v]) => ({ label: recordFieldLabels[k as keyof RecordFields], value: `${formatRecordField(k, e.base[k as keyof RecordFields])} → ${formatRecordField(k, v)}` })) } }),
])
export function formatRecordField(key: string, value: unknown) {
  if (key === 'expiry_mode') return ({ date: '指定日期', longterm: '长期有效', unknown: '待确认' }[String(value)] || String(value))
  return value === '' || value == null ? '未填写' : String(value)
}
export function resolveRecordReview(id: string, action: 'approve' | 'reject', reason = '') {
  requireAdmin()
  if (!id.startsWith('records:')) throw new Error('没有这类证照待审事项')
  if (!['approve', 'reject'].includes(action)) throw new Error('未知审核操作')
  if (action === 'reject' && (!reason.trim() || reason.trim().length > 200)) throw new Error('请填写 1–200 字的退回原因')
  const [, type, entityId] = id.split(':')
  const status = action === 'approve' ? 'approved' : 'rejected'
  if (type === 'record') {
    const row = records.value.find(r => r.id === entityId)
    if (!row || row.flow_status !== 'pending') throw new Error('该资料已处理或不存在，请刷新列表')
    row.flow_status = status; row.reject_reason = action === 'reject' ? reason.trim() : ''; return
  }
  if (type === 'version') {
    const version = recordVersions.value.find(v => v.id === entityId)
    const parent = records.value.find(r => r.id === version?.cert_id)
    if (!version || !parent || version.status !== 'pending') throw new Error('该附件已处理或不存在，请刷新列表')
    version.status = status; version.reject_reason = action === 'reject' ? reason.trim() : ''; version.reviewed_at = nowText()
    if (action === 'approve') {
      recordVersions.value.forEach(v => { if (v.cert_id === parent.id && v.id !== version.id && v.status === 'approved') v.status = 'history' })
      parent.flow_status = 'approved'; parent.reject_reason = ''
    }
    return
  }
  if (type === 'edit') {
    const edit = recordEdits.value.find(e => e.id === entityId)
    const parent = records.value.find(r => r.id === edit?.cert_id)
    if (!edit || !parent || edit.status !== 'pending') throw new Error('该申请已处理或不存在，请刷新列表')
    if (action === 'approve') {
      for (const key of Object.keys(edit.patch) as (keyof RecordFields)[]) if (parent[key] !== edit.base[key]) throw new Error('资料内容已变化，不能覆盖。请退回并重新提交修改。')
      Object.assign(parent, edit.patch)
    }
    edit.status = status; edit.reason = action === 'reject' ? reason.trim() : ''; return
  }
  throw new Error('没有这类证照待审事项')
}
export function resetRecords() { records.value = seedRecords(); recordVersions.value = seedVersions(); recordEdits.value = [] }
