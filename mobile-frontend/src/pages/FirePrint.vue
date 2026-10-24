<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Picker as VanPicker, Loading as VanLoading, type PickerConfirmEventParams } from 'vant'
import { fireDirectory, firePrintSnapshot, fireSnapshotKey } from '../stores/fire'
import { getMediaUrl } from '../media'

type PrintPhoto = ReturnType<typeof firePrintSnapshot>[number] & { url: string }
const route = useRoute()
const scope = computed(() => String(route.query.scope || 'all'))
const scopeTitle = computed(() => scope.value === 'all' ? '全部消防档案' : `${scope.value} ${fireDirectory(scope.value)?.name || ''}`)
const parts = ref<PrintPhoto[][]>([]); const part = ref(0); const loading = ref(false); const printing = ref(false); const error = ref(''); const snapshot = ref('')
const loaded = ref<string[]>([]); const pages = computed(() => parts.value[part.value] || [])
const changed = computed(() => { try { return !!snapshot.value && fireSnapshotKey(scope.value) !== snapshot.value } catch { return true } })
const ready = computed(() => !loading.value && !error.value && !changed.value && pages.value.length > 0 && pages.value.every(p => loaded.value.includes(p.id)))
const printArea = ref<HTMLElement>(); const pickerShow = ref(false); const pickerValue = ref<number[]>([])
const pickerColumns = computed(() => parts.value.map((rows, i) => ({ text: `第 ${i + 1} 册 · ${rows.length} 页`, value: i })))
let generation = 0
async function dimensions(url: string) {
  const img = new Image()
  await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('图片无法读取，请重新选择档案照片')); img.src = url })
  return { width: img.naturalWidth, height: img.naturalHeight }
}
async function prepare() {
  const token = ++generation
  loading.value = true; error.value = ''; parts.value = []; loaded.value = []; snapshot.value = ''; part.value = 0
  try {
    const key = fireSnapshotKey(scope.value)
    const photos = firePrintSnapshot(scope.value)
    const groups: PrintPhoto[][] = []; let rows: PrintPhoto[] = []; let pixels = 0
    for (const photo of photos) {
      const url = await getMediaUrl(photo.file)
      if (token !== generation) return
      const size = photo.width > 0 && photo.height > 0 ? { width: photo.width, height: photo.height } : await dimensions(url)
      const count = size.width * size.height
      if (!count || count > 60_000_000) throw new Error(`${photo.code} 的图片尺寸无效或超过6000万像素，请返回目录处理`)
      if (rows.length && (rows.length >= 12 || pixels + count > 45_000_000)) { groups.push(rows); rows = []; pixels = 0 }
      rows.push({ ...photo, ...size, url }); pixels += count
    }
    if (rows.length) groups.push(rows)
    if (fireSnapshotKey(scope.value) !== key) throw new Error('档案已更新，请重新生成打印分册')
    parts.value = groups; snapshot.value = key
  } catch (e) { if (token === generation) error.value = e instanceof Error ? e.message : '无法准备打印内容，请重试' }
  finally { if (token === generation) loading.value = false }
}
watch(scope, prepare, { immediate: true })
watch(part, () => { loaded.value = []; error.value = '' })
onBeforeUnmount(() => { generation++ })
function confirmPart({ selectedValues }: PickerConfirmEventParams) { part.value = Number(selectedValues[0]); pickerShow.value = false }
function openParts() { pickerValue.value = [part.value]; pickerShow.value = true }
function imageLoaded(id: string) { if (!loaded.value.includes(id)) loaded.value.push(id) }
function imageFailed() { error.value = '本册有图片加载失败，已停止打印。请重新加载核对，不能跳过该页。' }
async function print() {
  if (!ready.value || printing.value) return
  printing.value = true
  try {
    const currentScope = scope.value; const key = snapshot.value; const selected = part.value
    if (fireSnapshotKey(currentScope) !== key) throw new Error('档案内容已变化，请重新生成分册')
    await nextTick()
    const images = Array.from(printArea.value?.querySelectorAll('img') || [])
    if (images.length !== pages.value.length || images.some(img => !img.complete || !img.naturalWidth)) throw new Error('本册图片尚未加载完整，请稍后重试')
    await Promise.all(images.map(img => img.decode()))
    if (scope.value !== currentScope || part.value !== selected || fireSnapshotKey(currentScope) !== key) throw new Error('档案或所选分册已变化，请重新核对')
    window.print()
  } catch (e) { error.value = e instanceof Error ? e.message : '打印前核对失败，请重试' }
  finally { printing.value = false }
}
</script>

