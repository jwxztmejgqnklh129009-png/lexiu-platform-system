<script setup lang="ts">
import { ref, watch } from 'vue'
import { Image as VanImage, Icon as VanIcon } from 'vant'
import { getMediaUrl, type MediaRef } from '../media'
const props = withDefaults(defineProps<{ file?: MediaRef | null; size?: number }>(), { size: 56 })
const url = ref('')
let request = 0
watch(() => props.file?.id, async () => {
  const current = ++request
  url.value = ''
  if (!props.file || !props.file.mime.startsWith('image/')) return
  try { const next = await getMediaUrl(props.file); if (current === request) url.value = next } catch { /* Image error slot explains unavailable media. */ }
}, { immediate: true })
</script>
<template>
  <van-image v-if="file && file.mime.startsWith('image/') && url" :src="url" :width="size" :height="size" fit="cover" radius="8" :alt="file.name" class="media-thumb"><template #error><van-icon name="photo-fail" /></template></van-image>
  <span v-else class="media-thumb media-thumb-empty" :style="{ width: `${size}px`, height: `${size}px` }" :aria-label="file ? '附件' : '暂无图片'"><van-icon :name="file && !file.mime.startsWith('image/') ? 'description-o' : 'photo-o'" size="24" /></span>
</template>
