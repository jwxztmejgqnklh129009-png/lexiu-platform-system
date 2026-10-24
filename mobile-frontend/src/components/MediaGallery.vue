<script setup lang="ts">
import { ref, watch } from 'vue'
import { Button as VanButton, Image as VanImage, Icon as VanIcon, Loading as VanLoading, showImagePreview, showToast } from 'vant'
import { getMediaUrl, downloadMedia, type MediaRef } from '../media'
const props = withDefaults(defineProps<{ files: MediaRef[]; compact?: boolean }>(), { compact: false })
const entries = ref<{ file: MediaRef; url: string; error: string }[]>([])
const loading = ref(false)
let request = 0
async function load() {
  const current = ++request
  loading.value = true
  const result = await Promise.all(props.files.map(async file => {
    try { return { file, url: await getMediaUrl(file), error: '' } }
    catch (err) { return { file, url: '', error: err instanceof Error ? err.message : '附件读取失败，请重试。' } }
  }))
  if (current === request) { entries.value = result; loading.value = false }
}
watch(() => props.files.map(file => file.id).join('|'), load, { immediate: true })
function open(id: string) {
  const images = entries.value.filter(row => row.url && row.file.mime.startsWith('image/'))
  const index = images.findIndex(row => row.file.id === id)
  if (index >= 0) showImagePreview({ images: images.map(row => row.url), startPosition: index, closeable: true, loop: false, maxZoom: 5 })
}
async function download(file: MediaRef) {
  try { await downloadMedia(file) } catch (err) { showToast(err instanceof Error ? err.message : '下载失败，请重试。') }
}
</script>
<template>
  <div class="media-gallery" :class="{ compact }" aria-live="polite">
    <van-loading v-if="loading" size="20">读取本机附件…</van-loading>
    <div v-for="entry in entries" :key="entry.file.id" class="media-entry">
      <template v-if="entry.url && entry.file.mime.startsWith('image/')">
        <van-button plain block class="media-image-button" :aria-label="`放大查看${entry.file.name}`" @click="open(entry.file.id)"><van-image :src="entry.url" :alt="entry.file.name" :fit="compact ? 'cover' : 'contain'" width="100%" :height="compact ? 112 : 240"><template #error><van-icon name="photo-fail" /> 图片加载失败</template></van-image></van-button>
        <p class="media-caption">{{ entry.file.name }} · 点图放大</p>
      </template>
      <template v-else-if="entry.url">
        <van-button plain block icon="description-o" @click="download(entry.file)">下载{{ entry.file.mime === 'application/pdf' ? ' PDF ' : ' ' }}附件</van-button><p class="media-caption">{{ entry.file.name }}</p>
      </template>
      <template v-else><p class="inline-error">{{ entry.error }}</p><van-button plain size="small" icon="replay" @click="load">重新读取附件</van-button></template>
    </div>
    <p v-if="!loading && !files.length" class="quiet-empty">暂无附件</p>
  </div>
</template>
