import { computed, reactive } from 'vue'
import { persistedRef, uid, nowText } from '../persistence'
import { session } from '../session'
import type { MediaRef } from '../media'
import type { DemoReview } from '../types'

export type ReviewStatus = 'approved' | 'pending' | 'rejected'
export type Category = '酒水' | '耗材' | '其它'
export type ExpiryMode = 'date' | 'longterm' | 'unknown'
export type Expiry = { level: 'ok' | 'warn' | 'expired' | 'longterm' | 'unknown'; label: string; days: number | null }
export type WarehouseItem = {
  id: number; name: string; category: Category; spec: string; unit: string; quantity: number; safety_stock: number
  expiry_mode: ExpiryMode; expiry_date: string; warn_days: number; expiry: Expiry; location: string; note: string
  status: ReviewStatus; created_by: string; created_name: string; created_at: string; reject_reason: string
  stock_log_id: number; active: boolean; current_image: MediaRef | null
}
export type StockLog = { id: number; item_id: number; action: 'initial' | 'purchase' | 'consume' | 'adjust'; change_qty: number; after_qty: number; supplier: string; operator: string; at: string; note: string }
export type ImageVersion = { id: string; item_id: number; version_no: number; file: MediaRef; status: ReviewStatus | 'history'; uploaded_by: string; uploaded_name: string; uploaded_at: string; reject_reason: string }
export type Asset = { id: number; name: string; code: string; category: string; location: string; note: string; status: 'in_stock' | 'taken'; holder: string; taken_at: string; review_status: ReviewStatus; created_by: string; created_name: string; created_at: string; reject_reason: string }
export type AssetLog = { id: number; asset_id: number; action: 'take' | 'return'; person: string; at: string; note: string }
export type ItemDraft = Pick<WarehouseItem, 'name' | 'category' | 'spec' | 'unit' | 'safety_stock' | 'expiry_mode' | 'expiry_date' | 'warn_days' | 'location' | 'note'> & { quantity: number }
export type StocktakeRow = { id: number; name: string; spec: string; unit: string; month_begin: number; month_purchase: number; month_consume: number; quantity: number; stock_log_id: number }
export type CountInput = { id: number; actual: number; expected_quantity: number; expected_stock_log_id: number }
export const categories: Category[] = ['酒水', '耗材', '其它']
export const statusText = (status: ReviewStatus | 'history') => ({ approved: '已生效', pending: '待审核', rejected: '已退回', history: '历史版本' }[status])
export const logActionText = { initial: '期初建账', purchase: '采购入库', consume: '消耗出库', adjust: '盘点调整' }
export const inventoryQuery = reactive({ search: '', category: '全部', lowOnly: false, expiry: 'all' })

