<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { session } from '../session'
import { fireDirectory, approvedFirePhotos, visibleFirePhotos, visibleFireOrders, firePhotoOpenable, fireStatusText, uploadFirePhotos, submitFireOrder, deleteFirePhoto, type FirePhoto } from '../stores/fire'
import DemoUpload from '../components/DemoUpload.vue'
import MediaGallery from '../components/MediaGallery.vue'
import MediaThumb from '../components/MediaThumb.vue'
import { pendingMediaWrites, type MediaRef } from '../media'

const route = useRoute()
const code = computed(() => String(route.params.code || ''))
const directory = computed(() => fireDirectory(code.value))
const current = computed(() => approvedFirePhotos(code.value))
const submitted = computed(() => visibleFirePhotos(code.value).filter(p => p.status !== 'approved').slice().reverse())
const orders = computed(() => visibleFireOrders(code.value))
const tab = ref('current'); const sorting = ref(false); const base = ref<string[]>([]); const target = ref<string[]>([])
const sorted = computed(() => target.value.map(id => current.value.find(p => p.id === id)).filter((p): p is FirePhoto => !!p))
const orderChanged = computed(() => JSON.stringify(base.value) !== JSON.stringify(target.value))
const uploadShow = ref(false); const replaceId = ref<string>(); const files = ref<MediaRef[]>([]); const uploading = ref(false); const error = ref(''); const sortError = ref('')
watch(code, () => { sorting.value = false; uploadShow.value = false; files.value = []; error.value = ''; sortError.value = ''; tab.value = 'current' })
function openUpload(id?: string) { replaceId.value = id; files.value = []; error.value = ''; uploadShow.value = true }
async function commitUpload() {
  if (uploading.value) return
  if (pendingMediaWrites.value > 0) { error.value = '照片正在保存到本机，请完成后再提交'; return }
  uploading.value = true; error.value = ''
  try {
    await uploadFirePhotos(code.value, files.value, replaceId.value)
    files.value = []; uploadShow.value = false
    tab.value = session.role === 'admin' ? 'current' : 'submitted'
    showToast(session.role === 'admin' ? '照片已生效' : '照片已提交，等待管理员审核')
  } catch (e) { error.value = e instanceof Error ? e.message : '提交失败，请重试' }
  finally { uploading.value = false }
}
async function closeUpload() {
  if (uploading.value || pendingMediaWrites.value > 0) return
  if (files.value.length) {
    try { await showConfirmDialog({ title: '放弃本次照片提交？', message: '已选择但未提交的照片不会加入档案。', confirmButtonText: '放弃提交', cancelButtonText: '继续选择' }) } catch { return }
  }
  files.value = []; uploadShow.value = false
}
function startSort() { base.value = current.value.map(p => p.id); target.value = [...base.value]; sorting.value = true; sortError.value = '' }
function move(index: number, delta: number) { const list = [...target.value]; const next = index + delta; if (next < 0 || next >= list.length) return; [list[index], list[next]] = [list[next]!, list[index]!]; target.value = list }
async function cancelSort() {
  if (orderChanged.value) {
    try { await showConfirmDialog({ title: '放弃排序调整？', message: '尚未提交的顺序不会保存。', confirmButtonText: '放弃调整', cancelButtonText: '继续调整' }) } catch { return }
  }
  sorting.value = false; sortError.value = ''
}
function saveSort() {
  sortError.value = ''
  try { submitFireOrder(code.value, base.value, target.value); sorting.value = false; showToast(session.role === 'admin' ? '照片顺序已更新' : '排序申请已提交，生效顺序暂不改变') }
  catch (e) { sortError.value = e instanceof Error ? e.message : '提交失败，请重试' }
}
async function remove(p: FirePhoto) {
  try { await showConfirmDialog({ title: '删除这张照片？', message: '目录中的照片记录将删除；针对它的待审替换会一并退回。', confirmButtonText: '确认删除', confirmButtonColor: 'var(--error-text)' }) } catch { return }
  try { deleteFirePhoto(p.id); showToast('照片已删除') } catch (e) { showToast(e instanceof Error ? e.message : '删除失败') }
}
function photoName(id: string) { return visibleFirePhotos(code.value).find(p => p.id === id)?.file.name || '照片已移除或无权查看' }
onBeforeRouteLeave(async () => {
  if (pendingMediaWrites.value > 0 || uploading.value) return false
  if ((!sorting.value || !orderChanged.value) && (!uploadShow.value || !files.value.length)) return true
  try { await showConfirmDialog({ title: '离开当前目录？', message: '尚未提交的上传或排序调整不会保存。', confirmButtonText: '离开', cancelButtonText: '继续操作' }); return true } catch { return false }
})
</script>

