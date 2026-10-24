<script setup lang="ts">
import { computed, ref } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { categories, stocktakeRows, countStock, type Category, type StocktakeRow } from '../stores/warehouse'
import '../warehouse.css'
const category = ref<Category>('酒水'); const showCategory = ref(false); const rows = ref<StocktakeRow[]>(stocktakeRows(category.value)); const actual = ref<Record<number, string>>({}); const errors = ref<Record<number, string>>({}); const error = ref(''); const busy = ref(false); const conflictIds = ref<number[]>([])
const filled = computed(() => rows.value.filter(row => actual.value[row.id] !== undefined && actual.value[row.id] !== ''))
const changed = computed(() => filled.value.filter(row => Number(actual.value[row.id]) !== row.quantity).length)
const month = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' })
const actions = categories.map(name => ({ name }))
function valid(value?: string) { return value !== undefined && value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0 }
function diff(row: StocktakeRow) { const value = actual.value[row.id]; if (!valid(value)) return '未填写'; const n = Number(value) - row.quantity; return n > 0 ? `+${n}${row.unit}` : `${n}${row.unit}` }
async function choose(option: { name: Category }) { if (option.name === category.value) return; if (filled.value.length) { try { await showConfirmDialog({ title: '切换盘点分类？', message: '当前填写的实盘数量将清空。', confirmButtonText: '切换分类', cancelButtonText: '继续当前盘点' }) } catch { return } }; category.value = option.name; actual.value = {}; reload() }
function reload() { rows.value = stocktakeRows(category.value); errors.value = {}; conflictIds.value = []; error.value = ''; showToast('账面已重新加载，已有实盘输入保留，请重新核对') }
async function submit() {
  if (busy.value) return; errors.value = {}; error.value = ''
  filled.value.forEach(row => { if (!valid(actual.value[row.id])) errors.value[row.id] = '请输入非负整数' })
  if (Object.keys(errors.value).length) { error.value = '有实盘数量填写不正确，请修正后提交'; return }
  if (!filled.value.length) { error.value = '请至少填写一项实盘数量；未填写的物品不会修改'; return }
  busy.value = true
  try { await showConfirmDialog({ title: '核对分类盘点', message: `已填写${filled.value.length}项，其中${changed.value}项有差异；${rows.value.length - filled.value.length}项未填写不修改。确认已实际清点？`, confirmButtonText: '确认提交' }); const result = countStock(filled.value.map(row => ({ id: row.id, actual: Number(actual.value[row.id]), expected_quantity: row.quantity, expected_stock_log_id: row.stock_log_id }))); actual.value = {}; rows.value = stocktakeRows(category.value); showToast(`本机盘点完成：调整${result.changed}项，相符${result.unchanged}项`) }
  catch (e) { if (e instanceof Error) { error.value = e.message; if (e.name === 'StocktakeConflict' && 'ids' in e) conflictIds.value = e.ids as number[] } } finally { busy.value = false }
}
onBeforeRouteLeave(async () => { if (!filled.value.length) return true; try { await showConfirmDialog({ title: '离开本次盘点？', message: '尚未提交的实盘数量不会保存。', confirmButtonText: '放弃并离开', cancelButtonText: '继续盘点' }); return true } catch { return false } })
</script>
<template>
  <div class="page warehouse-page"><div class="page-heading"><div><h1>分类批量盘点</h1><p class="heading-note">{{ month }} · 按实物清点数量</p></div><van-button size="small" plain type="primary" icon="arrow-down" @click="showCategory = true">{{ category }}</van-button></div>
    <van-notice-bar wrapable :scrollable="false" text="先清点实物，再填实盘数量。未填写的物品不修改，账实相符不重复记录调整。" />
    <div class="warehouse-list-toolbar"><span class="muted">已填 {{ filled.length }} / {{ rows.length }} 项</span><van-button size="small" plain icon="replay" @click="reload">重载账面</van-button></div>
    <van-notice-bar v-if="error" wrapable :scrollable="false" :text="error" /><p v-if="conflictIds.length" class="warehouse-error" role="alert">有 {{ conflictIds.length }} 项账面已变化，整批未提交。请点“重载账面”，重新清点后再提交。</p>
    <van-cell-group v-for="row in rows" :key="row.id" inset class="warehouse-count-group"><van-cell :title="row.name" :label="`${row.spec || '未填规格'} · 单位：${row.unit}`"><template #value><van-tag v-if="conflictIds.includes(row.id)" type="danger" plain>账面变化</van-tag></template></van-cell><van-cell title="月初 / 采购 / 领用" :value="`${row.month_begin} / ${row.month_purchase} / ${row.month_consume}`" /><van-cell title="账面结余" :value="`${row.quantity}${row.unit}`" /><van-field v-model="actual[row.id]" :name="String(row.id)" type="digit" label="实盘数量" :placeholder="`清点后填写，单位：${row.unit}`" :error-message="errors[row.id]" :aria-label="`${row.name}实盘数量（${row.unit}）`" /><van-cell title="盘点差异" :value="diff(row)" /></van-cell-group>
    <van-empty v-if="!rows.length" description="该分类暂无已生效物品" /><p class="section-caption">数据仅保存在本机演示。提交时会核对加载账面和最新流水，发现变化会要求重新清点。</p><van-button v-if="rows.length" block type="primary" class="secondary-wide" :loading="busy" :disabled="!!conflictIds.length" @click="submit">核对并提交盘点（{{ filled.length }}项）</van-button>
    <van-action-sheet v-model:show="showCategory" title="选择盘点分类" :actions="actions" close-on-click-action cancel-text="取消" @select="choose" />
  </div>
</template>
