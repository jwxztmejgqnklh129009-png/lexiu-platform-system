<script setup lang="ts">
import { computed, ref } from 'vue'
import { DropdownMenu as VanDropdownMenu, DropdownItem as VanDropdownItem } from 'vant'
import { fireDirectories, fireCounts } from '../stores/fire'
import { session } from '../session'
const q = ref(''); const book = ref(''); const status = ref('')
const books = [{ text: '全部 40 个目录', value: '' }, { text: 'A册 · 基础档案', value: 'A' }, { text: 'B册 · 管理记录', value: 'B' }]
const statuses = [{ text: '全部资料状态', value: '' }, { text: '已有生效照片', value: 'approved' }, { text: '尚无生效照片', value: 'empty' }, { text: '有待审事项', value: 'pending' }]
const list = computed(() => fireDirectories.filter(d => {
  const counts = fireCounts(d.code); const keyword = q.value.trim().toLowerCase()
  return (!keyword || `${d.code} ${d.name}`.toLowerCase().includes(keyword)) && (!book.value || d.book === book.value) && (!status.value || (status.value === 'approved' ? counts.approved > 0 : status.value === 'empty' ? counts.approved === 0 : counts.pending + counts.orders > 0))
}))
const approvedCount = computed(() => fireDirectories.reduce((sum, d) => sum + fireCounts(d.code).approved, 0))
</script>

<template>
  <div class="page fire-page"><div class="page-heading"><div><h1>消防档案</h1><p>固定40个目录 · {{ approvedCount }} 张生效照片</p></div><van-button size="small" plain type="primary" icon="description-o" to="/fire/print?scope=all">分册打印</van-button></div><van-search v-model="q" placeholder="搜目录编号或名称，如 B02 巡查" aria-label="搜索消防目录" /><VanDropdownMenu class="fire-filter"><VanDropdownItem v-model="book" :options="books" /><VanDropdownItem v-model="status" :options="statuses" /></VanDropdownMenu><p class="section-caption">{{ session.role === 'admin' ? '上传直接生效，可审核员工提交并管理照片。' : '可查阅生效档案；上传、替换与调整排序均提交审核。' }}</p>
    <van-cell-group v-if="list.length" inset><van-cell v-for="d in list" :key="d.code" :title="`${d.code} ${d.name}`" :label="`${fireCounts(d.code).approved} 张生效照片${fireCounts(d.code).orders ? ' · ' + fireCounts(d.code).orders + ' 个排序待审' : ''}`" is-link :to="`/fire/${d.code}`"><template #value><van-tag v-if="fireCounts(d.code).pending" type="warning" plain>{{ fireCounts(d.code).pending }} 张待审</van-tag><span v-else-if="!fireCounts(d.code).approved" class="muted">待补充</span></template></van-cell></van-cell-group><van-empty v-else description="没有符合条件的目录"><van-button plain type="primary" @click="q = ''; book = ''; status = ''">清除筛选</van-button></van-empty>
  </div>
</template>

<style scoped>
.fire-filter { --van-dropdown-menu-shadow: none; --van-dropdown-menu-title-font-size: 14px; --van-dropdown-menu-height: 48px; }
.fire-page :deep(.van-cell__title) { flex: 2; }
</style>
