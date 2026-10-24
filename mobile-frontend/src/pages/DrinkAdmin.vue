<script setup lang="ts">
import { computed, ref } from 'vue'
import { showConfirmDialog, showToast } from 'vant'
import { session } from '../session'
import { storageProblem } from '../persistence'
import { deleteMedia, pendingMediaWrites, type MediaRef } from '../media'
import DemoUpload from '../components/DemoUpload.vue'
import MediaThumb from '../components/MediaThumb.vue'
import { drinkPages, drinkNote, saveDrinkPage, moveDrinkPage, deleteDrinkPage, saveDrinkNote } from '../stores/drinks'
import '../settings.css'

const canManage = computed(() => session.signedIn && session.role === 'admin')
const editorOpen = ref(false)
const editingId = ref<string>()
const draftTitle = ref('')
const draftFiles = ref<MediaRef[]>([])
const error = ref('')
const busy = ref(false)
const mediaBusy = computed(() => pendingMediaWrites.value > 0)
const noteOpen = ref(false)
const noteDraft = ref('')
const noteError = ref('')
const existing = computed(() => drinkPages.value.find(page => page.id === editingId.value))
const displayError = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成，请重试'

function editPage(id?: string) {
  editingId.value = id
  draftTitle.value = drinkPages.value.find(page => page.id === id)?.title || ''
  draftFiles.value = []
  error.value = ''
  editorOpen.value = true
}

async function removeUnusedImage(image?: MediaRef) {
  if (!image || storageProblem.value || image.id.startsWith('sample:') || drinkPages.value.some(page => page.image.id === image.id)) return
  await deleteMedia(image.id)
}

async function cleanDraft() {
  for (const image of draftFiles.value) {
    try { await removeUnusedImage(image) } catch { /* Full demo reset can clear unused media. */ }
  }
  draftFiles.value = []
}

async function submitPage() {
  if (busy.value) return
  if (mediaBusy.value) { error.value = '图片仍在保存到本机，请完成后再保存酒单'; return }
  error.value = ''; busy.value = true
  try {
    const oldImage = existing.value?.image
    saveDrinkPage({ id: editingId.value, title: draftTitle.value, image: draftFiles.value[0] })
    editorOpen.value = false
    showToast(editingId.value ? '演示酒单已更新' : '演示酒单已添加')
    try { await removeUnusedImage(oldImage) } catch { showToast('酒单已保存，旧图片本机清理未完成') }
  } catch (cause) { error.value = displayError(cause) }
  finally { busy.value = false }
}

function canCloseEditor() {
  if (mediaBusy.value || busy.value) { showToast('图片正在保存，请稍候再关闭'); return false }
  return true
}
function closeEditor() { if (canCloseEditor()) editorOpen.value = false }
function updateEditorShow(shown: boolean) { if (shown) editorOpen.value = true; else closeEditor() }

function move(id: string, direction: 'up' | 'down') {
  try { moveDrinkPage(id, direction) } catch (cause) { showToast(displayError(cause)) }
}

async function removePage(id: string) {
  const page = drinkPages.value.find(candidate => candidate.id === id)
  if (!page) return
  try { await showConfirmDialog({ title: '删除这一页？', message: `「${page.title || '未命名酒单'}」将从本机公开演示页移除。`, confirmButtonText: '确认删除', confirmButtonColor: 'var(--error-text)' }) }
  catch { return }
  try {
    deleteDrinkPage(id); showToast('演示酒单已删除')
    try { await removeUnusedImage(page.image) } catch { showToast('页面已删除，旧图片本机清理未完成') }
  } catch (cause) { showToast(displayError(cause)) }
}

function editNote() { noteDraft.value = drinkNote.value; noteError.value = ''; noteOpen.value = true }
function submitNote() {
  try { saveDrinkNote(noteDraft.value); noteOpen.value = false; showToast('公开说明已保存到本机') }
  catch (cause) { noteError.value = displayError(cause) }
}
</script>

