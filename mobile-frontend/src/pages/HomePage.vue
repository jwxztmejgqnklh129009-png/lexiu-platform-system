<script setup lang="ts">
import { computed } from 'vue'
import { session } from '../session'
import { reviews } from '../reviews'
import { lowItems, visibleInventory, getExpiry } from '../stores/warehouse'
import { visibleRecords, expiryOf } from '../stores/records'
const stockExpiring = computed(() => visibleInventory.value.filter(item => item.status === 'approved' && ['warn', 'expired'].includes(getExpiry(item).level)))
const recordsExpiring = computed(() => visibleRecords.value.filter(row => row.flow_status === 'approved' && ['warning', 'expired'].includes(expiryOf(row).level)))
const myPending = computed(() => reviews.value.filter(row => row.by === session.name))
</script>
<template>
  <div class="page home-page">
    <div class="page-heading"><div><p class="eyebrow">乐秀 · 门店管理</p><h1>{{ session.role === 'admin' ? '门店工作台' : '工作台' }}</h1></div><span class="identity-label">{{ session.role === 'admin' ? '管理员' : '普通员工' }}</span></div>
    <section v-if="session.role === 'admin'" class="section">
      <div class="section-heading"><h2>待审核</h2><van-button size="small" plain type="primary" to="/reviews">全部 {{ reviews.length }} 项 <van-icon name="arrow" /></van-button></div>
      <van-cell-group inset><van-cell v-for="review in reviews.slice(0, 2)" :key="review.id" :title="review.title" :label="`${review.kindLabel} · ${review.by}`" is-link :to="`/reviews/${encodeURIComponent(review.id)}`"><template #value><van-tag type="warning" plain>待审核</van-tag></template></van-cell><van-cell v-if="!reviews.length" title="待审核事项已处理完" label="员工提交后将自动出现在这里" icon="passed" /></van-cell-group>
    </section>
    <section class="section"><div class="section-heading"><h2>常用操作</h2></div><div class="shortcut-surface"><van-grid :column-num="3" :border="false"><van-grid-item><van-button class="shortcut-button" block plain icon="search" to="/inventory">查库存</van-button></van-grid-item><van-grid-item><van-button class="shortcut-button" block plain icon="arrow-down" to="/inventory?action=in">入库登记</van-button></van-grid-item><van-grid-item><van-button class="shortcut-button" block plain icon="arrow-up" to="/inventory?action=out">出库登记</van-button></van-grid-item></van-grid></div></section>
    <section class="section"><div class="section-heading"><h2>需要留意</h2><van-button plain size="small" type="primary" to="/reminders">查看提醒 <van-icon name="arrow" /></van-button></div><van-cell-group inset>
      <van-cell title="库存不足" :label="lowItems.map(item => item.name).join('、') || '当前无库存不足物品'" icon="warning-o" is-link to="/inventory?filter=low"><template #value><span class="count-warning">{{ lowItems.length }}<small> 种</small></span></template></van-cell>
      <van-cell title="物品有效期" :label="stockExpiring.length ? '查看过期及15天内到期物品' : '当前无到期提醒'" icon="clock-o" is-link to="/reminders?type=inventory"><template #value><span class="count-warning">{{ stockExpiring.length }}<small> 种</small></span></template></van-cell>
      <van-cell title="证照与健康证有效期" :label="recordsExpiring.length ? '查看到期资料与关联附件' : '当前无到期提醒'" icon="description-o" is-link to="/reminders?type=records"><template #value><span class="count-warning">{{ recordsExpiring.length }}<small> 份</small></span></template></van-cell>
    </van-cell-group></section>
    <section v-if="session.role === 'staff' && myPending.length" class="section"><div class="section-heading"><h2>我的待审提交</h2><span class="muted">{{ myPending.length }} 项</span></div><van-cell-group inset><van-cell v-for="row in myPending.slice(0, 3)" :key="row.id" :title="row.title" :label="row.kindLabel" is-link :to="row.sourcePath"><template #value><van-tag plain type="warning">待审核</van-tag></template></van-cell></van-cell-group></section>
    <section class="section"><div class="section-heading"><h2>门店资料</h2><van-button size="small" plain type="primary" to="/apps">查看全部 <van-icon name="arrow" /></van-button></div><van-cell-group inset><van-cell title="企业证照" label="查看资料、有效期与附件版本" icon="description-o" is-link to="/records/company" /><van-cell title="员工健康证" label="按员工姓名查找到期提醒" icon="friends-o" is-link to="/records/employee" /><van-cell title="消防档案" label="固定目录 · 照片与分册打印" icon="shield-o" is-link to="/fire" /></van-cell-group></section>
  </div>
</template>
