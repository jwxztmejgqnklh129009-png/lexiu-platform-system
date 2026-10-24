<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { session } from '../session'
import { findRecord, expiryOf, visibleVersions, currentVersion, visibleRecordEdits, versionOpenable, recordStatusText, addRecordVersion, deleteRecord, recordFieldLabels, formatRecordField, type RecordFields } from '../stores/records'
import DemoUpload from '../components/DemoUpload.vue'
import MediaGallery from '../components/MediaGallery.vue'
import { pendingMediaWrites, type MediaRef } from '../media'

const route = useRoute(); const router = useRouter()
const record = computed(() => { const row = findRecord(String(route.params.id)); return row?.scope === route.params.kind ? row : undefined })
const versions = computed(() => record.value ? visibleVersions(record.value.id) : [])
const current = computed(() => record.value ? currentVersion(record.value.id) : undefined)
const edits = computed(() => record.value ? visibleRecordEdits(record.value.id) : [])
const showUpload = ref(false); const files = ref<MediaRef[]>([]); const changeNote = ref(''); const error = ref(''); const saving = ref(false)
watch(() => route.params.id, () => { showUpload.value = false; files.value = []; changeNote.value = ''; error.value = '' })
function openUpload() { files.value = []; changeNote.value = ''; error.value = ''; showUpload.value = true }
async function saveVersion() {
  if (saving.value) return
  if (pendingMediaWrites.value > 0) { error.value = '附件正在保存到本机，请完成后再提交'; return }
  error.value = ''; saving.value = true
  try {
    if (!record.value || !files.value[0]) throw new Error('请先选择一个附件')
    addRecordVersion(record.value.id, files.value[0], changeNote.value)
    files.value = []; showUpload.value = false
    showToast(session.role === 'admin' ? '新版本已生效，原版本保留为历史' : '附件已提交，生效版本暂不改变')
  } catch (e) { error.value = e instanceof Error ? e.message : '提交失败，请重试' }
  finally { saving.value = false }
}
async function closeUpload() {
  if (pendingMediaWrites.value > 0 || saving.value) return
  if (files.value.length || changeNote.value) {
    try { await showConfirmDialog({ title: '放弃本次附件提交？', message: '尚未提交的附件选择和说明不会保存。', confirmButtonText: '放弃提交', cancelButtonText: '继续填写' }) } catch { return }
  }
  files.value = []; changeNote.value = ''; showUpload.value = false
}
async function remove() {
  if (!record.value) return
  try { await showConfirmDialog({ title: '删除这份资料？', message: '本地资料、附件版本记录和修改申请将一并删除。', confirmButtonText: '确认删除', confirmButtonColor: 'var(--error-text)' }) } catch { return }
  try { const scope = record.value.scope; deleteRecord(record.value.id); showToast('资料已删除'); await router.replace(`/records/${scope}`) }
  catch (e) { showToast(e instanceof Error ? e.message : '删除失败') }
}
onBeforeRouteLeave(async () => {
  if (pendingMediaWrites.value > 0 || saving.value) return false
  if (!showUpload.value || (!files.value.length && !changeNote.value)) return true
  try { await showConfirmDialog({ title: '离开附件提交？', message: '尚未提交的附件选择和说明不会保存。', confirmButtonText: '离开', cancelButtonText: '继续填写' }); return true } catch { return false }
})
</script>