function dateOffset(days: number) { const date = new Date(); date.setDate(date.getDate() + days); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
export function getExpiry(item: Pick<WarehouseItem, 'expiry_mode' | 'expiry_date'>): Expiry {
  if (item.expiry_mode === 'longterm') return { level: 'longterm', label: '长期有效', days: null }
  if (item.expiry_mode === 'unknown' || !item.expiry_date) return { level: 'unknown', label: '有效期待确认', days: null }
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const days = Math.round((new Date(`${item.expiry_date}T00:00:00`).getTime() - today.getTime()) / 86400000)
  if (!Number.isFinite(days)) return { level: 'unknown', label: '有效期待确认', days: null }
  if (days <= 0) return { level: 'expired', label: days === 0 ? '今天到期' : `已过期 ${-days} 天`, days }
  if (days <= 15) return { level: 'warn', label: `${days} 天后到期`, days }
  return { level: 'ok', label: `有效期至 ${item.expiry_date}`, days }
}
function makeItem(id: number, name: string, category: Category, spec: string, unit: string, quantity: number, safety_stock: number, location: string, days: number | null, note = '', status: ReviewStatus = 'approved'): WarehouseItem {
  const expiry_mode = days === null ? 'longterm' : 'date'; const expiry_date = days === null ? '' : dateOffset(days)
  return { id, name, category, spec, unit, quantity, safety_stock, location, note, expiry_mode, expiry_date, warn_days: 15, expiry: getExpiry({ expiry_mode, expiry_date }), status, created_by: status === 'approved' ? 'admin-demo' : 'staff-demo', created_name: status === 'approved' ? '演示管理员' : '演示员工A', created_at: nowText(), reject_reason: '', stock_log_id: id, active: true, current_image: null }
}
function seedInventory() { return [
  makeItem(1, '百威啤酒', '酒水', '330mL / 瓶', '瓶', 18, 24, '酒水仓 A02', 147, '整件与散瓶均按瓶登记。'),
  makeItem(2, '科罗娜特级啤酒', '酒水', '330mL / 瓶', '瓶', 72, 24, '酒水仓 A03', 168),
  makeItem(3, '一次性杯', '耗材', '50只 / 包', '包', 36, 10, '耗材架 B01', null, '按包登记，不按单只登记。'),
  makeItem(4, '果盘叉', '耗材', '100支 / 包', '包', 8, 30, '耗材架 B02', null),
  makeItem(5, '苏打水', '酒水', '350mL / 瓶', '瓶', 48, 24, '酒水仓 A05', 6, '本批次优先使用。'),
  { ...makeItem(6, '无线麦克风电池', '其它', '5号 / 2节装', '对', 16, 12, '备品柜 C01', null), expiry_mode: 'unknown' as const, expiry: { level: 'unknown' as const, label: '有效期待确认', days: null } },
  makeItem(7, '演示果汁（过期样例）', '酒水', '1L / 盒', '盒', 2, 0, '待处理区', -2, '仅展示过期提醒，不是真实库存。'),
  makeItem(8, '纸巾（中包）', '耗材', '100抽 / 包', '包', 60, 20, '耗材架 B03', null, '演示待审核物品。', 'pending'),
] }
const initialItems = seedInventory()
export const inventory = persistedRef<WarehouseItem[]>('warehouse:items', initialItems)
export const stockLogs = persistedRef<StockLog[]>('warehouse:logs', initialItems.map(item => ({ id: item.id, item_id: item.id, action: 'initial', change_qty: item.quantity, after_qty: item.quantity, supplier: '', operator: item.created_name, at: item.created_at, note: '期初建账 · 演示数据' })))
export const imageVersions = persistedRef<ImageVersion[]>('warehouse:images', [])
function seedAssets(): Asset[] { return [
  { id: 1, name: '无线麦克风套装', code: 'ZC-001', category: '音响', location: '前台设备柜', note: '一套两支，领还时核对。', status: 'in_stock', holder: '', taken_at: '', review_status: 'approved', created_by: 'admin-demo', created_name: '演示管理员', created_at: nowText(), reject_reason: '' },
  { id: 2, name: '便携工作平板', code: 'ZC-002', category: '电器', location: '前台', note: '演示资产，不对应真实设备。', status: 'taken', holder: '演示员工B', taken_at: nowText(), review_status: 'approved', created_by: 'admin-demo', created_name: '演示管理员', created_at: nowText(), reject_reason: '' },
  { id: 3, name: '备用对讲机', code: 'ZC-003', category: '电器', location: '备品柜', note: '员工新增待审核样例。', status: 'in_stock', holder: '', taken_at: '', review_status: 'pending', created_by: 'staff-demo', created_name: '演示员工A', created_at: nowText(), reject_reason: '' },
] }
export const assets = persistedRef<Asset[]>('warehouse:assets', seedAssets())
export const assetLogs = persistedRef<AssetLog[]>('warehouse:asset-logs', [])
let lastNumericId = Date.now()
const numericId = () => { lastNumericId = Math.max(Date.now(), lastNumericId + 1); return lastNumericId }
export const canSeeItem = (item: WarehouseItem) => item.active && (session.role === 'admin' || item.status === 'approved' || item.created_by === session.accountId)
export const canSeeAsset = (asset: Asset) => session.role === 'admin' || asset.review_status === 'approved' || asset.created_by === session.accountId
export const visibleInventory = computed(() => inventory.value.filter(canSeeItem))
export const visibleAssets = computed(() => assets.value.filter(canSeeAsset))
export const isLow = (item: Pick<WarehouseItem, 'quantity' | 'safety_stock'>) => item.safety_stock > 0 && item.quantity < item.safety_stock
export const lowItems = computed(() => visibleInventory.value.filter(item => item.status === 'approved' && isLow(item)))
function requireAdmin() { if (session.role !== 'admin') throw new Error('此操作仅管理员可用') }
function integer(value: unknown, min = 0) { if (value === '' || value === null || typeof value === 'boolean' || (typeof value === 'string' && !/^[+]?\d+$/.test(value.trim())) || !Number.isSafeInteger(Number(value)) || Number(value) < min) throw new Error(`数量必须为${min > 0 ? '大于0的' : '非负'}整数`); return Number(value) }
function requireItem(id: number, approved = false) { const item = inventory.value.find(row => row.id === id); if (!item || !canSeeItem(item)) throw new Error('物品不存在、已删除或当前账号无权查看'); if (approved && item.status !== 'approved') throw new Error('物品审核通过后才能入库、出库或盘点'); return item }
export function validateDraft(draft: ItemDraft) {
  if (!draft.name.trim()) throw new Error('请填写物品名称')
  if (!categories.includes(draft.category)) throw new Error('请选择有效分类')
  if (!draft.unit.trim() || draft.unit.trim().length > 10 || /[\r\n\t]/.test(draft.unit)) throw new Error('单位需填写1至10字，不能含换行')
  integer(draft.quantity); integer(draft.safety_stock)
  if (!['date', 'longterm', 'unknown'].includes(draft.expiry_mode)) throw new Error('请选择有效期方式')
  if (draft.expiry_mode === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(draft.expiry_date) || Number.isNaN(Date.parse(draft.expiry_date)) || new Date(`${draft.expiry_date}T00:00:00Z`).toISOString().slice(0, 10) !== draft.expiry_date)) throw new Error('请填写有效的到期日期')
  integer(draft.warn_days); if (draft.warn_days > 3650) throw new Error('提前提醒天数不能超过3650天')
}
export function createItem(draft: ItemDraft) {
  validateDraft(draft); const id = numericId(); const at = nowText(); const status = session.role === 'admin' ? 'approved' : 'pending'
  const item: WarehouseItem = { ...draft, name: draft.name.trim(), unit: draft.unit.trim(), id, quantity: integer(draft.quantity), safety_stock: integer(draft.safety_stock), expiry: getExpiry(draft), created_by: session.accountId, created_name: session.name, created_at: at, status, reject_reason: '', stock_log_id: draft.quantity ? numericId() : 0, active: true, current_image: null }
  inventory.value = [...inventory.value, item]
  if (item.quantity) stockLogs.value = [{ id: item.stock_log_id, item_id: id, action: 'initial', change_qty: item.quantity, after_qty: item.quantity, supplier: '', operator: session.name, at, note: '期初建账' }, ...stockLogs.value]
  return id
}
export function editItem(id: number, draft: ItemDraft) { requireAdmin(); validateDraft(draft); const item = requireItem(id); const quantity = item.quantity; inventory.value = inventory.value.map(row => row.id === id ? { ...row, ...draft, quantity, name: draft.name.trim(), unit: draft.unit.trim(), expiry: getExpiry(draft) } : row) }
function appendLog(item: WarehouseItem, action: StockLog['action'], change_qty: number, supplier: string, note: string) {
  const id = numericId(); const after_qty = item.quantity + change_qty
  if (!Number.isSafeInteger(after_qty) || after_qty < 0) throw new Error('变动后数量超出允许范围')
  inventory.value = inventory.value.map(row => row.id === item.id ? { ...row, quantity: after_qty, stock_log_id: id } : row)
  stockLogs.value = [{ id, item_id: item.id, action, change_qty, after_qty, supplier: supplier.trim(), note: note.trim(), operator: session.name, at: nowText() }, ...stockLogs.value]
}
export function moveStock(id: number, mode: 'in' | 'out', qty: number, supplier = '', note = '') { const item = requireItem(id, true); integer(qty, 1); if (mode === 'out' && qty > item.quantity) throw new Error(`库存不足：当前只有${item.quantity}${item.unit}`); appendLog(item, mode === 'in' ? 'purchase' : 'consume', mode === 'in' ? qty : -qty, mode === 'in' ? supplier : '', note) }
export class StocktakeConflict extends Error { constructor(public ids: number[]) { super('账面数据已变化，请重新加载账面数据并重新清点。实盘输入已保留。'); this.name = 'StocktakeConflict' } }
export function stocktakeRows(category: Category): StocktakeRow[] {
  const month = nowText().slice(0, 7)
  return visibleInventory.value.filter(item => item.status === 'approved' && item.category === category).map(item => {
    const logs = stockLogs.value.filter(log => log.item_id === item.id && log.at.startsWith(month))
    const month_purchase = logs.filter(log => log.action === 'purchase').reduce((sum, log) => sum + log.change_qty, 0)
    const month_consume = -logs.filter(log => log.action === 'consume').reduce((sum, log) => sum + log.change_qty, 0)
    // 保留原接口字段及计算口径；根审计已记录原后端月初数口径的限制。
    return { id: item.id, name: item.name, spec: item.spec, unit: item.unit, quantity: item.quantity, stock_log_id: item.stock_log_id, month_begin: item.quantity - month_purchase + month_consume, month_purchase, month_consume }
  })
}
export function countStock(inputs: CountInput[], single = false) {
  if (!inputs.length) throw new Error('请至少填写一项实盘数量')
  const seen = new Set<number>(); const rows = inputs.map(input => { if (seen.has(input.id)) throw new Error('盘点物品重复，请重新加载'); seen.add(input.id); integer(input.actual); integer(input.expected_quantity); integer(input.expected_stock_log_id); return { input, item: requireItem(input.id, true) } })
  const conflicts = rows.filter(({ input, item }) => item.quantity !== input.expected_quantity || item.stock_log_id !== input.expected_stock_log_id).map(({ item }) => item.id)
  if (conflicts.length) throw new StocktakeConflict(conflicts)
  let changed = 0; let unchanged = 0
  rows.forEach(({ input, item }) => { const diff = input.actual - item.quantity; if (!diff) unchanged++; if (diff || single) { appendLog(item, 'adjust', diff, '', diff > 0 ? `盘盈 ${diff}` : diff < 0 ? `盘亏 ${-diff}` : '账实相符'); if (diff) changed++ } })
  return { changed, unchanged }
}
export function addItemImage(id: number, file: MediaRef) {
  requireItem(id); if (!['image/jpeg', 'image/png'].includes(file.mime)) throw new Error('物品图片仅支持JPG或PNG'); if (file.size > 15 * 1024 * 1024 || file.size <= 0) throw new Error('请选择15MB以内的有效图片')
  const approved = session.role === 'admin'; const versions = imageVersions.value.filter(v => v.item_id === id)
  const version: ImageVersion = { id: uid('image'), item_id: id, version_no: Math.max(0, ...versions.map(v => v.version_no)) + 1, file, status: approved ? 'approved' : 'pending', uploaded_by: session.accountId, uploaded_name: session.name, uploaded_at: nowText(), reject_reason: '' }
  imageVersions.value = [...imageVersions.value.map(v => approved && v.item_id === id && v.status === 'approved' ? { ...v, status: 'history' as const } : v), version]
  if (approved) inventory.value = inventory.value.map(row => row.id === id ? { ...row, current_image: file } : row)
  return version
}
export const visibleImageVersions = (id: number) => imageVersions.value.filter(v => v.item_id === id && (session.role === 'admin' || ['approved', 'history'].includes(v.status) || v.uploaded_by === session.accountId)).sort((a, b) => b.version_no - a.version_no)
export const canOpenImageVersion = (version: ImageVersion) => session.role === 'admin' || ['approved', 'history'].includes(version.status) || (version.status === 'pending' && version.uploaded_by === session.accountId)
export function removeItemImages(id: number) { requireAdmin(); requireItem(id); imageVersions.value = imageVersions.value.filter(v => v.item_id !== id); inventory.value = inventory.value.map(row => row.id === id ? { ...row, current_image: null } : row) }
export function deleteItem(id: number, confirmName: string) { requireAdmin(); const item = requireItem(id); if (confirmName.trim() !== item.name) throw new Error('名称不一致，未删除'); inventory.value = inventory.value.map(row => row.id === id ? { ...row, active: false, current_image: null } : row); imageVersions.value = imageVersions.value.filter(v => v.item_id !== id) }
export function createAsset(draft: Pick<Asset, 'name' | 'code' | 'category' | 'location' | 'note'>) { if (!draft.name.trim()) throw new Error('请填写资产名称'); if (draft.code.length > 60 || draft.category.length > 60 || draft.location.length > 120) throw new Error('编号、分类或位置过长'); const id = numericId(); assets.value = [...assets.value, { ...draft, name: draft.name.trim(), id, status: 'in_stock', holder: '', taken_at: '', review_status: session.role === 'admin' ? 'approved' : 'pending', created_by: session.accountId, created_name: session.name, created_at: nowText(), reject_reason: '' }]; return id }
export function moveAsset(id: number, action: 'take' | 'return', person: string, note = '') { const asset = assets.value.find(row => row.id === id); if (!asset || !canSeeAsset(asset)) throw new Error('资产不存在或无权查看'); if (asset.review_status !== 'approved') throw new Error('审核通过后才能领用或归还'); if (!person.trim() || person.trim().length > 60) throw new Error('请填写1至60字的领用/归还人姓名'); if ((action === 'take' && asset.status !== 'in_stock') || (action === 'return' && asset.status !== 'taken')) throw new Error('资产状态刚发生变化，请重新查看'); const at = nowText(); assets.value = assets.value.map(row => row.id === id ? { ...row, status: action === 'take' ? 'taken' : 'in_stock', holder: action === 'take' ? person.trim() : '', taken_at: action === 'take' ? at : '' } : row); assetLogs.value = [{ id: numericId(), asset_id: id, action, person: person.trim(), at, note: note.trim() }, ...assetLogs.value] }

