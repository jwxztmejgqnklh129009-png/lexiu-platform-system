import { computed } from 'vue'
import { session } from './session'
export { session as demo } from './session'
export type { Role } from './session'
export type ThemeChoice = 'auto' | 'light' | 'dark'
export const roleName = computed(() => session.role === 'admin' ? '管理员' : '员工')
export const modules = [
  { key: 'company', name: '企业证照', note: '证照、有效期与附件版本', icon: 'description-o', group: '档案资料' },
  { key: 'employee', name: '员工健康证', note: '健康证、有效期与附件', icon: 'friends-o', group: '档案资料' },
  { key: 'fire', name: '消防档案', note: '固定目录、照片与分册打印', icon: 'shield-o', group: '档案资料' },
  { key: 'assets', name: '固定资产', note: '登记、领用与归还', icon: 'desktop-o', group: '门店物资' },
  { key: 'inventory', name: '仓库管理', note: '库存、入出库与盘点', icon: 'logistics', group: '门店物资' },
  { key: 'reviews', name: '审核中心', note: '核对申请、通过或退回', icon: 'todo-list-o', group: '管理功能', admin: true },
  { key: 'drink-admin', name: '酒水单维护', note: '上传、排序与公开展示', icon: 'photo-o', group: '管理功能', admin: true },
  { key: 'settings', name: '账号与设置', note: '演示账号、文字台账与恢复', icon: 'setting-o', group: '管理功能', admin: true },
]
export function modulePath(key: string) {
  const paths: Record<string, string> = { company: '/records/company', employee: '/records/employee', fire: '/fire', assets: '/assets', inventory: '/inventory', reviews: '/reviews', 'drink-admin': '/drink-admin', settings: '/settings', password: '/password', 'inventory-new': '/inventory/new', stocktake: '/inventory/stocktake' }
  return paths[key] || '/apps'
}
