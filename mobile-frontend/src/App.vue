<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { demo, roleName } from './demo'
import { useAppearance } from './theme'
import { switchDemoRole, currentAccount, logout } from './stores/accounts'
import { parentPath } from './router'
import { storageProblem } from './persistence'
import { showToast } from 'vant'
import { pendingMediaWrites } from './media'

const route = useRoute()
const router = useRouter()
const { theme } = useAppearance()
const isPublic = computed(() => !!route.meta.public)
const activeTab = computed(() => String(route.meta.tab || 'home'))
const logo = computed(() => `./assets/lexiu-brand/logo_${theme.value === 'dark' ? 'white' : 'dark'}.png`)
const themeVars = computed(() => ({
  primaryColor: theme.value === 'dark' ? '#9DB5FF' : '#2D5BDB',
  buttonPrimaryColor: theme.value === 'dark' ? '#14171D' : '#FFFFFF',
}))
function selectRole(_action: unknown, index: number) {
  if (pendingMediaWrites.value) { showToast('正在保存本机附件，请稍后再切换身份。'); return }
  if (!switchDemoRole(index === 0 ? 'staff' : 'admin')) {
    showToast('该角色暂无可用演示账号，请使用另一角色或重置演示数据。')
    return
  }
  demo.roleSheet = false
  router.replace('/')
}
function back() {
  const parent = parentPath(route)
  const previous = router.options.history.state.back
  if (typeof previous === 'string' && router.resolve(previous).path === parent) router.back()
  else router.push(parent)
}
watch(() => demo.signedIn, signedIn => { if (!signedIn && !route.meta.public) router.replace('/login') })
watch(currentAccount, account => {
  if (!demo.signedIn) return
  if (!account) { logout(); return }
  demo.role = account.role; demo.name = account.name
  if (route.meta.admin && demo.role !== 'admin') router.replace('/')
}, { immediate: true })
</script>

<template>
  <van-config-provider :theme="theme" :theme-vars="themeVars" theme-vars-scope="global">
    <div class="app-shell" :class="{ 'public-shell': isPublic }">
      <header v-if="route.meta.root" class="brand-header">
        <img :src="logo" alt="乐秀 L’OK SHOW" class="brand-logo" width="124" height="20" />
        <van-button class="role-button" size="small" plain icon="exchange" @click="demo.roleSheet = true">{{ roleName }} · 演示</van-button>
      </header>
      <van-nav-bar v-else :title="String(route.meta.title)" safe-area-inset-top>
        <template v-if="isPublic" #title><img :src="logo" alt="乐秀 L’OK SHOW 酒水单" class="brand-logo" width="124" height="20" /></template>
        <template v-if="!isPublic" #left><van-button plain icon="arrow-left" class="nav-back" @click.stop="back">返回</van-button></template>
      </van-nav-bar>
      <div class="demo-strip"><van-icon name="info-o" /> 演示数据 · 未连接真实后端</div>
      <van-notice-bar v-if="storageProblem" wrapable :scrollable="false" :text="storageProblem" />
      <main id="main-content" :class="{ 'has-tabbar': !isPublic }">
        <router-view />
        <div v-if="route.path === '/login'" class="login-switch"><van-button block plain icon="exchange" @click="demo.roleSheet = true">直接切换演示身份</van-button></div>
      </main>
      <van-tabbar v-if="!isPublic" :model-value="activeTab" safe-area-inset-bottom placeholder :border="true">
        <van-tabbar-item name="home" icon="wap-home-o" to="/">工作台</van-tabbar-item>
        <van-tabbar-item name="apps" icon="apps-o" to="/apps">资料</van-tabbar-item>
        <van-tabbar-item name="inventory" icon="logistics" to="/inventory">物资</van-tabbar-item>
        <van-tabbar-item name="me" icon="user-o" to="/me">我的</van-tabbar-item>
      </van-tabbar>
    </div>
    <van-action-sheet v-model:show="demo.roleSheet" title="切换演示身份" :actions="[{ name: '普通员工', subname: '查询、登记与资料提交' }, { name: '管理员', subname: '额外查看审核与管理入口' }]" cancel-text="取消" close-on-click-action @select="selectRole" />
  </van-config-provider>
</template>