<template>
  <div v-if="record" class="page record-detail">
    <div class="item-intro"><van-tag plain>{{ record.category }}</van-tag><h1>{{ record.name }}</h1><p>{{ record.cert_no || '未填写证件编号' }}</p><div class="status-row"><van-tag plain :type="record.flow_status === 'approved' ? 'success' : record.flow_status === 'pending' ? 'warning' : 'danger'">{{ recordStatusText(record.flow_status) }}</van-tag><span :class="{ 'record-warning': ['expired', 'warning'].includes(expiryOf(record).level) }">{{ expiryOf(record).label }}</span></div></div>
    <van-notice-bar v-if="record.reject_reason" wrapable :scrollable="false" :text="`退回原因：${record.reject_reason}`" />
    <div class="page-actions"><van-button plain type="primary" :to="`/records/${record.scope}/${record.id}/edit`" icon="edit">编辑资料</van-button><van-button type="primary" icon="plus" @click="openUpload">上传新版本</van-button></div>
    <section class="section"><div class="section-heading"><h2>资料信息</h2></div><van-cell-group inset>
      <van-cell v-if="record.scope === 'employee'" title="员工姓名" :value="record.holder" />
      <van-cell v-if="record.cert_type" title="证件类型" :value="record.cert_type" />
      <van-cell title="签发单位" :value="record.issuer || '未填写'" />
      <van-cell v-if="record.scope === 'company'" title="持有人" :value="record.holder || '未填写'" />
      <van-cell v-if="record.scope === 'company'" title="保管人" :value="record.keeper || '未填写'" />
      <van-cell title="签发日期" :value="record.issue_date || '未填写'" />
      <van-cell title="有效期至" :value="record.expiry_mode === 'date' ? record.expiry_date : formatRecordField('expiry_mode', record.expiry_mode)" />
      <van-cell title="提醒天数（原字段）" :value="`${record.remind_days}天`" label="当前提醒仍采用原项目15天档位" />
      <van-cell title="纸质存放位置" :value="record.paper_location || '未填写'" />
      <van-cell title="备注" :label="record.note || '未填写'" />
      <van-cell title="提交人" :value="record.created_name" :label="record.created_at" />
    </van-cell-group></section>
    <section class="section file-section"><div class="section-heading"><h2>{{ current?.status === 'approved' ? '当前生效附件' : '当前可见附件' }}</h2><span v-if="current" class="muted">v{{ current.version_no }} · {{ recordStatusText(current.status) }}</span></div><MediaGallery v-if="current && versionOpenable(current)" :files="[current.file]" /><van-empty v-else :description="current?.status === 'rejected' ? '退回附件当前不可打开，请重新提交' : '尚无附件，可上传首个版本'" image-size="88" /></section>
    <section class="section"><div class="section-heading"><h2>附件版本</h2><span class="muted">{{ versions.length }} 个可见版本</span></div>
      <van-cell-group v-if="versions.length" inset><div v-for="v in versions" :key="v.id" class="record-version"><van-cell :title="`v${v.version_no} · ${v.file.name}`" :label="`${v.uploaded_name} · ${v.uploaded_at}${v.change_note ? '\n' + v.change_note : ''}`"><template #value><van-tag plain :type="v.status === 'approved' ? 'success' : v.status === 'pending' ? 'warning' : v.status === 'rejected' ? 'danger' : 'default'">{{ recordStatusText(v.status) }}</van-tag></template></van-cell><p v-if="v.reject_reason" class="record-reason">退回原因：{{ v.reject_reason }}</p><MediaGallery v-if="versionOpenable(v)" :files="[v.file]" compact /><p v-else class="section-caption">已退回附件仅管理员可打开。</p></div></van-cell-group><p v-else class="quiet-empty">还没有附件版本。</p>
    </section>
    <section v-if="edits.length" class="section"><div class="section-heading"><h2>{{ session.role === 'admin' ? '字段修改申请' : '我的修改申请' }}</h2></div><van-cell-group inset><div v-for="e in edits" :key="e.id"><van-cell title="资料修改" :label="`${e.by_name} · ${e.at}`"><template #value><van-tag plain :type="e.status === 'pending' ? 'warning' : e.status === 'rejected' ? 'danger' : 'success'">{{ recordStatusText(e.status) }}</van-tag></template></van-cell><dl class="record-changes"><template v-for="(value, key) in e.patch" :key="key"><dt>{{ recordFieldLabels[key as keyof RecordFields] }}</dt><dd>{{ formatRecordField(key, e.base[key as keyof RecordFields]) }} → {{ formatRecordField(key, value) }}</dd></template></dl><p v-if="e.reason" class="record-reason">退回原因：{{ e.reason }}</p></div></van-cell-group></section>
    <div v-if="session.role === 'admin'" class="page-actions"><van-button plain type="primary" to="/reviews">查看审核队列</van-button><van-button plain type="danger" icon="delete-o" @click="remove">删除资料</van-button></div>
    <van-popup v-model:show="showUpload" position="bottom" round safe-area-inset-bottom :close-on-click-overlay="false" :before-close="() => pendingMediaWrites === 0 && !saving" class="record-upload-popup"><h2 class="popup-title">上传新附件版本</h2><p class="popup-subtitle">{{ session.role === 'admin' ? '提交后直接生效，原附件保留历史。' : '管理员审核前，原生效附件仍可查看。' }}</p><DemoUpload v-model="files" accept=".jpg,.jpeg,.png,.pdf,.doc,.docx,.xls,.xlsx" :max-count="1" :disabled="saving || pendingMediaWrites > 0" label="选择新版本附件" /><van-field v-model="changeNote" label="版本说明" type="textarea" rows="2" maxlength="500" show-word-limit placeholder="选填，例如更新后的证件" /><p v-if="error" class="inline-error" role="alert">{{ error }}</p><div class="popup-actions"><van-button block plain :disabled="saving || pendingMediaWrites > 0" @click="closeUpload">取消</van-button><van-button block type="primary" :loading="saving" :disabled="!files.length || pendingMediaWrites > 0" @click="saveVersion">{{ session.role === 'admin' ? '保存并生效' : '提交审核' }}</van-button></div></van-popup>
  </div>
  <van-empty v-else description="资料不存在或当前账户无权查看"><van-button :to="`/records/${route.params.kind === 'employee' ? 'employee' : 'company'}`" type="primary">返回列表</van-button></van-empty>
</template>

<style scoped>
.record-warning { color: var(--warning-text); }
.record-version + .record-version { border-top: 1px solid var(--line); }
.record-version :deep(.van-cell__label) { white-space: pre-line; }
.record-upload-popup { max-height: 85dvh; overflow: auto; padding: 20px 16px; }
.record-reason { color: var(--error-text); margin: 0; padding: 8px 16px 16px; overflow-wrap: anywhere; }
.record-changes { margin: 0; padding: 0 16px 12px; font-size: 14px; overflow-wrap: anywhere; }
.record-changes dt { color: var(--muted); margin-top: 8px; }
.record-changes dd { margin: 2px 0 0; }
</style>
