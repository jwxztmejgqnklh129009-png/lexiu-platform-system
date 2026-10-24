<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { reviews, resolveReview } from '../reviews'
import MediaGallery from '../components/MediaGallery.vue'
const route = useRoute()
const router = useRouter()
const item = computed(() => reviews.value.find(row => row.id === String(route.params.id)))
const rejectPopup = ref(false)
const reason = ref('')
const error = ref('')
const busy = ref(false)
async function handle(action: 'approve' | 'reject') {
  if (!item.value || busy.value) return
  error.value = ''
  if (action === 'reject' && !reason.value.trim()) { error.value = '请填写具体的退回原因。'; return }
  const target = item.value.id
  if (action === 'approve') {
    try { await showConfirmDialog({ title: '通过这项申请？', message: `“${item.value.title}”通过后会更新本机演示资料。`, confirmButtonText: '确认通过' }) } catch { return }
  }
  busy.value = true
  try {
    resolveReview(target, action, reason.value)
    rejectPopup.value = false
    await router.replace('/reviews')
    showToast({ message: action === 'approve' ? '演示申请已通过' : '演示申请已退回', icon: 'success' })
  } catch (err) { error.value = err instanceof Error ? err.message : '处理失败，请重试。' }
  finally { busy.value = false }
}
</script>
<template>
  <div v-if="item" class="page review-detail">
    <div class="item-intro"><van-tag type="warning" plain>待审核</van-tag><h1>{{ item.title }}</h1><p>{{ item.kindLabel }} · {{ item.sub }}</p></div>
    <section class="section"><div class="section-heading"><h2>提交信息</h2></div><van-cell-group inset><van-cell title="提交人" :value="item.by" /><van-cell title="提交时间" :value="item.at" /><van-cell title="申请内容" :label="item.description" /><van-cell v-for="field in item.fields" :key="field.label" :title="field.label" :label="field.value" /></van-cell-group></section>
    <section v-if="item.files?.length" class="section"><div class="section-heading"><h2>本次提交的附件</h2></div><media-gallery :files="item.files" /></section>
    <van-cell-group inset class="secondary-wide"><van-cell title="查看关联资料" label="对照当前生效内容与申请" icon="description-o" is-link :to="item.sourcePath" /></van-cell-group>
    <van-notice-bar wrapable :scrollable="false" text="审核只影响本机演示记录。图片或字段修改通过前，原生效内容继续保留。" />
    <p v-if="error && !rejectPopup" class="inline-error" role="alert">{{ error }}</p>
    <div class="review-actions"><van-button plain block :disabled="busy" @click="reason = ''; error = ''; rejectPopup = true">退回</van-button><van-button type="primary" block :loading="busy" @click="handle('approve')">通过申请</van-button></div>
    <van-popup v-model:show="rejectPopup" position="bottom" round closeable safe-area-inset-bottom :close-on-click-overlay="false" class="move-popup"><h2 class="popup-title">退回申请</h2><p class="popup-subtitle">说明需要修改的地方，方便员工重新提交。</p><van-form @submit="handle('reject')"><van-cell-group inset><van-field v-model="reason" required label="退回原因" type="textarea" placeholder="请填写具体原因" maxlength="200" rows="3" show-word-limit :error-message="error" /></van-cell-group><div class="popup-actions"><van-button plain block native-type="button" @click="rejectPopup = false">取消</van-button><van-button type="primary" block native-type="submit" :loading="busy">确认退回</van-button></div></van-form></van-popup>
  </div>
  <van-empty v-else description="这项申请已处理或不存在"><van-button to="/reviews" type="primary">返回审核列表</van-button></van-empty>
</template>
