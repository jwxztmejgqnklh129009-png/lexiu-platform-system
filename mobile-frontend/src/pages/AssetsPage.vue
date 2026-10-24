<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { onBeforeRouteLeave, useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { session } from '../session'
import { visibleAssets, createAsset, statusText } from '../stores/warehouse'
import '../warehouse.css'
const router = useRouter(); const showForm = ref(false); const step = ref(1); const error = ref(''); const busy = ref(false)
const draft = reactive({ name: '', code: '', category: '', location: '', note: '' })
const dirty = computed(() => Object.values(draft).some(value => value.trim()))
function openForm() { Object.assign(draft, { name: '', code: '', category: '', location: '', note: '' }); step.value = 1; error.value = ''; showForm.value = true }
async function beforeClose() { if (!dirty.value || busy.value) return !busy.value; try { await showConfirmDialog({ title: '放弃本次填写？', message: '尚未提交的资产信息不会保存。', confirmButtonText: '放弃填写', cancelButtonText: '继续填写' }); return true } catch { return false } }
async function closeForm() { if (await beforeClose()) showForm.value = false }
onBeforeRouteLeave(async () => !showForm.value || !dirty.value || await beforeClose())
function prepare() { error.value = ''; if (!draft.name.trim()) { error.value = '请填写资产名称'; return }; step.value = 2 }
async function save() { if (busy.value) return; busy.value = true; error.value = ''; try { const id = createAsset(draft); Object.assign(draft, { name: '', code: '', category: '', location: '', note: '' }); showForm.value = false; showToast(session.role === 'admin' ? '资产已在本机生效' : '资产已在本机提交待审核'); await router.push(`/assets/${id}`) } catch (e) { error.value = e instanceof Error ? e.message : '保存失败，请重试' } finally { busy.value = false } }
</script>
<template>
  <div class="page warehouse-page"><div class="page-heading"><div><h1>固定资产</h1><p class="heading-note">查看在库情况，登记领用与归还</p></div><van-button size="small" type="primary" plain icon="plus" @click="openForm">新增</van-button></div>
    <van-cell-group v-if="visibleAssets.length" inset><van-cell v-for="asset in visibleAssets" :key="asset.id" :title="asset.name" :label="`${asset.code || '未填编号'} · ${asset.category || '未分类'}\n${asset.location || '未填位置'}${asset.holder ? ` · 领用人：${asset.holder}` : ''}`" is-link :to="`/assets/${asset.id}`"><template #value><van-tag plain :type="asset.review_status !== 'approved' ? asset.review_status === 'rejected' ? 'danger' : 'warning' : asset.status === 'taken' ? 'warning' : 'success'">{{ asset.review_status !== 'approved' ? statusText(asset.review_status) : asset.status === 'taken' ? '已领用' : '在库' }}</van-tag></template></van-cell></van-cell-group><van-empty v-else description="还没有可见的资产记录"><van-button type="primary" plain @click="openForm">新增资产</van-button></van-empty><p class="section-caption">员工新增资产需管理员审核。已生效资产可登记领用和归还，均仅保存于本机演示。</p>
    <van-popup v-model:show="showForm" position="bottom" round closeable safe-area-inset-bottom :close-on-click-overlay="false" :before-close="beforeClose" class="move-popup"><h2 class="popup-title">新增固定资产</h2><p class="popup-subtitle">{{ step === 1 ? '1 / 2 填写登记信息' : '2 / 2 核对后提交' }} · {{ session.role === 'admin' ? '直接生效' : '需管理员审核' }}</p><p v-if="error" class="warehouse-error" role="alert">{{ error }}</p>
      <van-form v-if="step === 1" @submit="prepare"><van-cell-group inset><van-field v-model="draft.name" name="name" label="资产名称" required maxlength="200" placeholder="例如：无线麦克风" :rules="[{ required: true, message: '请填写资产名称' }]" /><van-field v-model="draft.code" label="资产编号" maxlength="60" placeholder="选填" /><van-field v-model="draft.category" label="分类" maxlength="60" placeholder="例如：电器 / 音响 / 家具" /><van-field v-model="draft.location" label="存放位置" maxlength="120" placeholder="例如：前台设备柜" /><van-field v-model="draft.note" label="备注" type="textarea" rows="2" maxlength="200" show-word-limit placeholder="选填" /></van-cell-group><div class="popup-actions"><van-button block plain native-type="button" @click="closeForm">取消</van-button><van-button block type="primary" native-type="submit">下一步：核对</van-button></div></van-form>
      <template v-else><van-cell-group inset><van-cell title="名称" :value="draft.name" /><van-cell title="编号" :value="draft.code || '未填写'" /><van-cell title="分类" :value="draft.category || '未填写'" /><van-cell title="位置" :value="draft.location || '未填写'" /><van-cell v-if="draft.note" title="备注" :label="draft.note" /></van-cell-group><div class="popup-actions"><van-button block plain :disabled="busy" @click="step = 1">返回修改</van-button><van-button block type="primary" :loading="busy" @click="save">{{ session.role === 'admin' ? '确认新增' : '提交审核' }}</van-button></div></template>
    </van-popup>
  </div>
</template>
