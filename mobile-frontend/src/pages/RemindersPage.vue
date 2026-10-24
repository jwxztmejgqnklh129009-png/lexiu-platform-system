<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { visibleInventory, getExpiry } from '../stores/warehouse'
import { visibleRecords, expiryOf } from '../stores/records'
const route = useRoute()
const type = ref(String(route.query.type || 'all'))
const stock = computed(() => visibleInventory.value.filter(item => item.status === 'approved' && ['warn', 'expired'].includes(getExpiry(item).level)).sort((a, b) => (getExpiry(a).days || 0) - (getExpiry(b).days || 0)))
const documents = computed(() => visibleRecords.value.filter(row => row.flow_status === 'approved' && ['warning', 'expired'].includes(expiryOf(row).level)).sort((a, b) => (expiryOf(a).days || 0) - (expiryOf(b).days || 0)))
</script>
<template><div class="page"><div class="page-heading"><div><h1>有效期提醒</h1><p class="heading-note">已过期、今天到期和15天内到期</p></div></div><div class="filter-row"><van-button v-for="option in [{ label: '全部', value: 'all' }, { label: '物品', value: 'inventory' }, { label: '证照与健康证', value: 'records' }]" :key="option.value" size="small" :plain="type !== option.value" :type="type === option.value ? 'primary' : 'default'" @click="type = option.value">{{ option.label }}</van-button></div>
<section v-if="type !== 'records'" class="section"><div class="section-heading"><h2>仓库物品</h2><span class="muted">{{ stock.length }} 种</span></div><van-cell-group v-if="stock.length" inset><van-cell v-for="row in stock" :key="row.id" :title="row.name" :label="`${row.spec} · ${row.location}`" is-link :to="`/inventory/${row.id}`"><template #value><van-tag plain :type="getExpiry(row).level === 'expired' ? 'danger' : 'warning'">{{ getExpiry(row).label }}</van-tag></template></van-cell></van-cell-group><van-empty v-else description="暂无物品到期提醒" /></section>
<section v-if="type !== 'inventory'" class="section"><div class="section-heading"><h2>证照与健康证</h2><span class="muted">{{ documents.length }} 份</span></div><van-cell-group v-if="documents.length" inset><van-cell v-for="row in documents" :key="row.id" :title="row.name" :label="`${row.scope === 'employee' ? row.holder : row.category} · 有效期至 ${row.expiry_date}`" is-link :to="`/records/${row.scope}/${row.id}`"><template #value><van-tag plain :type="expiryOf(row).level === 'expired' ? 'danger' : 'warning'">{{ expiryOf(row).days === 0 ? '今天到期' : expiryOf(row).level === 'expired' ? '已过期' : '15天内到期' }}</van-tag></template></van-cell></van-cell-group><van-empty v-else description="暂无资料到期提醒" /></section><p class="section-caption">仅统计已生效记录，日期按当前设备日期计算。提醒用于演示，不代表现场检查或合规结论。</p></div></template>