<template>
  <div v-if="directory" class="page fire-directory"><div class="item-intro"><van-tag plain>{{ code }}</van-tag><h1>{{ directory.name }}</h1><p>{{ current.length }} 张生效照片 · {{ session.role === 'admin' ? '管理员直接生效' : '员工提交后须审核' }}</p></div>
    <div v-if="!sorting" class="page-actions"><van-button type="primary" icon="plus" @click="openUpload()">上传照片</van-button><van-button plain type="primary" icon="sort" :disabled="current.length < 2" @click="startSort">调整顺序</van-button><van-button plain icon="description-o" :to="`/fire/print?scope=${code}`">打印目录</van-button></div>
    <template v-if="sorting"><van-notice-bar :scrollable="false" wrapable text="按上下按钮调整照片顺序，保存时会核对目录是否发生变化。" /><van-cell-group inset><van-cell v-for="(p, index) in sorted" :key="p.id" :title="`${index + 1}. ${p.file.name}`" class="fire-sort-cell"><template #icon><MediaThumb :file="p.file" :size="56" /></template><template #label><div class="fire-sort-actions"><van-button plain size="small" icon="arrow-up" :disabled="index === 0" :aria-label="`将第${index + 1}张照片上移`" @click="move(index, -1)">上移</van-button><van-button plain size="small" icon="arrow-down" :disabled="index === sorted.length - 1" :aria-label="`将第${index + 1}张照片下移`" @click="move(index, 1)">下移</van-button></div></template></van-cell></van-cell-group><p v-if="sortError" class="inline-error" role="alert">{{ sortError }}</p><div class="page-actions"><van-button plain @click="cancelSort">取消调整</van-button><van-button type="primary" :disabled="!orderChanged" @click="saveSort">{{ session.role === 'admin' ? '保存顺序' : '提交排序审核' }}</van-button></div></template>
    <van-tabs v-else v-model:active="tab"><van-tab title="生效照片" name="current"><van-empty v-if="!current.length" description="本目录还没有生效照片" image-size="100"><van-button plain type="primary" @click="openUpload()">上传首张照片</van-button></van-empty><van-cell-group v-else inset><div v-for="(p, index) in current" :key="p.id" class="fire-photo-row"><van-cell :title="`${index + 1}. ${p.file.name}`" :label="`${p.uploaded_name} · ${p.uploaded_at}`"><template #value><van-tag plain type="success">已生效</van-tag></template></van-cell><MediaGallery :files="[p.file]" /><div class="fire-photo-actions"><van-button plain size="small" type="primary" @click="openUpload(p.id)">上传替换图</van-button><van-button v-if="session.role === 'admin'" plain size="small" type="danger" icon="delete-o" @click="remove(p)">删除</van-button></div></div></van-cell-group></van-tab>
      <van-tab :title="session.role === 'admin' ? '提交与历史' : '我的提交'" name="submitted"><p class="section-caption">{{ session.role === 'admin' ? '含待审、退回与已替换照片。' : '这里只显示本人待审和退回照片。已退回照片不提供打开入口。' }}</p><van-cell-group v-if="submitted.length" inset><div v-for="p in submitted" :key="p.id" class="fire-photo-row"><van-cell :title="p.file.name" :label="`${p.replaces_id ? '替换申请' : '新增照片'} · ${p.uploaded_name} · ${p.uploaded_at}`"><template #value><van-tag plain :type="p.status === 'pending' ? 'warning' : p.status === 'rejected' ? 'danger' : 'default'">{{ fireStatusText(p.status) }}</van-tag></template></van-cell><p v-if="p.reason" class="fire-reason">退回原因：{{ p.reason }}</p><MediaGallery v-if="firePhotoOpenable(p)" :files="[p.file]" /><div v-if="session.role === 'admin'" class="fire-photo-actions"><van-button v-if="p.status === 'pending'" size="small" type="primary" plain to="/reviews">去审核</van-button><van-button size="small" type="danger" plain icon="delete-o" @click="remove(p)">删除</van-button></div><div v-else-if="p.status === 'rejected'" class="fire-photo-actions"><van-button size="small" type="primary" plain @click="openUpload()">重新选择照片上传</van-button></div></div></van-cell-group><van-empty v-else description="暂无可见提交记录" image-size="100" /></van-tab>
      <van-tab title="排序申请" name="orders"><van-cell-group v-if="orders.length" inset><div v-for="o in orders" :key="o.id" class="fire-photo-row"><van-cell title="照片顺序调整" :label="`${o.by_name} · ${o.at}`"><template #value><van-tag plain :type="o.status === 'pending' ? 'warning' : o.status === 'rejected' ? 'danger' : 'success'">{{ fireStatusText(o.status) }}</van-tag></template></van-cell><ol class="fire-order-preview"><li v-for="id in o.target" :key="id">{{ photoName(id) }}</li></ol><p v-if="o.reason" class="fire-reason">退回原因：{{ o.reason }}</p><div v-if="session.role === 'admin' && o.status === 'pending'" class="fire-photo-actions"><van-button plain size="small" type="primary" to="/reviews">去审核排序</van-button></div></div></van-cell-group><van-empty v-else description="暂无可见排序申请" image-size="100" /></van-tab>
    </van-tabs>
    <van-popup v-model:show="uploadShow" position="bottom" round safe-area-inset-bottom :close-on-click-overlay="false" :before-close="() => pendingMediaWrites === 0 && !uploading" class="fire-upload-popup"><h2 class="popup-title">{{ replaceId ? '上传替换照片' : '向目录上传照片' }}</h2><p class="popup-subtitle">{{ replaceId ? (session.role === 'admin' ? '提交后替换现图，旧图保留为历史。' : '审核通过前，原照片继续生效。') : '每批最多10张，按选择顺序加入目录。' }}</p><DemoUpload v-model="files" accept=".jpg,.jpeg,.png" :max-count="replaceId ? 1 : 10" :disabled="uploading || pendingMediaWrites > 0" :max-pixels="60_000_000" :max-size="15 * 1024 * 1024" label="选择消防档案照片" /><p class="section-caption">仅 JPG/PNG，每张不超过15MB、6000万像素。请使用清晰完整的档案照片。</p><p v-if="error" class="inline-error" role="alert">{{ error }}</p><div class="popup-actions"><van-button block plain :disabled="uploading || pendingMediaWrites > 0" @click="closeUpload">取消</van-button><van-button block type="primary" :loading="uploading" :disabled="!files.length || pendingMediaWrites > 0" @click="commitUpload">{{ session.role === 'admin' ? '保存并生效' : '提交审核' }}</van-button></div></van-popup>
  </div>
  <van-empty v-else description="消防目录不存在"><van-button to="/fire" type="primary">返回消防档案</van-button></van-empty>
</template>

<style scoped>
.fire-sort-cell :deep(.van-cell__left-icon), .fire-sort-cell :deep(.media-thumb) { margin-right: 12px; }
.fire-sort-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.fire-photo-row + .fire-photo-row { border-top: 1px solid var(--line); }
.fire-photo-actions { display: flex; flex-wrap: wrap; gap: 10px; padding: 0 16px 16px; }
.fire-reason { padding: 0 16px; color: var(--error-text); overflow-wrap: anywhere; }
.fire-order-preview { margin: 0; padding: 0 24px 16px 40px; color: var(--muted); overflow-wrap: anywhere; }
.fire-order-preview li + li { margin-top: 6px; }
.fire-upload-popup { padding: 20px 16px; max-height: 85dvh; overflow: auto; }
.fire-directory :deep(.van-tabs__content) { padding-top: 16px; }
</style>
