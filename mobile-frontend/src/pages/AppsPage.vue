<script setup lang="ts">
import { computed } from 'vue'
import { demo, modules, modulePath } from '../demo'
import { reviews } from '../reviews'
const visibleGroups = computed(() => ['档案资料', '门店物资', ...(demo.role === 'admin' ? ['管理功能'] : [])])
</script>

<template>
  <div class="page">
    <div class="page-heading"><div><h1>资料与应用</h1><p class="heading-note">按工作内容找到对应模块</p></div></div>
    <section v-for="group in visibleGroups" :key="group" class="section">
      <div class="section-heading"><h2>{{ group }}</h2></div>
      <van-cell-group inset>
        <van-cell v-for="mod in modules.filter(item => item.group === group)" :key="mod.key" :title="mod.name" :label="mod.note" :icon="mod.icon" is-link :to="modulePath(mod.key)">
          <template v-if="mod.key === 'reviews'" #value><van-badge v-if="reviews.length" :content="reviews.length" /></template>
        </van-cell>
      </van-cell-group>
    </section>
  </div>
</template>
