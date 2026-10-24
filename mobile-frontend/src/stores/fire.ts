import { computed } from 'vue'
import { persistedRef, uid, nowText } from '../persistence'
import { session } from '../session'
import { getMediaUrl, type MediaRef } from '../media'
import type { DemoReview } from '../types'

export const fireDirectories = [
  ['A01', '单位基本情况'], ['A02', '建筑物基本情况'], ['A03', '单位概貌与地理位置图 共两页'], ['A04', '消防平面与疏散路线图'],
  ['A05', '消防安全重点部位情况'], ['A06', '消防行政许可与备案文件目录'], ['A07', '消防管理组织及任命登记'], ['A08', '管理人员与重点工种人员'],
  ['A09', '消防队站人员与装备'], ['A10', '消防安全制度与规程目录'], ['A11', '消防安全责任及签认'], ['A12', '消防安全管理制度参考文本 共五页'],
  ['A13', '消防安全操作规程编制页'], ['A14', '消防设施设备明细'], ['A15', '灭火器材配置与维修台账'], ['A16', '新增消防产品与防火材料资料'],
  ['A17', '灭火和应急疏散预案 共两页'], ['A18', '年度消防工作计划与经费'], ['B01', '消防法律文书登记'], ['B02', '每日防火巡查记录'],
  ['B03', '防火检查记录'], ['B04', '火灾隐患整改台账'], ['B05', '隐患整改与复查确认单'], ['B06', '消防设施故障处理记录'],
  ['B07', '消防控制室交接记录'], ['B08', '消防控制室值班运行记录'], ['B09', '消防设施检查与维护保养记录 共两页'], ['B10', '消防设施检测报告登记'],
  ['B11', '燃气电气防雷防静电检查记录'], ['B12', '消防安全教育培训记录'], ['B13', '培训及演练签到表'], ['B14', '灭火和应急疏散演练记录'],
  ['B15', '培训演练及整改照片资料'], ['B16', '消防安全会议记录'], ['B17', '四个能力自查评估'], ['B18', '火灾情况记录'],
  ['B19', '消防工作考评与奖惩记录'], ['B20', '三项报告及受理凭证存档 共两页'], ['B21', '标准化管理自查自评'], ['B22', '消防安全自查承诺及公开记录'],
].map(([code, name]) => ({ code: code!, name: name!, book: code!.startsWith('A') ? 'A' : 'B' }))
export type FirePhoto = {
  id: string; code: string; file: MediaRef; status: 'approved' | 'pending' | 'rejected' | 'replaced'
  sort_order: number | null; replaces_id: string | null; batch: string; batch_index: number
  uploaded_by: string; uploaded_name: string; uploaded_at: string; reason: string; width: number; height: number
}
export type FireOrder = {
  id: string; code: string; base: string[]; target: string[]; status: 'pending' | 'approved' | 'rejected'
  by: string; by_name: string; at: string; reason: string
}
function seedFirePhotos(): FirePhoto[] {
  return [
    { id: 'fire-demo-1', code: 'A01', file: { id: 'sample:fire', name: '演示样张一（非现场照片）.svg', mime: 'image/svg+xml', size: 0 }, status: 'approved', sort_order: 1, replaces_id: null, batch: 'demo-seed', batch_index: 0, uploaded_by: 'admin-demo', uploaded_name: '演示管理员', uploaded_at: nowText(), reason: '', width: 1000, height: 700 },
    { id: 'fire-demo-2', code: 'A01', file: { id: 'sample:fire', name: '演示样张二（非现场照片）.svg', mime: 'image/svg+xml', size: 0 }, status: 'approved', sort_order: 2, replaces_id: null, batch: 'demo-seed', batch_index: 1, uploaded_by: 'admin-demo', uploaded_name: '演示管理员', uploaded_at: nowText(), reason: '', width: 1000, height: 700 },
    { id: 'fire-demo-pending', code: 'B01', file: { id: 'sample:fire', name: '待审演示样张（非现场照片）.svg', mime: 'image/svg+xml', size: 0 }, status: 'pending', sort_order: null, replaces_id: null, batch: 'demo-pending', batch_index: 0, uploaded_by: 'staff-demo', uploaded_name: '演示员工A', uploaded_at: nowText(), reason: '', width: 1000, height: 700 },
  ]
}
export const firePhotos = persistedRef<FirePhoto[]>('fire-photos', seedFirePhotos())
export const fireOrders = persistedRef<FireOrder[]>('fire-orders', [])
const admin = () => session.signedIn && session.role === 'admin'
function requireUser() { if (!session.signedIn) throw new Error('请先登录演示账户') }
function requireAdmin() { requireUser(); if (!admin()) throw new Error('仅管理员可以执行此操作') }
export function fireDirectory(code: string) { return fireDirectories.find(d => d.code === code) }
function requireDirectory(code: string) { requireUser(); if (!fireDirectory(code)) throw new Error('没有这个消防目录') }
export function approvedFirePhotos(code: string) { return firePhotos.value.filter(p => p.code === code && p.status === 'approved').sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)) }
export function visibleFirePhotos(code: string) {
  if (!session.signedIn) return []
  return firePhotos.value.filter(p => p.code === code && (admin() || p.status === 'approved' || (p.uploaded_by === session.accountId && ['pending', 'rejected'].includes(p.status))))
}
export function firePhotoOpenable(p: FirePhoto) { return admin() || p.status === 'approved' || (p.status === 'pending' && p.uploaded_by === session.accountId) }
export function visibleFireOrders(code: string) { return fireOrders.value.filter(o => o.code === code && (admin() || o.by === session.accountId)).slice().reverse() }
export const fireStatusText = (s: string) => ({ approved: '已生效', pending: '待审核', rejected: '已退回', replaced: '已替换' }[s] || s)
export function fireCounts(code: string) {
  const visible = visibleFirePhotos(code)
  return { approved: approvedFirePhotos(code).length, pending: visible.filter(p => p.status === 'pending').length, orders: visibleFireOrders(code).filter(o => o.status === 'pending').length }
}
function normalizeOrder(code: string) { approvedFirePhotos(code).forEach((p, i) => { p.sort_order = i + 1 }) }
function insertApproved(photo: FirePhoto) {
  const current = approvedFirePhotos(photo.code)
  if (photo.replaces_id) {
    const old = current.find(p => p.id === photo.replaces_id)
    if (!old) throw new Error('原照片已变更，不能应用替换。请退回并重新上传。')
    const position = old.sort_order
    old.status = 'replaced'; old.sort_order = null
    photo.status = 'approved'; photo.sort_order = position
  } else {
    // 同批次按选择顺序插入，逐张审核的先后不会改变原选择顺序。
    const siblings = current.filter(p => p.batch === photo.batch && p.uploaded_by === photo.uploaded_by)
    if (siblings.some((p, index) => index > 0 && siblings[index - 1]!.batch_index >= p.batch_index)) throw new Error('该批照片页序已变化，请先确认或调整页序')
    const later = siblings.find(p => p.batch_index > photo.batch_index)
    const earlier = siblings.filter(p => p.batch_index < photo.batch_index).at(-1)
    const index = later ? current.indexOf(later) : earlier ? current.indexOf(earlier) + 1 : current.length
    current.splice(index, 0, photo)
    photo.status = 'approved'
    current.forEach((p, i) => { p.sort_order = i + 1 })
  }
  normalizeOrder(photo.code)
}
async function imageSize(file: MediaRef) {
  const url = await getMediaUrl(file)
  const img = new Image()
  await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error(`${file.name} 无法读取，请重新选择图片`)); img.src = url })
  if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 60_000_000) throw new Error('消防图片像素不得超过 6000 万')
  return { width: img.naturalWidth, height: img.naturalHeight }
}
export async function uploadFirePhotos(code: string, files: MediaRef[], replacesId?: string) {
  requireDirectory(code)
  const account = session.accountId; const role = session.role
  if (!files.length) throw new Error('请先选择照片')
  if (replacesId && files.length !== 1) throw new Error('每次替换请选择一张照片')
  if (replacesId && !approvedFirePhotos(code).some(p => p.id === replacesId)) throw new Error('原照片已变化，请刷新目录')
  // 全批次先验证后写状态，避免其中一张失败造成不明确的半提交。
  const checked = [] as { file: MediaRef; width: number; height: number }[]
  for (const file of files) {
    if (!['image/jpeg', 'image/png'].includes(file.mime) || !/\.(jpe?g|png)$/i.test(file.name)) throw new Error('消防照片仅支持有效 JPG、PNG 图片')
    if (!file.size || file.size > 15 * 1024 * 1024) throw new Error('每张消防照片须为非空文件，且不超过 15MB')
    checked.push({ file, ...await imageSize(file) })
  }
  // 图片加载期间账户或目录内容可能发生变化，提交前再核对。
  requireDirectory(code)
  if (session.accountId !== account || session.role !== role) throw new Error('演示账户已切换，请重新确认上传')
  if (replacesId && !approvedFirePhotos(code).some(p => p.id === replacesId)) throw new Error('原照片已变化，请刷新目录')
  const batch = uid('fire-batch')
  for (const [index, checkedFile] of checked.entries()) {
    const photo: FirePhoto = { id: uid('fire-photo'), code, ...checkedFile, status: 'pending', sort_order: null, replaces_id: replacesId || null, batch, batch_index: index, uploaded_by: session.accountId, uploaded_name: session.name, uploaded_at: nowText(), reason: '' }
    firePhotos.value.push(photo)
    if (admin()) insertApproved(photo)
  }
}
const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])
function validateOrder(code: string, base: string[], target: string[]) {
  const current = approvedFirePhotos(code).map(p => p.id)
  if (!same(base, current)) throw new Error('目录照片或顺序已变化，请刷新后重新调整')
  if (new Set(target).size !== target.length || target.length !== current.length || !target.every(id => current.includes(id))) throw new Error('排序必须包含本目录全部生效照片，不能重复或跨目录')
}
function applyOrder(code: string, base: string[], target: string[]) {
  validateOrder(code, base, target)
  target.forEach((id, index) => { firePhotos.value.find(p => p.id === id)!.sort_order = index + 1 })
}
export function submitFireOrder(code: string, base: string[], target: string[]) {
  requireDirectory(code); validateOrder(code, base, target)
  if (same(base, target)) throw new Error('顺序没有变化')
  if (admin()) { applyOrder(code, base, target); return }
  if (fireOrders.value.some(o => o.code === code && o.by === session.accountId && o.status === 'pending' && same(o.base, base) && same(o.target, target))) throw new Error('相同排序申请已提交，请等待审核')
  fireOrders.value.push({ id: uid('fire-order'), code, base: [...base], target: [...target], status: 'pending', by: session.accountId, by_name: session.name, at: nowText(), reason: '' })
}
export function deleteFirePhoto(id: string) {
  requireAdmin(); const old = firePhotos.value.find(p => p.id === id)
  if (!old) throw new Error('照片已不存在')
  firePhotos.value = firePhotos.value.filter(p => p.id !== id)
  firePhotos.value.forEach(p => { if (p.replaces_id === id && p.status === 'pending') { p.status = 'rejected'; p.reason = '原照片已删除，请重新选择目录上传' } })
  normalizeOrder(old.code)
}
export const fireReviews = computed<DemoReview[]>(() => [
  ...firePhotos.value.filter(p => p.status === 'pending').map(p => ({ id: `fire:photo:${p.id}`, kind: 'fire_photo', kindLabel: '消防照片', title: `${p.code} ${fireDirectory(p.code)?.name || ''}`, sub: p.replaces_id ? '替换照片申请' : '新增照片', by: p.uploaded_name, at: p.uploaded_at, description: p.replaces_id ? '通过后替换现图并保留其历史；审核前现图继续生效。' : '通过后加入本目录生效照片。', sourcePath: `/fire/${p.code}`, files: [p.file] })),
  ...fireOrders.value.filter(o => o.status === 'pending').map(o => ({ id: `fire:order:${o.id}`, kind: 'fire_order', kindLabel: '消防排序', title: `${o.code} ${fireDirectory(o.code)?.name || ''}`, sub: '照片排序申请', by: o.by_name, at: o.at, description: '通过前会核对目录快照，已变化的旧排序不能覆盖现状。', sourcePath: `/fire/${o.code}`, fields: [{ label: '申请顺序', value: o.target.map(id => firePhotos.value.find(p => p.id === id)?.file.name || '已移除照片').join(' → ') }] })),
])
export function resolveFireReview(id: string, action: 'approve' | 'reject', reason = '') {
  requireAdmin()
  if (!id.startsWith('fire:') || !['approve', 'reject'].includes(action)) throw new Error('未知消防审核操作')
  if (action === 'reject' && (!reason.trim() || reason.trim().length > 1000)) throw new Error('请填写 1–1000 字的退回原因')
  const [, type, entityId] = id.split(':')
  if (type === 'photo') {
    const photo = firePhotos.value.find(p => p.id === entityId)
    if (!photo || photo.status !== 'pending') throw new Error('该照片已处理或不存在，请刷新列表')
    if (action === 'approve') insertApproved(photo)
    else { photo.status = 'rejected'; photo.reason = reason.trim() }
    return
  }
  if (type === 'order') {
    const order = fireOrders.value.find(o => o.id === entityId)
    if (!order || order.status !== 'pending') throw new Error('该申请已处理或不存在，请刷新列表')
    if (action === 'approve') applyOrder(order.code, order.base, order.target)
    order.status = action === 'approve' ? 'approved' : 'rejected'; order.reason = action === 'reject' ? reason.trim() : ''; return
  }
  throw new Error('没有这类消防待审事项')
}
export function firePrintSnapshot(scope: string) {
  requireUser()
  if (scope !== 'all' && !fireDirectory(scope)) throw new Error('打印目录不存在')
  return fireDirectories.filter(d => scope === 'all' || d.code === scope).flatMap(d => approvedFirePhotos(d.code).map(p => ({ ...p, file: { ...p.file }, directory_name: d.name })))
}
export function fireSnapshotKey(scope: string) { return JSON.stringify(firePrintSnapshot(scope).map(p => [p.code, p.id, p.sort_order, p.file.id, p.file.size, p.width, p.height])) }
export function resetFire() { firePhotos.value = seedFirePhotos(); fireOrders.value = [] }
