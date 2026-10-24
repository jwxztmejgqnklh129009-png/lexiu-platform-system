<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { showConfirmDialog } from 'vant'
import { session } from '../session'
import { roleName } from '../demo'
import { logout } from '../stores/accounts'
import { themeChoice } from '../theme'
const router = useRouter()
const appearanceSheet = ref(false)
const appearanceActions = [{ name: '跟随系统', value: 'auto' }, { name: '日间模式', value: 'light' }, { name: '夜间模式', value: 'dark' }]
async function exit() {
  try { await showConfirmDialog({ title: '退出演示账号？', message: '演示记录和附件保留在当前浏览器，重新登录后可继续查看。', confirmButtonText: '退出登录' }) } catch { return }
  logout(); router.replace('/login')
}
</script>
<template><div class="page"><div class="page-heading"><div><h1>我的</h1></div></div><div class="profile-intro"><van-icon name="user-circle-o" size="48" /><div><h2>{{ session.name }}</h2><p>{{ session.role === 'admin' ? '管理员账号' : '普通员工账号' }} · 本机演示</p></div></div>
<section class="section"><div class="section-heading"><h2>使用偏好</h2></div><van-cell-group inset><van-cell title="显示模式" :value="appearanceActions.find(a => a.value === themeChoice)?.name" icon="bulb-o" is-link @click="appearanceSheet = true" /><van-cell title="切换演示身份" :value="roleName" icon="exchange" is-link @click="session.roleSheet = true" /></van-cell-group></section>
<section class="section"><div class="section-heading"><h2>账号与服务</h2></div><van-cell-group inset><van-cell title="修改演示密码" icon="lock" is-link to="/password" /><van-cell v-if="session.role === 'admin'" title="账号与设置" label="账号管理、文字台账与恢复演示" icon="setting-o" is-link to="/settings" /><van-cell title="查看公开酒水单" label="无需登录即可浏览" icon="photo-o" is-link to="/drinks" /><van-cell title="退出演示账号" icon="close" is-link @click="exit" /></van-cell-group></section><p class="section-caption">文字记录与所选附件仅保存在当前浏览器，清理浏览器数据后会丢失。请勿使用真实证件、手机号或真实密码进行演示。</p><van-action-sheet v-model:show="appearanceSheet" title="显示模式" :actions="appearanceActions" cancel-text="取消" close-on-click-action @select="action => { themeChoice = action.value; appearanceSheet = false }" /></div></template>
