<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Checkbox as VanCheckbox, showToast } from 'vant'
import { session } from '../session'
import { login, DEFAULT_DEMO_PASSWORD } from '../stores/accounts'
import '../settings.css'
const router = useRouter()
const form = reactive({ username: '', password: '' })
const passwordVisible = ref(false)
const loading = ref(false)
const error = ref('')
const rememberAccount = ref(false)
const rememberKey = 'lexiu-demo-login-name'
try {
  const remembered = localStorage.getItem(rememberKey)
  if (remembered && remembered.length <= 64) { form.username = remembered; rememberAccount.value = true }
} catch { /* Login remains available when preferences cannot be read. */ }
watch(rememberAccount, remember => { if (!remember) { try { localStorage.removeItem(rememberKey) } catch { showToast('账号偏好未能清除，请检查浏览器存储权限') } } })
function saveAccountPreference() {
  try { if (rememberAccount.value) localStorage.setItem(rememberKey, form.username.trim()); else localStorage.removeItem(rememberKey) }
  catch { showToast('已登录，但浏览器未能保存账号偏好') }
}
function fill(role: 'staff' | 'admin') { form.username = role; form.password = DEFAULT_DEMO_PASSWORD; error.value = '' }
async function submit() {
  if (loading.value) return
  loading.value = true; error.value = ''
  try { await login(form.username, form.password); form.password = ''; saveAccountPreference(); showToast('已进入本机演示'); await router.replace('/') }
  catch (cause) { error.value = cause instanceof Error ? cause.message : '演示登录未完成，请重试'; form.password = '' }
  finally { loading.value = false }
}
</script>

<template>
  <div class="page demo-auth-page">
    <div class="page-heading"><div><h1>员工演示入口</h1><p class="heading-note">只进入本机演示，不连接门店后台</p></div></div>
    <van-notice-bar wrapable :scrollable="false" text="这是模拟登录。请勿输入真实账号或真实密码；测试账号与演示数据保存在当前浏览器。" />
    <p class="demo-account-hint">初始账号：staff（员工）/ admin（管理员）<br>专用演示密码：{{ DEFAULT_DEMO_PASSWORD }}<br>已改过演示密码或停用账号时，以本机当前记录为准。</p>
    <div class="demo-credential-actions"><van-button plain size="small" @click="fill('staff')">填入员工凭据</van-button><van-button plain size="small" @click="fill('admin')">填入管理员凭据</van-button></div>
    <van-form @submit="submit"><van-cell-group inset><van-field v-model="form.username" name="username" label="演示账号" label-align="top" maxlength="64" clearable autocomplete="off" placeholder="输入演示账号" :rules="[{ required: true, message: '请填写演示账号' }]" /><van-field v-model="form.password" name="password" label="演示密码" label-align="top" :type="passwordVisible ? 'text' : 'password'" maxlength="256" autocomplete="off" placeholder="仅填写专用演示密码" :rules="[{ required: true, message: '请填写演示密码' }]"><template #right-icon><van-button class="demo-password-toggle" :icon="passwordVisible ? 'closed-eye' : 'eye-o'" :aria-label="passwordVisible ? '隐藏演示密码' : '显示演示密码'" :aria-pressed="passwordVisible" @click="passwordVisible = !passwordVisible" /></template></van-field></van-cell-group><VanCheckbox v-model="rememberAccount" class="demo-remember-account">记住演示账号（不保存密码）</VanCheckbox><p v-if="error" class="demo-form-error" role="alert">{{ error }}</p><van-button block type="primary" native-type="submit" :loading="loading">进入演示</van-button></van-form>
    <div class="demo-module-section"><van-button v-if="session.signedIn" plain block to="/">继续当前演示</van-button><van-button plain block to="/drinks" class="demo-module-section">只看公开酒水单</van-button></div>
    <p class="section-caption">本机密码摘要只用于模拟流程，不能作为正式账号认证。忘记测试口令时，可从演示身份切换入口进入管理员，在设置中重置本机演示。</p>
  </div>
</template>