<template>
  <div v-if="canManage" class="page drink-admin-page">
    <div class="page-heading"><div><h1>酒水单维护</h1><p class="heading-note">整页图片 · 本机公开演示</p></div></div>
    <van-notice-bar wrapable :scrollable="false" text="公开酒单只放售价，请勿上传成本、进货价或个人资料。本机演示不会发布到互联网。" />
    <section class="section demo-module-section"><van-cell-group inset><van-cell title="查看公开酒水单" label="无需登录；只浏览图片与说明" icon="photo-o" is-link to="/drinks" /><van-cell title="底部说明" :label="drinkNote || '暂不显示说明'" icon="description-o" is-link @click="editNote" /></van-cell-group></section>
    <section class="section">
      <div class="section-heading"><h2>酒单页面 <span class="muted">{{ drinkPages.length }}</span></h2><van-button plain size="small" icon="plus" @click="editPage()">上传一页</van-button></div>
      <p class="section-caption">新图排在最后。改价请替换整页图片，支持 JPG / PNG。</p>
      <van-empty v-if="!drinkPages.length" description="尚未上传演示酒单"><van-button type="primary" @click="editPage()">上传第一张图片</van-button></van-empty>
      <van-cell-group v-for="(page, index) in drinkPages" :key="page.id" inset class="drink-admin-group"><van-cell :title="page.title || '未命名酒单'" :label="`第 ${index + 1} 页\n${page.uploadedAt}`"><template #icon><MediaThumb :file="page.image" :size="76" class="drink-admin-thumb" /></template></van-cell><van-cell><template #title><div class="drink-admin-actions"><van-button plain size="small" @click="editPage(page.id)">标题 / 换图</van-button><van-button plain size="small" icon="arrow-up" :disabled="index === 0" :aria-label="`上移第${index + 1}页`" @click="move(page.id, 'up')" /><van-button plain size="small" icon="arrow-down" :disabled="index === drinkPages.length - 1" :aria-label="`下移第${index + 1}页`" @click="move(page.id, 'down')" /><van-button plain size="small" class="demo-danger" @click="removePage(page.id)">删除</van-button></div></template></van-cell></van-cell-group>
    </section>
    <van-popup :show="editorOpen" position="bottom" round :closeable="!mediaBusy && !busy" :before-close="canCloseEditor" safe-area-inset-bottom class="demo-form-popup" :close-on-click-overlay="false" @update:show="updateEditorShow" @closed="cleanDraft">
      <h2>{{ editingId ? '修改这一页酒单' : '上传新的一页' }}</h2><p class="section-caption">标题会出现在公开演示页，可留空。</p>
      <van-form @submit="submitPage"><van-cell-group inset class="demo-form-fields"><van-field v-model="draftTitle" label="公开标题" label-align="top" placeholder="例如：啤酒与软饮" clearable /></van-cell-group>
        <div v-if="existing" class="drink-current-image"><p class="muted">当前图片 · 不选新图则保留</p><MediaThumb :file="existing.image" :size="96" /></div>
        <DemoUpload v-model="draftFiles" accept="image/jpeg,image/png" :max-count="1" :disabled="busy" :label="editingId ? '选择替换图片（可选）' : '选择酒单图片（必填）'" />
        <p v-if="mediaBusy" class="section-caption" role="status">图片正在保存到本机，完成后才能确认或关闭。</p>
        <p v-if="error" class="demo-form-error" role="alert">{{ error }}</p><div class="demo-form-actions"><van-button block :disabled="busy || mediaBusy" @click="closeEditor">取消</van-button><van-button block type="primary" native-type="submit" :disabled="mediaBusy" :loading="busy">保存到本机</van-button></div>
      </van-form>
    </van-popup>
    <van-popup v-model:show="noteOpen" position="bottom" round closeable safe-area-inset-bottom class="demo-form-popup" :close-on-click-overlay="false"><h2>公开页底部说明</h2><van-form @submit="submitNote"><van-cell-group inset class="demo-form-fields"><van-field v-model="noteDraft" label="说明文字" label-align="top" type="textarea" :autosize="{ minHeight: 96 }" maxlength="200" show-word-limit placeholder="最多200字，留空则不显示" /></van-cell-group><p v-if="noteError" class="demo-form-error" role="alert">{{ noteError }}</p><div class="demo-form-actions"><van-button block @click="noteOpen = false">取消</van-button><van-button block type="primary" native-type="submit">保存说明</van-button></div></van-form></van-popup>
  </div>
  <div v-else class="page"><van-empty description="酒水单维护仅供演示管理员使用"><van-button to="/me" type="primary">返回我的</van-button></van-empty></div>
</template>
