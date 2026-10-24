<script setup lang="ts">
import { ref } from 'vue'
import { Uploader as VanUploader, Button as VanButton, Icon as VanIcon, showToast, type UploaderFileListItem } from 'vant'
import { saveMedia, pendingMediaWrites, type MediaRef } from '../media'
import MediaThumb from './MediaThumb.vue'
const props = withDefaults(defineProps<{ modelValue: MediaRef[]; accept?: string; maxCount?: number; maxSize?: number; maxPixels?: number; label?: string; disabled?: boolean }>(), {
  accept: 'image/jpeg,image/png', maxCount: 1, maxSize: 20 * 1024 * 1024, maxPixels: 30_000_000, label: '选择图片', disabled: false,
})
const emit = defineEmits<{ 'update:modelValue': [files: MediaRef[]] }>()
const busy = ref(false)
const error = ref('')
function beforeRead(input: File | File[]) {
  error.value = ''
  const files = Array.isArray(input) ? input : [input]
  const allowed = props.accept.split(',').map(value => value.trim())
  const mimeByExt: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf', doc: 'application/msword', xls: 'application/vnd.ms-excel', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
  if (files.some(file => !allowed.some(type => type === (file.type || mimeByExt[file.name.split('.').pop()?.toLowerCase() || '']) || type === 'image/*' && file.type.startsWith('image/') || type.startsWith('.') && file.name.toLowerCase().endsWith(type)))) {
    error.value = props.accept.includes('pdf') || props.accept.includes('word') || props.accept.includes('doc') ? '文件格式不受支持，请按本模块说明重新选择。' : '请选择 JPG 或 PNG 图片。'
    return false
  }
  if (props.modelValue.length + files.length > props.maxCount) { error.value = `最多选择 ${props.maxCount} 个附件，请减少选择数量。`; return false }
  return true
}
async function afterRead(input: UploaderFileListItem | UploaderFileListItem[]) {
  busy.value = true
  pendingMediaWrites.value++
  error.value = ''
  const saved: MediaRef[] = []
  try {
    for (const item of Array.isArray(input) ? input : [input]) {
      if (item.file) saved.push(await saveMedia(item.file, props.maxPixels))
    }
    emit('update:modelValue', [...props.modelValue, ...saved])
  } catch (err) {
    if (saved.length) emit('update:modelValue', [...props.modelValue, ...saved])
    error.value = err instanceof Error ? err.message : '附件未保存，请重试。'
  } finally { busy.value = false; pendingMediaWrites.value = Math.max(0, pendingMediaWrites.value - 1) }
}
function oversize() { error.value = `单个附件请控制在 ${Math.round(props.maxSize / 1024 / 1024)}MB 以内。`; showToast(error.value) }
</script>
<template>
  <div class="demo-upload">
    <div v-for="(file, index) in modelValue" :key="file.id" class="chosen-file">
      <media-thumb :file="file" :size="48" /><div class="chosen-file-name">{{ file.name }}<small>{{ file.size ? `${(file.size / 1024).toFixed(0)} KB` : '演示示例' }}</small></div><van-button plain size="small" icon="cross" :aria-label="`移除${file.name}`" :disabled="disabled || busy" @click="emit('update:modelValue', modelValue.filter((_, i) => i !== index))" />
    </div>
    <van-uploader v-if="modelValue.length < maxCount" :model-value="[]" :accept="accept" :multiple="maxCount > 1" :max-count="maxCount - modelValue.length" :max-size="maxSize" result-type="file" :preview-image="false" :disabled="disabled || busy" :before-read="beforeRead" :after-read="afterRead" @oversize="oversize"><van-button plain type="primary" icon="photograph" :loading="busy" :disabled="disabled || busy">{{ busy ? '正在保存到本机' : label }}</van-button></van-uploader>
    <p v-if="error" class="inline-error" role="alert"><van-icon name="warning-o" /> {{ error }}</p>
    <p class="section-caption">仅保存在当前浏览器，不上传服务器。请使用演示文件。</p>
  </div>
</template>
