<script setup lang="ts">
import { computed, ref } from 'vue'
import { reviews, handledReviews } from '../reviews'
const search = ref('')
const kind = ref('全部')
const kinds = computed(() => ['全部', ...new Set(reviews.value.map(row => row.kindLabel))])
const filtered = computed(() => reviews.value.filter(row => (kind.value === '全部' || row.kindLabel === kind.value) && `${row.title}${row.sub}${row.by}`.toLowerCase().includes(search.value.trim().toLowerCase())))
</script>
<template>
  <div class="page">
    <div class="page-heading"><div><h1>待处理申请</h1><p class="heading-note">核对资料和附件，再决定是否通过</p></div><span class="large-count">{{ reviews.length }}<small> 项</small></span></div>
    <van-search v-model="search" label="搜索" placeholder="查找内容或提交人" aria-label="搜索审核申请" class="page-search" />
    <div class="filter-row"><van-button v-for="label in kinds" :key="label" size="small" :plain="kind !== label" :type="kind === label ? 'primary' : 'default'" @click="kind = label">{{ label }}</van-button></div>
    <van-cell-group v-if="filtered.length" inset><van-cell v-for="item in filtered" :key="item.id" :title="item.title" :label="`${item.kindLabel} · ${item.sub}\n${item.by} · ${item.at}`" is-link :to="`/reviews/${encodeURIComponent(item.id)}`"><template #value><van-tag type="warning" plain>待审核</van-tag></template></van-cell></van-cell-group>
    <van-empty v-else :description="reviews.length ? '没有符合筛选条件的申请' : '当前没有待审核申请'"><van-button v-if="reviews.length" plain @click="search = ''; kind = '全部'">清空筛选</van-button><van-button v-else plain to="/apps">返回资料与应用</van-button></van-empty>
    <p class="section-caption">资料、新附件、字段修改、物品、资产和消防申请会汇总到这里。处理结果同步到本机对应页面。</p>
    <p v-if="handledReviews.length" class="section-caption">本机演示已处理 {{ handledReviews.length }} 项。最近处理：{{ handledReviews[0]?.title }} · {{ handledReviews[0]?.result }}。</p>
  </div>
</template>
