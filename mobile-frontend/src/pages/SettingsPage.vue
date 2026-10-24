<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { session } from '../session'
import { activeAccounts, createAccount, deleteAccount, deletionReason, DEFAULT_DEMO_PASSWORD, type DemoAccount, type AccountRole } from '../stores/accounts'
import { downloadLedger } from '../export'
import { resetDemo } from '../reset'
import '../settings.css'

const router = useRouter()
const canManage = computed(() => session.signedIn && session.role === 'admin')
const creatorOpen = ref(false)
const saving = ref(false)
const resetting = ref(false)
const showPassword = ref(false)
const error = ref('')
const createdMessage = ref('')
const form = reactive({ username: '', name: '', role: 'staff' as AccountRole, password: '' })
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请重试'

function openCreator() {
  Object.assign(form, { username: '', name: '', role: 'staff', password: '' })
  error.value = ''; showPassword.value = false; creatorOpen.value = true
}

async function submitAccount() {
  if (saving.value) return
  error.value = ''; saving.value = true
  try {
    const result = await createAccount({ ...form })
    createdMessage.value = `${result.reused ? '已恢复' : '已创建'}演示账号「${result.account.username}」。${result.usedDefaultPassword ? `专用演示密码：${DEFAULT_DEMO_PASSWORD}` : '登录请使用刚刚填写的专用演示密码。'}`
    form.password = ''; creatorOpen.value = false; showToast(result.reused ? '演示账号已恢复' : '演示账号已创建')
  } catch (cause) { error.value = errorText(cause) }
  finally { saving.value = false }
}

async function removeAccount(account: DemoAccount) {
  const reason = deletionReason(account)
  if (reason) { showToast(reason); return }
  try { await showConfirmDialog({ title: '删除演示账号？', message: `「${account.username}」将被停用。以后用相同账号名新建，可恢复此演示账号。`, confirmButtonText: '确认删除', confirmButtonColor: 'var(--error-text)' }) }
  catch { return }
  try { deleteAccount(account.id); showToast('演示账号已停用') }
  catch (cause) { showToast(errorText(cause)) }
}

function exportText() {
  try { downloadLedger() } catch (cause) { showToast(errorText(cause)) }
}
async function resetLocalDemo() {
  try { await showConfirmDialog({ title: '重置本机演示？', message: '将清除当前浏览器里的演示记录与上传附件，恢复初始演示数据。显示模式会保留。此操作不能撤回，请先导出需要保留的文字台账。', confirmButtonText: '确认重置', confirmButtonColor: 'var(--error-text)' }) }
  catch { return }
  resetting.value = true
  try { await resetDemo(); showToast('本机演示已重置'); await router.replace('/') }
  catch (cause) { showToast(errorText(cause)) }
  finally { resetting.value = false }
}
</script>

<template>
  <div v-if="canManage" class="page settings-page">
    <div class="page-heading"><div><h1>账号与设置</h1><p class="heading-note">本机演示 · 管理员</p></div></div>
    <section class="section"><div class="section-heading"><h2>我的账号</h2></div><van-cell-group inset><van-cell :title="session.name" :label="`当前演示身份：${session.role === 'admin' ? '管理员' : '员工'}`" icon="user-circle-o" /><van-cell title="修改演示密码" label="仅模拟改密，完成后重新登录" icon="lock" is-link to="/password" /></van-cell-group></section>
    <section class="section"><div class="section-heading"><h2>账号管理 <span class="muted">{{ activeAccounts.length }}</span></h2><van-button plain size="small" icon="plus" @click="openCreator">新建账号</van-button></div>
      <p class="section-caption">只创建测试账号，请勿填写真实姓名或真实密码。</p>
      <p v-if="createdMessage" class="demo-account-success" role="status">{{ createdMessage }}</p>
      <van-cell-group v-for="account in activeAccounts" :key="account.id" inset class="demo-account-group"><van-cell><template #title>{{ account.name }} <van-tag v-if="account.id === session.accountId" plain>当前</van-tag></template><template #label><p>{{ account.username }} · {{ account.role === 'admin' ? '管理员' : '普通员工' }}</p><p>最后演示登录：{{ account.lastLogin || '尚无记录' }}</p><p v-if="deletionReason(account)">{{ deletionReason(account) }}</p></template><template #value><van-button plain size="small" class="demo-danger" :disabled="!!deletionReason(account)" :aria-label="`删除演示账号${account.username}`" @click="removeAccount(account)">删除</van-button></template></van-cell></van-cell-group>
    </section>
    <section class="section"><div class="section-heading"><h2>本机数据</h2></div><van-cell-group inset><van-cell title="下载演示文字台账" label="仅文字记录，不含图片、附件和密码" icon="down" is-link @click="exportText" /><van-cell title="重置本机演示" label="清除演示改动与上传附件，恢复初始数据" icon="replay" is-link :clickable="!resetting" @click="!resetting && resetLocalDemo()" /></van-cell-group><p class="section-caption">文字台账不能完整还原系统，也不是图片备份。本演示不连接门店后台，清除浏览器数据也会丢失本机记录。</p></section>
    <van-popup v-model:show="creatorOpen" position="bottom" round closeable safe-area-inset-bottom class="demo-form-popup" :close-on-click-overlay="false" @closed="form.password = ''">
      <h2>新建演示账号</h2><p class="section-caption">请使用测试信息。不要输入正在使用的真实密码。</p>
      <van-form @submit="submitAccount"><van-cell-group inset class="demo-form-fields"><van-field v-model="form.username" name="username" label="登录账号" label-align="top" required maxlength="60" placeholder="最多60字" autocomplete="off" :rules="[{ required: true, message: '请填写登录账号' }, { validator: value => !!String(value).trim(), message: '账号不能只填空格' }]" /><van-field v-model="form.name" name="name" label="演示姓名" label-align="top" maxlength="60" placeholder="可留空，默认显示账号" autocomplete="off" /><van-field name="role" label="角色" label-align="top"><template #input><van-radio-group v-model="form.role" direction="horizontal"><van-radio name="staff">普通员工</van-radio><van-radio name="admin">管理员</van-radio></van-radio-group></template></van-field><van-field v-model="form.password" name="password" label="专用演示密码" label-align="top" :type="showPassword ? 'text' : 'password'" maxlength="200" :placeholder="`留空则使用 ${DEFAULT_DEMO_PASSWORD}`" autocomplete="off" :rules="[{ validator: value => !value || String(value).length >= 6, message: '演示密码至少6位' }]"><template #right-icon><van-button class="demo-password-toggle" :icon="showPassword ? 'closed-eye' : 'eye-o'" :aria-label="showPassword ? '隐藏演示密码' : '显示演示密码'" :aria-pressed="showPassword" @click="showPassword = !showPassword" /></template></van-field></van-cell-group><p class="section-caption">留空会使用公开的专用演示口令，并非随机生成的正式账号密码。</p><p v-if="error" class="demo-form-error" role="alert">{{ error }}</p><div class="demo-form-actions"><van-button block :disabled="saving" @click="creatorOpen = false">取消</van-button><van-button block type="primary" native-type="submit" :loading="saving">创建演示账号</van-button></div></van-form>
    </van-popup>
  </div>
  <div v-else class="page"><van-empty description="账号与设置仅供演示管理员使用"><van-button to="/me" type="primary">返回我的</van-button></van-empty></div>
</template>