<template>
  <div class="page fire-print-page" :class="{ 'fire-print-ready': ready }"><div class="fire-print-controls"><div class="page-heading"><div><h1>消防档案打印</h1><p>{{ scopeTitle }}</p></div></div><van-notice-bar :scrollable="false" wrapable text="仅打印生效照片，每张一页。按最多12页或累计4500万像素分册；图片全部加载并核对后才可打印。" />
      <div v-if="loading" class="fire-print-loading"><VanLoading vertical>正在准备打印分册…</VanLoading></div>
      <template v-else-if="parts.length"><van-cell title="当前分册" :value="`第 ${part + 1} / ${parts.length} 册 · ${pages.length} 页`" :is-link="parts.length > 1" @click="parts.length > 1 && openParts()" /><p class="section-caption" aria-live="polite">{{ changed ? '档案已更新，请重新生成分册。' : error ? '核对未通过，暂不能打印。' : ready ? '本册图片加载完成，可打印或另存PDF。' : `正在加载本册照片 ${loaded.length}/${pages.length}…` }}</p><div class="page-actions"><van-button plain :disabled="loading || printing" @click="prepare">重新加载核对</van-button><van-button type="primary" icon="description-o" :disabled="!ready" :loading="printing" @click="print">打印本册 / 存PDF</van-button></div></template>
      <van-empty v-else-if="!error" description="所选范围暂无生效照片"><van-button :to="scope === 'all' ? '/fire' : `/fire/${scope}`" type="primary">返回目录补充</van-button></van-empty>
      <p v-if="error" class="inline-error" role="alert">{{ error }}</p><div v-if="error && !parts.length" class="page-actions"><van-button plain type="primary" @click="prepare">重新加载核对</van-button><van-button to="/fire">返回消防档案</van-button></div>
    </div>
    <div v-if="pages.length" ref="printArea" :key="`${snapshot}:${part}`" class="fire-print-sheets"><figure v-for="(photo, index) in pages" :key="photo.id" class="fire-print-sheet"><figcaption>{{ photo.code }} {{ photo.directory_name }} · 第{{ photo.sort_order }}张 · 本册{{ index + 1 }}/{{ pages.length }}页</figcaption><img :src="photo.url" :alt="`${photo.code} ${photo.directory_name}，第${photo.sort_order}张档案照片`" :width="photo.width" :height="photo.height" @load="imageLoaded(photo.id)" @error="imageFailed" /></figure></div>
    <van-popup v-model:show="pickerShow" position="bottom" round safe-area-inset-bottom><VanPicker v-model="pickerValue" title="选择打印分册" :columns="pickerColumns" @confirm="confirmPart" @cancel="pickerShow = false" /></van-popup>
  </div>
</template>

<style scoped>
.fire-print-loading { padding: 40px 16px; }
.fire-print-sheets { display: grid; gap: 20px; margin-top: 24px; }
.fire-print-sheet { margin: 0; padding: 12px; background: #fff; color: #20242d; border: 1px solid var(--line); }
.fire-print-sheet figcaption { font-size: 12px; padding-bottom: 8px; }
.fire-print-sheet img { display: block; width: 100%; height: auto; object-fit: contain; }
@media print {
  @page { size: A4 portrait; margin: 10mm; }
  :global(html), :global(body), :global(#app), :global(.app-shell), :global(#main-content) { background: white !important; margin: 0 !important; padding: 0 !important; min-height: 0 !important; }
  :global(.brand-header), :global(.van-nav-bar), :global(.demo-strip), :global(.van-tabbar), :global(.van-tabbar__placeholder), :global(.van-popup), :global(.van-overlay) { display: none !important; }
  .fire-print-page { margin: 0; padding: 0; max-width: none; }
  .fire-print-controls { display: none; }
  .fire-print-sheets { display: block; margin: 0; }
  .fire-print-page:not(.fire-print-ready) .fire-print-sheets { display: none; }
  .fire-print-sheet { border: 0; padding: 0; height: 276mm; break-after: page; page-break-after: always; overflow: hidden; }
  .fire-print-sheet:last-child { break-after: auto; page-break-after: auto; }
  .fire-print-sheet figcaption { height: 7mm; padding: 0; font-size: 9pt; }
  .fire-print-sheet img { width: 100%; height: 268mm; object-fit: contain; }
}
</style>
