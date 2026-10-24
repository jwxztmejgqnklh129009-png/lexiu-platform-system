<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { session } from '../session'
import { pendingMediaWrites, type MediaRef } from '../media'
import DemoUpload from '../components/DemoUpload.vue'
import MediaGallery from '../components/MediaGallery.vue'
import { categories, visibleInventory, createItem, editItem, addItemImage, validateDraft, getExpiry, type ItemDraft } from '../stores/warehouse'
import '../warehouse.css'
const route = useRoute(); const router = useRouter()
const editing = computed(() => !!route.params.id)
const source = computed(() => visibleInventory.value.find(item => item.id === Number(route.params.id)))
const allowed = computed(() => !editing.value || (session.role === 'admin' && !!source.value))
function emptyDraft(): ItemDraft { return { name: '', category: '其它', spec: '', unit: '个', quantity: 0, safety_stock: 0, expiry_mode: 'date', expiry_date: '', warn_days: 15, location: '', note: '' } }
const draft = reactive<ItemDraft>(emptyDraft())
const initial = ref(''); const files = ref<MediaRef[]>([]); const step = ref(1); const error = ref(''); const busy = ref(false); const saved = ref(false)
// Vant Field emits numeric inputs as strings; blank input must still differ from 0.
function comparableNumber(value: unknown) { return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : value }
function draftSnapshot() { return JSON.stringify({ ...draft, quantity: comparableNumber(draft.quantity), safety_stock: comparableNumber(draft.safety_stock), warn_days: comparableNumber(draft.warn_days) }) }
watch(() => String(route.params.id || ''), () => {
  const item = source.value
  Object.assign(draft, item ? { name: item.name, category: item.category, spec: item.spec, unit: item.unit, quantity: item.quantity, safety_stock: item.safety_stock, expiry_mode: item.expiry_mode, expiry_date: item.expiry_date, warn_days: item.warn_days, location: item.location, note: item.note } : emptyDraft())
  files.value = []; step.value = 1; error.value = ''; busy.value = false; saved.value = false; initial.value = draftSnapshot()
}, { immediate: true })
const dirty = computed(() => draftSnapshot() !== initial.value || files.value.length > 0)
const uploading = computed(() => pendingMediaWrites.value > 0)
const nonNegative = (value: string | number) => value !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= 0
function payload(): ItemDraft { return { ...draft, quantity: Number(draft.quantity), safety_stock: Number(draft.safety_stock), warn_days: Number(draft.warn_days) } }
function mediaReady() { if (!uploading.value) return true; error.value = '图片正在保存到本机，请等待完成后继续。'; return false }
function prepare() { error.value = ''; if (!mediaReady()) return; try { validateDraft(payload()); step.value = 2; window.scrollTo({ top: 0 }) } catch (e) { error.value = e instanceof Error ? e.message : '请核对输入' } }
async function save() {
  if (busy.value || !allowed.value || !mediaReady()) return; busy.value = true; error.value = ''
  try { const data = payload(); let id: number; if (editing.value) { id = source.value!.id; editItem(id, data) } else id = createItem(data)
    if (!editing.value && files.value[0]) addItemImage(id, files.value[0]); saved.value = true; showToast(editing.value ? '档案已保存在本机，库存未改动' : session.role === 'admin' ? '物品已在本机生效' : '已在本机提交待审核'); await router.replace(`/inventory/${id}`)
  } catch (e) { error.value = e instanceof Error ? e.message : '保存失败，请重试' } finally { busy.value = false }
}
async function canLeave() { if (!mediaReady()) return false; if (saved.value || !dirty.value) return true; try { await showConfirmDialog({ title: '放弃未保存内容？', message: '离开后本次填写和选择不会保存。', confirmButtonText: '放弃并离开', cancelButtonText: '继续填写' }); return mediaReady() } catch { return false } }
onBeforeRouteLeave(canLeave)
onBeforeRouteUpdate((to, from) => String(to.params.id || '') === String(from.params.id || '') ? true : canLeave())
</script>
<template>
  <div v-if="allowed" class="page form-page warehouse-page">
    <div class="page-heading"><div><h1>{{ editing ? '编辑物品档案' : '新增仓库物品' }}</h1><p class="heading-note">{{ step === 1 ? '1 / 2 填写信息' : '2 / 2 核对并确认' }}</p></div><van-tag plain>{{ session.role === 'admin' ? '直接生效' : '需管理员审核' }}</van-tag></div>
    <van-notice-bar v-if="error" wrapable :scrollable="false" :text="error" />
    <van-form v-if="step === 1" scroll-to-error @submit="prepare">
      <van-cell-group inset><van-field v-model="draft.name" label="物品名称" name="name" required placeholder="例如：啤酒 / 纸巾" maxlength="200" :rules="[{ required: true, message: '请填写物品名称' }]" /><van-field label="分类" label-align="top"><template #input><van-radio-group v-model="draft.category" direction="horizontal" class="warehouse-radio"><van-radio v-for="category in categories" :key="category" :name="category">{{ category }}</van-radio></van-radio-group></template></van-field><van-field v-model="draft.spec" label="规格" placeholder="例如：330mL / 瓶" maxlength="200" /><van-field v-model="draft.unit" label="单位" required placeholder="瓶 / 包 / 个" maxlength="10" :rules="[{ required: true, message: '请填写单位' }]" /><van-cell v-if="editing" title="当前库存" :value="`${source?.quantity}${draft.unit}`" label="数量通过入库、出库或盘点登记，在这里不可修改。" /><van-field v-else v-model="draft.quantity" type="digit" label="期初数量" name="quantity" required :rules="[{ validator: nonNegative, message: '期初数量必须是非负整数' }]" /><van-field v-model="draft.safety_stock" type="digit" label="安全库存" name="safety" :rules="[{ validator: nonNegative, message: '安全库存必须是非负整数' }]" /></van-cell-group><p class="section-caption">库存低于安全库存时提醒补货；填0表示不提醒。数量均按填写的单位登记。</p>
      <section class="section warehouse-gap"><div class="section-heading"><h2>有效期与存放</h2></div><van-cell-group inset><van-field label="有效期方式" label-align="top"><template #input><van-radio-group v-model="draft.expiry_mode" class="warehouse-radio"><van-radio name="date">有明确到期日</van-radio><van-radio name="longterm">长期有效</van-radio><van-radio name="unknown">暂不确定</van-radio></van-radio-group></template></van-field><van-field v-if="draft.expiry_mode === 'date'" v-model="draft.expiry_date" type="date" label="到期日期" name="expiry_date" required :rules="[{ required: true, message: '请选择到期日期' }]" /><van-field v-if="editing" v-model="draft.warn_days" label="提前提醒天数" type="digit" :rules="[{ validator: (v: string | number) => nonNegative(v) && Number(v) <= 3650, message: '请输入0至3650的整数' }]" /><van-field v-model="draft.location" label="存放位置" placeholder="例如：酒水仓 A02" maxlength="200" /><van-field v-model="draft.note" label="备注" type="textarea" rows="2" maxlength="200" show-word-limit placeholder="选填，说明登记口径或注意事项" /></van-cell-group></section>
      <section v-if="!editing" class="section warehouse-gap"><div class="section-heading"><h2>物品图片（选填）</h2></div><DemoUpload v-model="files" accept="image/jpeg,image/png" :max-count="1" :max-size="15 * 1024 * 1024" label="选择JPG / PNG图片" /><p class="section-caption">每张不超过15MB，可先建档后补传。员工提交的物品档案和图片分别审核。</p></section>
      <van-button block type="primary" native-type="submit" class="secondary-wide" :disabled="uploading">下一步：核对信息</van-button>
    </van-form>
    <template v-else><van-cell-group inset><van-cell title="名称" :value="draft.name" /><van-cell title="分类" :value="draft.category" /><van-cell title="规格" :value="draft.spec || '未填写'" /><van-cell title="单位" :value="draft.unit" /><van-cell :title="editing ? '当前库存（不修改）' : '期初数量'" :value="`${editing ? source?.quantity : draft.quantity}${draft.unit}`" /><van-cell title="安全库存" :value="`${draft.safety_stock}${draft.unit}`" /><van-cell title="有效期" :value="getExpiry(draft).label" /><van-cell title="位置" :value="draft.location || '未填写'" /><van-cell v-if="draft.note" title="备注" :label="draft.note" /></van-cell-group><MediaGallery v-if="files.length" :files="files" compact /><p class="section-caption">{{ session.role === 'admin' ? '确认后在本机演示生效。' : '确认后在本机提交审核，通过前仅本人和管理员可见。' }}</p><div class="popup-actions"><van-button block plain :disabled="busy || uploading" @click="step = 1">返回修改</van-button><van-button block type="primary" :loading="busy" :disabled="uploading" @click="save">{{ editing ? '保存档案' : session.role === 'admin' ? '确认新增' : '提交审核' }}</van-button></div></template>
  </div><div v-else class="page"><van-empty description="物品不存在或当前账号无权编辑"><van-button to="/inventory" type="primary">返回仓库</van-button></van-empty></div>
</template>