export const warehouseReviews = computed<DemoReview[]>(() => [
  ...inventory.value.filter(item => item.active && item.status === 'pending').map(item => ({ id: `warehouse:item:${item.id}`, kind: 'item', kindLabel: '仓库物品', title: item.name, sub: `新增物品 · ${item.category}`, by: item.created_name, at: item.created_at, description: item.note || '核对新增物品档案后决定是否生效。', sourcePath: `/inventory/${item.id}`, files: item.current_image ? [item.current_image] : [], fields: [{ label: '规格', value: item.spec || '未填写' }, { label: '期初库存', value: `${item.quantity}${item.unit}` }, { label: '安全库存', value: `${item.safety_stock}${item.unit}` }, { label: '存放位置', value: item.location || '未填写' }, { label: '有效期', value: getExpiry(item).label }] })),
  ...assets.value.filter(asset => asset.review_status === 'pending').map(asset => ({ id: `warehouse:asset:${asset.id}`, kind: 'asset', kindLabel: '固定资产', title: asset.name, sub: `新增资产 · ${asset.category || '未分类'}`, by: asset.created_name, at: asset.created_at, description: asset.note || '核对资产登记信息后决定是否生效。', sourcePath: `/assets/${asset.id}`, fields: [{ label: '编号', value: asset.code || '未填写' }, { label: '分类', value: asset.category || '未填写' }, { label: '位置', value: asset.location || '未填写' }] })),
  ...imageVersions.value.filter(v => v.status === 'pending' && inventory.value.some(item => item.id === v.item_id && item.active)).map(v => ({ id: `warehouse:image:${v.id}`, kind: 'item_image', kindLabel: '物品图片', title: inventory.value.find(item => item.id === v.item_id)!.name, sub: `第 ${v.version_no} 版图片 · ${v.file.name}`, by: v.uploaded_name, at: v.uploaded_at, description: '审核通过后替换当前图片，原图片保留为历史版本；退回不会改变当前图片。', sourcePath: `/inventory/${v.item_id}`, files: [v.file] })),
])
export function resolveWarehouseReview(id: string, action: 'approve' | 'reject', reason = '') {
  requireAdmin(); if (action === 'reject' && (!reason.trim() || reason.trim().length > 200)) throw new Error('退回原因需填写1至200字')
  if (!warehouseReviews.value.some(review => review.id === id)) throw new Error('此申请已处理或不存在')
  const [, kind, ...rest] = id.split(':'); const source = rest.join(':'); const status: ReviewStatus = action === 'approve' ? 'approved' : 'rejected'
  if (kind === 'item') inventory.value = inventory.value.map(item => item.id === Number(source) ? { ...item, status, reject_reason: reason.trim() } : item)
  else if (kind === 'asset') assets.value = assets.value.map(asset => asset.id === Number(source) ? { ...asset, review_status: status, reject_reason: reason.trim() } : asset)
  else if (kind === 'image') { const version = imageVersions.value.find(v => v.id === source)!; imageVersions.value = imageVersions.value.map(v => v.id === source ? { ...v, status, reject_reason: reason.trim() } : action === 'approve' && v.item_id === version.item_id && v.status === 'approved' ? { ...v, status: 'history' as const } : v); if (action === 'approve') inventory.value = inventory.value.map(item => item.id === version.item_id ? { ...item, current_image: version.file } : item) }
}
export function resetWarehouse() { const items = seedInventory(); inventory.value = items; stockLogs.value = items.map(item => ({ id: item.id, item_id: item.id, action: 'initial', change_qty: item.quantity, after_qty: item.quantity, supplier: '', operator: item.created_name, at: item.created_at, note: '期初建账 · 演示数据' })); assets.value = seedAssets(); assetLogs.value = []; imageVersions.value = []; inventoryQuery.search = ''; inventoryQuery.category = '全部'; inventoryQuery.lowOnly = false; inventoryQuery.expiry = 'all' }
