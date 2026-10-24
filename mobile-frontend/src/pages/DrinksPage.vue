<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Image as VanImage, ImagePreview as VanImagePreview, Button as VanButton, Pagination as VanPagination, showToast, type ImagePreviewInstance } from 'vant'
import { drinkPages, drinkNote } from '../stores/drinks'
import { getMediaUrl } from '../media'
import '../settings.css'

const pageNumber = ref(1)
const currentPage = computed(() => drinkPages.value[pageNumber.value - 1])
const imageUrl = ref('')
const imageFailed = ref(false)
const imageLoading = ref(false)
const previewLoading = ref(false)
const previewWarning = ref('')
const previewOpen = ref(false)
const previewRef = ref<ImagePreviewInstance>()
const previewPages = ref<{ id: string; url: string; pageNumber: number }[]>([])
const previewImages = computed(() => previewPages.value.map(page => page.url))
const previewStartPosition = ref(0)
const previewIndex = ref(0)
let requestId = 0
let active = true
onBeforeUnmount(() => { active = false; requestId++ })
watch(() => drinkPages.value.length, count => { pageNumber.value = Math.max(1, Math.min(pageNumber.value, count)) })
async function loadImage() {
  const token = ++requestId
  imageUrl.value = ''; imageFailed.value = false; imageLoading.value = !!currentPage.value
  if (!currentPage.value) return
  try {
    const url = await getMediaUrl(currentPage.value.image)
    if (token !== requestId) return
    if (!url) throw new Error('图片不存在')
    imageUrl.value = url
  } catch { if (token === requestId) imageFailed.value = true }
  finally { if (token === requestId) imageLoading.value = false }
}
watch(() => currentPage.value?.image.id, loadImage, { immediate: true })
function syncPreviewPage(index: number) {
  const page = previewPages.value[index]
  if (page) { previewIndex.value = index; pageNumber.value = page.pageNumber }
}
function closePreview({ index }: { index: number }) { syncPreviewPage(index) }
async function previewImage() {
  if (previewLoading.value) return
  if (!imageUrl.value || imageFailed.value) { showToast('图片尚未加载，请稍后重试'); return }
  previewLoading.value = true; previewWarning.value = ''
  const pages = drinkPages.value.map((page, index) => ({ ...page, pageNumber: index + 1 }))
  const selectedId = currentPage.value?.id
  try {
    const results = await Promise.allSettled(pages.map(async page => {
      const url = await getMediaUrl(page.image)
      const image = new Image()
      await new Promise<void>((resolve, reject) => { image.onload = () => image.naturalWidth ? resolve() : reject(new Error('空图片')); image.onerror = () => reject(new Error('图片无法读取')); image.src = url })
      return { ...page, url }
    }))
    const readable = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    const failedPages = results.flatMap((result, index) => result.status === 'rejected' ? [pages[index]!.pageNumber] : [])
    if (!active) return
    if (!readable.length) throw new Error('酒单图片均无法读取，请返回列表重新加载')
    if (failedPages.length) previewWarning.value = `第${failedPages.join('、')}页图片无法读取，本次大图仅展示其余${readable.length}页；可关闭大图后重新读取。`
    const startPosition = Math.max(0, readable.findIndex(page => page.id === selectedId))
    previewPages.value = readable
    previewStartPosition.value = startPosition
    syncPreviewPage(startPosition)
    previewOpen.value = true
    if (previewWarning.value) showToast({ message: previewWarning.value, duration: 4000 })
  } catch (cause) {
    previewWarning.value = cause instanceof Error ? cause.message : '大图读取失败，请重新加载'
    showToast(previewWarning.value)
  } finally { previewLoading.value = false }
}
</script>

<template>
  <div class="page drinks-page drink-public-page">
    <div class="menu-heading"><h1>酒水单</h1><p>门店酒水与价格展示 · 本机演示</p></div>
    <template v-if="currentPage">
      <div class="drink-public-title"><h2>{{ currentPage.title || `第 ${pageNumber} 页` }}</h2><span class="muted">{{ pageNumber }} / {{ drinkPages.length }}</span></div>
      <div class="drink-public-image"><van-empty v-if="imageLoading" description="正在读取本机图片" /><van-empty v-else-if="imageFailed" image="error" description="这张本机图片无法读取"><van-button plain @click="loadImage">重新读取</van-button></van-empty><VanImage v-else-if="imageUrl" :src="imageUrl" width="100%" fit="contain" radius="12" :alt="currentPage.title || `酒水单第${pageNumber}页`" @error="imageFailed = true" @click="previewImage" /></div>
      <van-button block plain icon="expand-o" :disabled="!imageUrl || imageFailed" :loading="previewLoading" @click="previewImage">放大查看 · 滑动或按钮翻页</van-button>
      <p v-if="previewWarning" class="demo-form-error" role="alert">{{ previewWarning }}</p>
      <VanPagination v-model="pageNumber" :page-count="drinkPages.length" mode="simple" prev-text="上一页" next-text="下一页" class="drink-pagination" />
    </template>
    <van-empty v-else description="暂无演示酒单图片"><p class="section-caption">管理员在本机上传后，可在这里分页查看。</p></van-empty>
    <van-notice-bar v-if="drinkNote" wrapable :scrollable="false" :text="drinkNote" class="drink-public-note" />
    <p class="public-footer">乐秀 L’OK SHOW · 演示页面</p>
    <van-button plain block size="small" to="/">返回员工演示入口</van-button>
    <VanImagePreview ref="previewRef" v-model:show="previewOpen" :images="previewImages" :start-position="previewStartPosition" :loop="false" closeable show-index :max-zoom="5" :min-zoom="1" double-scale :close-on-click-image="false" class-name="drink-image-preview" @change="syncPreviewPage" @close="closePreview" @closed="previewPages = []">
      <template #cover><div class="drink-preview-actions"><VanButton type="primary" icon="arrow-left" :disabled="previewIndex <= 0" aria-label="酒水单大图上一页" @click.stop="previewRef?.prev()">上一页</VanButton><VanButton type="primary" :disabled="previewIndex >= previewPages.length - 1" aria-label="酒水单大图下一页" @click.stop="previewRef?.next()">下一页<van-icon name="arrow" class="drink-preview-next-icon" /></VanButton></div></template>
    </VanImagePreview>
  </div>
</template>
