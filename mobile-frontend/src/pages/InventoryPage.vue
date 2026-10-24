<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import MediaThumb from '../components/MediaThumb.vue'
import { categories, visibleInventory, inventoryQuery, isLow, getExpiry, statusText } from '../stores/warehouse'
import '../warehouse.css'
const route = useRoute()
const showExpiry = ref(false)
const action = computed(() => route.query.action === 'in' || route.query.action === 'out' ? route.query.action : undefined)
watch(() => route.query.filter, filter => { if (filter === 'low') inventoryQuery.lowOnly = true; if (filter === 'expiry') inventoryQuery.expiry = 'due' }, { immediate: true })
const expiryLabels: Record<string, string> = { all: '全部有效期', due: '到期提醒', expired: '已过期', warn: '15天内到期', unknown: '有效期待确认' }
const expiryActions = Object.entries(expiryLabels).map(([value, name]) => ({ name, value }))
const filtered = computed(() => visibleInventory.value.filter(item =>
  (!action.value || item.status === 'approved') &&
  (inventoryQuery.category === '全部' || item.category === inventoryQuery.category) &&
  (!inventoryQuery.lowOnly || isLow(item)) &&
  (inventoryQuery.expiry === 'all' || (inventoryQuery.expiry === 'due' ? ['expired', 'warn'].includes(getExpiry(item).level) : getExpiry(item).level === inventoryQuery.expiry)) &&
  `${item.name} ${item.spec} ${item.location}`.toLowerCase().includes(inventoryQuery.search.trim().toLowerCase()),
))
function reset() { inventoryQuery.search = ''; inventoryQuery.lowOnly = false; inventoryQuery.category = '全部'; inventoryQuery.expiry = 'all' }
function selectExpiry(option: { value: string }) { inventoryQuery.expiry = option.value }
</script>

<template>
  <div class="page inventory-page warehouse-page">
    <div class="page-heading"><div><h1>{{ action ? `选择${action === 'in' ? '入库' : '出库'}物品` : '仓库管理' }}</h1><p class="heading-note">{{ action ? '仅可对已生效物品登记' : '查库存 · 入出库 · 盘点' }}</p></div><van-button v-if="!action" size="small" plain type="primary" icon="plus" to="/inventory/new">新增</van-button><van-button v-else size="small" plain to="/inventory">取消</van-button></div>
    <van-search v-model="inventoryQuery.search" placeholder="搜索名称、规格或位置" aria-label="搜索仓库物品" background="transparent" />
    <van-tabs v-model:active="inventoryQuery.category" shrink :border="false"><van-tab v-for="category in ['全部', ...categories]" :key="category" :name="category" :title="category" /></van-tabs>
    <div class="warehouse-filter-row"><van-button :type="inventoryQuery.lowOnly ? 'primary' : 'default'" :plain="!inventoryQuery.lowOnly" size="small" icon="warning-o" @click="inventoryQuery.lowOnly = !inventoryQuery.lowOnly">库存不足</van-button><van-button size="small" plain :type="inventoryQuery.expiry !== 'all' ? 'primary' : 'default'" icon="arrow-down" @click="showExpiry = true">{{ expiryLabels[inventoryQuery.expiry] }}</van-button><span class="muted">{{ filtered.length }} 种</span></div>
    <van-cell-group v-if="filtered.length" inset class="stock-list">
      <van-cell v-for="item in filtered" :key="item.id" is-link :to="{ path: `/inventory/${item.id}`, query: action ? { action } : {} }" :title="item.name" :label="`${item.spec || '未填规格'} · ${item.location || '未填位置'}`">
        <template v-if="item.current_image" #icon><MediaThumb :file="item.current_image" :size="48" /></template>
        <template #value><span class="stock-quantity">{{ item.quantity }}<small>{{ item.unit }}</small></span></template>
        <template #extra><div class="stock-flags"><van-tag v-if="item.status !== 'approved'" :type="item.status === 'rejected' ? 'danger' : 'warning'" plain>{{ statusText(item.status) }}</van-tag><van-tag v-if="isLow(item)" type="warning" plain>库存不足 · 警戒 {{ item.safety_stock }}{{ item.unit }}</van-tag><van-tag v-if="['warn', 'expired'].includes(getExpiry(item).level)" :type="getExpiry(item).level === 'expired' ? 'danger' : 'warning'" plain>{{ getExpiry(item).label }}</van-tag></div></template>
      </van-cell>
    </van-cell-group>
    <van-empty v-else description="没有找到符合条件的物品"><van-button plain type="primary" @click="reset">清空筛选</van-button></van-empty>
    <p class="section-caption">数量按物品单位登记。待审核物品仅提交人和管理员可见，审核后才能入出库与盘点。</p>
    <van-button v-if="!action" class="secondary-wide" block plain icon="balance-list-o" to="/inventory/stocktake">按分类批量盘点</van-button>
    <van-action-sheet v-model:show="showExpiry" title="有效期筛选" :actions="expiryActions" cancel-text="取消" close-on-click-action @select="selectExpiry" />
  </div>
</template>
