import { createRouter, createWebHashHistory, type RouteLocationNormalized } from 'vue-router'
import HomePage from './pages/HomePage.vue'
import AppsPage from './pages/AppsPage.vue'
import InventoryPage from './pages/InventoryPage.vue'
import InventoryDetail from './pages/InventoryDetail.vue'
import InventoryForm from './pages/InventoryForm.vue'
import StocktakePage from './pages/StocktakePage.vue'
import AssetsPage from './pages/AssetsPage.vue'
import AssetDetail from './pages/AssetDetail.vue'
import RecordsPage from './pages/RecordsPage.vue'
import RecordDetail from './pages/RecordDetail.vue'
import RecordForm from './pages/RecordForm.vue'
import FirePage from './pages/FirePage.vue'
import FireDirectory from './pages/FireDirectory.vue'
import FirePrint from './pages/FirePrint.vue'
import ReviewsPage from './pages/ReviewsPage.vue'
import ReviewDetail from './pages/ReviewDetail.vue'
import MyPage from './pages/MyPage.vue'
import DrinksPage from './pages/DrinksPage.vue'
import DrinkAdmin from './pages/DrinkAdmin.vue'
import SettingsPage from './pages/SettingsPage.vue'
import LoginPage from './pages/LoginPage.vue'
import PasswordPage from './pages/PasswordPage.vue'
import RemindersPage from './pages/RemindersPage.vue'
import NotFoundPage from './pages/NotFoundPage.vue'
import { session } from './session'
import { modulePath } from './demo'
import { pendingMediaWrites } from './media'
import { showToast } from 'vant'
const pagePositions = new Map<string, { left: number; top: number }>()
export function parentPath(route: Pick<RouteLocationNormalized, 'meta' | 'params'>) {
  return String(route.meta.back || '/').replace(/:([a-zA-Z]+)/g, (_, key: string) => encodeURIComponent(String(route.params[key] || '')))
}
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: HomePage, meta: { title: '工作台', tab: 'home', root: true } },
    { path: '/apps', component: AppsPage, meta: { title: '资料', tab: 'apps', root: true } },
    { path: '/inventory', component: InventoryPage, meta: { title: '仓库管理', tab: 'inventory', root: true } },
    { path: '/inventory/new', component: InventoryForm, meta: { title: '新增物品', tab: 'inventory', back: '/inventory' } },
    { path: '/inventory/stocktake', component: StocktakePage, meta: { title: '分类批量盘点', tab: 'inventory', back: '/inventory' } },
    { path: '/inventory/:id/edit', component: InventoryForm, meta: { title: '编辑物品档案', tab: 'inventory', admin: true, back: '/inventory/:id' } },
    { path: '/inventory/:id', component: InventoryDetail, meta: { title: '物品详情', tab: 'inventory', back: '/inventory' } },
    { path: '/assets', component: AssetsPage, meta: { title: '固定资产', tab: 'apps', back: '/apps' } },
    { path: '/assets/:id', component: AssetDetail, meta: { title: '资产详情', tab: 'apps', back: '/assets' } },
    { path: '/records/:kind', component: RecordsPage, meta: { title: '档案资料', tab: 'apps', back: '/apps' } },
    { path: '/records/:kind/new', component: RecordForm, meta: { title: '新增资料', tab: 'apps', back: '/records/:kind' } },
    { path: '/records/:kind/:id/edit', component: RecordForm, meta: { title: '编辑资料', tab: 'apps', back: '/records/:kind/:id' } },
    { path: '/records/:kind/:id', component: RecordDetail, meta: { title: '资料详情', tab: 'apps', back: '/records/:kind' } },
    { path: '/fire', component: FirePage, meta: { title: '消防档案', tab: 'apps', back: '/apps' } },
    { path: '/fire/print', component: FirePrint, meta: { title: '消防分册打印', tab: 'apps', back: '/fire' } },
    { path: '/fire/:code', component: FireDirectory, meta: { title: '消防目录', tab: 'apps', back: '/fire' } },
    { path: '/reviews', component: ReviewsPage, meta: { title: '审核中心', tab: 'apps', admin: true, back: '/' } },
    { path: '/reviews/:id', component: ReviewDetail, meta: { title: '审核详情', tab: 'apps', admin: true, back: '/reviews' } },
    { path: '/reminders', component: RemindersPage, meta: { title: '有效期提醒', tab: 'home', back: '/' } },
    { path: '/me', component: MyPage, meta: { title: '我的', tab: 'me', root: true } },
    { path: '/drinks', component: DrinksPage, meta: { title: '乐秀酒水单', public: true } },
    { path: '/drink-admin', component: DrinkAdmin, meta: { title: '酒水单维护', tab: 'apps', admin: true, back: '/apps' } },
    { path: '/settings', component: SettingsPage, meta: { title: '账号与设置', tab: 'me', admin: true, back: '/me' } },
    { path: '/login', component: LoginPage, meta: { title: '演示登录', public: true } },
    { path: '/password', component: PasswordPage, meta: { title: '修改演示密码', tab: 'me', back: '/me' } },
    { path: '/module/:key', redirect: to => modulePath(String(to.params.key)) },
    { path: '/:pathMatch(.*)*', component: NotFoundPage, meta: { title: '页面不存在', tab: 'home', back: '/' } },
  ],
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition
    if (to.path === from.path) return false
    if (parentPath(from) === to.path || to.meta.root) return pagePositions.get(to.fullPath) || { left: 0, top: 0 }
    return { top: 0 }
  },
})
router.beforeEach((to, from) => {
  if (pendingMediaWrites.value) { showToast('正在保存本机附件，请完成后再离开。'); return false }
  if (!to.meta.public && !session.signedIn) return { path: '/login', query: { next: to.fullPath } }
  if (to.meta.admin && session.role !== 'admin') return '/'
  if (to.params.kind && !['company', 'employee'].includes(String(to.params.kind))) return '/apps'
  if (from.matched.length) pagePositions.set(from.fullPath, { left: window.scrollX, top: window.scrollY })
})
router.afterEach(to => { document.title = `${String(to.meta.title || '门店管理')} · 乐秀演示` })
