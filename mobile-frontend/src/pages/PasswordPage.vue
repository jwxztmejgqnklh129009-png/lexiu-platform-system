<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import { currentAccount, changePassword } from '../stores/accounts'
import '../settings.css'
const router = useRouter()
const form = reactive({ current: '', next: '', confirm: '' })
const showCurrent = ref(false)
const showNext = ref(false)
const loading = ref(false)
const error = ref('')
async function submit() {
  if (loading.value) return
  if (form.next !== form.confirm) { error.value = '两次输入的新演示密码不一致'; return }
  error.value = ''; loading.value = true
  try {
    await changePassword(form.current, form.next)
    Object.assign(form, { current: '', next: '', confirm: '' })
    showToast('演示密码已修改，请重新登录')
    await router.replace('/login')
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '演示改密未完成，请重试'; form.current = '' }
  finally { loading.value = false }
}
</script>

<template>
  <div v-if="currentAccount" class="page demo-auth-page">
    <div class="page-heading"><div><h1>修改演示密码</h1><p class="heading-note">当前演示账号：{{ currentAccount.username }}</p></div></div>
    <van-notice-bar wrapable :scrollable="false" text="只测试改密流程，请勿使用任何真实密码。新演示密码只在当前浏览器生效，成功后需重新登录。" />
    <p class="demo-account-hint">新演示密码6–200位，请记住自己设置的测试口令。例如 Demo5678!；未修改过的初始演示密码是 Demo1234!。</p>
    <van-form class="demo-module-section" @submit="submit"><van-cell-group inset>
      <van-field v-model="form.current" name="current" label="当前演示密码" label-align="top" :type="showCurrent ? 'text' : 'password'" maxlength="256" autocomplete="off" :rules="[{ required: true, message: '请填写当前演示密码' }]"><template #right-icon><van-button class="demo-password-toggle" :icon="showCurrent ? 'closed-eye' : 'eye-o'" :aria-label="showCurrent ? '隐藏当前密码' : '显示当前密码'" :aria-pressed="showCurrent" @click="showCurrent = !showCurrent" /></template></van-field>
      <van-field v-model="form.next" name="next" label="新演示密码" label-align="top" :type="showNext ? 'text' : 'password'" maxlength="200" autocomplete="off" :rules="[{ required: true, message: '请填写新演示密码' }, { validator: value => String(value).length >= 6, message: '新演示密码至少6位' }]"><template #right-icon><van-button class="demo-password-toggle" :icon="showNext ? 'closed-eye' : 'eye-o'" :aria-label="showNext ? '隐藏新密码' : '显示新密码'" :aria-pressed="showNext" @click="showNext = !showNext" /></template></van-field>
      <van-field v-model="form.confirm" name="confirm" label="再次输入新密码" label-align="top" :type="showNext ? 'text' : 'password'" maxlength="200" autocomplete="off" :rules="[{ required: true, message: '请再次输入新演示密码' }, { validator: value => value === form.next, message: '两次输入的新演示密码不一致' }]" />
    </van-cell-group><p v-if="error" class="demo-form-error" role="alert">{{ error }}</p><van-button block type="primary" native-type="submit" :loading="loading">修改并重新登录</van-button><van-button plain block to="/me" class="demo-module-section" :disabled="loading">取消，返回我的</van-button></van-form>
  </div>
  <div v-else class="page"><van-empty description="请先进入演示账号"><van-button type="primary" to="/login">前往演示登录</van-button></van-empty></div>
</template>
