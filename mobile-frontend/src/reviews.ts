import { computed } from 'vue'
import { warehouseReviews, resolveWarehouseReview } from './stores/warehouse'
import { recordReviews, resolveRecordReview } from './stores/records'
import { fireReviews, resolveFireReview } from './stores/fire'
import { persistedRef, nowText } from './persistence'
import { session } from './session'
import type { DemoReview } from './types'
export const reviews = computed<DemoReview[]>(() => [...warehouseReviews.value, ...recordReviews.value, ...fireReviews.value].sort((a, b) => b.at.localeCompare(a.at)))
export const handledReviews = persistedRef<{ id: string; title: string; result: string; reason: string; by: string; at: string }[]>('handled-reviews', [])
export function resolveReview(id: string, action: 'approve' | 'reject', reason = '') {
  if (!session.signedIn || session.role !== 'admin') throw new Error('请使用管理员演示身份审核。')
  const item = reviews.value.find(row => row.id === id)
  if (!item) throw new Error('这项申请已处理或不存在，请返回列表查看。')
  const text = reason.trim()
  if (action === 'reject' && (!text || text.length > 200)) throw new Error('请填写 1–200 字的退回原因。')
  if (id.startsWith('warehouse:')) resolveWarehouseReview(id, action, text)
  else if (id.startsWith('records:')) resolveRecordReview(id, action, text)
  else if (id.startsWith('fire:')) resolveFireReview(id, action, text)
  else throw new Error('无法识别这项申请，请返回列表。')
  handledReviews.value = [{ id, title: item.title, result: action === 'approve' ? '已通过' : '已退回', reason: text, by: session.name, at: nowText() }, ...handledReviews.value]
}
