<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { DropdownMenu as VanDropdownMenu, DropdownItem as VanDropdownItem } from 'vant'
import { visibleRecords, expiryOf, recordCategories, recordStatusText, type RecordKind } from '../stores/records'
import { session } from '../session'

const route = useRoute()
const kind = computed<RecordKind>(() => route.params.kind === 'employee' ? 'employee' : 'company')
const keyword = ref(''); const category = ref(''); const status = ref(''); const expiry = ref('')
const statusOptions = [{ text: '全部审核状态', value: '' }, { text: '已生效', value: 'approved' }, { text: '待审核', value: 'pending' }, { text: '已退回', value: 'rejected' }]
const expiryOptions = [{ text: '全部有效期', value: '' }, { text: '已过期 / 今天到期', value: 'expired' }, { text: '15天内到期', value: 'warning' }, { text: '正常有效', value: 'ok' }, { text: '长期有效', value: 'longterm' }, { text: '待确认', value: 'unknown' }]
const categoryOptions = [{ text: '全部分类', value: '' }, ...recordCategories.map(value => ({ text: value, value }))]
const list = computed(() => visibleRecords.value.filter(row => {
  const q = keyword.value.trim().toLowerCase()
  return row.scope === kind.value && (!q || [row.name, row.cert_no, row.issuer, row.holder].join(' ').toLowerCase().includes(q)) && (!category.value || kind.value === 'employee' || row.category === category.value) && (!status.value || row.flow_status === status.value) && (!expiry.value || expiryOf(row).level === expiry.value)
}).sort((a, b) => (expiryOf(a).days ?? Number.MAX_SAFE_INTEGER) - (expiryOf(b).days ?? Number.MAX_SAFE_INTEGER)))
const totals = computed(() => {
  const rows = visibleRecords.value.filter(r => r.scope === kind.value)
  return { total: rows.length, attention: rows.filter(r => ['expired', 'warning'].includes(expiryOf(r).level)).length }
})
function clearFilters() { keyword.value = ''; category.value = ''; status.value = ''; expiry.value = '' }
</script>

<template>
  <div class="page records-page">
    <div class="page-heading"><div><h1>{{ kind === 'company' ? '企业证照' : '员工健康证' }}</h1><p>共 {{ totals.total }} 份 · {{ totals.attention }} 份需留意有效期</p></div><van-button size="small" type="primary" icon="plus" :to="`/records/${kind}/new`">新增</van-button></div>
    <van-search v-model="keyword" :placeholder="kind === 'company' ? '搜名称、编号、签发单位' : '搜员工姓名、编号、签发单位'" aria-label="搜索资料" />
    <VanDropdownMenu class="records-filter">
      <VanDropdownItem v-if="kind === 'company'" v-model="category" :options="categoryOptions" />
      <VanDropdownItem v-model="expiry" :options="expiryOptions" />
      <VanDropdownItem v-model="status" :options="statusOptions" />
    </VanDropdownMenu>
    <p class="section-caption">{{ session.role === 'admin' ? '可查看全部资料及待审事项。' : '生效资料共享可查；待审、退回资料仅提交人和管理员可见。' }}</p>
    <van-cell-group v-if="list.length" inset>
      <van-cell v-for="row in list" :key="row.id" :title="row.name" :label="`${row.scope === 'company' ? row.category : row.holder} · ${row.expiry_mode === 'date' ? row.expiry_date : expiryOf(row).label}`" is-link :to="`/records/${kind}/${row.id}`" class="records-list-cell">
        <template #value><div class="record-status"><van-tag v-if="row.flow_status !== 'approved'" plain :type="row.flow_status === 'pending' ? 'warning' : 'danger'">{{ recordStatusText(row.flow_status) }}</van-tag><span :class="{ 'record-warning': ['warning', 'expired'].includes(expiryOf(row).level) }">{{ expiryOf(row).label }}</span></div></template>
      </van-cell>
    </van-cell-group>
    <van-empty v-else description="没有符合条件的资料"><van-button plain type="primary" @click="clearFilters">清除筛选</van-button></van-empty>
  </div>
</template>

<style scoped>
.records-filter { margin-top: 4px; --van-dropdown-menu-shadow: none; --van-dropdown-menu-height: 48px; --van-dropdown-menu-title-font-size: 14px; }
.records-list-cell :deep(.van-cell__title) { flex: 1.4; }
.record-status { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; font-size: 14px; }
.record-warning { color: var(--warning-text); }
</style>
