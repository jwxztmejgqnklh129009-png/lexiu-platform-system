<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { session } from '../session'
import { pendingMediaWrites, type MediaRef } from '../media'
import DemoUpload from '../components/DemoUpload.vue'
import MediaGallery from '../components/MediaGallery.vue'
import { visibleInventory, stockLogs, isLow, getExpiry, statusText, logActionText, moveStock, countStock, addItemImage, visibleImageVersions, canOpenImageVersion, removeItemImages, deleteItem } from '../stores/warehouse'
import '../warehouse.css'
const route = useRoute(); const router = useRouter()
const item = computed(() => visibleInventory.value.find(row => row.id === Number(route.params.id)))
const mode = ref<'in' | 'out' | 'count'>('in'); const showMove = ref(false)
const quantity = ref<number | string>(1); const supplier = ref(''); const note = ref(''); const operationError = ref(''); const busy = ref(false)
const baseline = ref({ quantity: 0, stock_log_id: 0 }); const conflicted = ref(false)
const imageFiles = ref<MediaRef[]>([]); const imageError = ref(''); const deleteOpen = ref(false); const deleteName = ref('')
const uploading = computed(() => pendingMediaWrites.value > 0)
const movementError = computed(() => {
  const n = Number(quantity.value)
  if (quantity.value === '' || !Number.isSafeInteger(n) || n < (mode.value === 'count' ? 0 : 1)) return mode.value === 'count' ? '实盘数量必须是非负整数' : '请输入大于0的整数数量'
  if (mode.value === 'out' && n > (item.value?.quantity || 0)) return '出库数量不能超过当前库存'
  return ''
})
const afterQuantity = computed(() => !item.value || movementError.value ? '—' : mode.value === 'count' ? Number(quantity.value) : item.value.quantity + (mode.value === 'in' ? Number(quantity.value) : -Number(quantity.value)))
const difference = computed(() => movementError.value ? '—' : Number(quantity.value) - baseline.value.quantity)
const logs = computed(() => stockLogs.value.filter(log => log.item_id === item.value?.id).slice(0, 100))
const versions = computed(() => item.value ? visibleImageVersions(item.value.id) : [])
const title = computed(() => mode.value === 'in' ? '采购入库' : mode.value === 'out' ? '消耗出库' : '单项盘点')
function openMove(action: 'in' | 'out' | 'count') { if (!item.value || item.value.status !== 'approved') return; mode.value = action; quantity.value = action === 'count' ? item.value.quantity : 1; supplier.value = ''; note.value = ''; operationError.value = ''; conflicted.value = false; baseline.value = { quantity: item.value.quantity, stock_log_id: item.value.stock_log_id }; showMove.value = true }
watch(() => route.query.action, action => { if (action === 'in' || action === 'out' || action === 'count') openMove(action) }, { immediate: true })
function closeMove() { showMove.value = false; if (route.query.action) router.replace({ path: route.path }) }
function cleanupMove() { if (!showMove.value && route.query.action) router.replace({ path: route.path }) }
function reloadBaseline() { if (!item.value) return; baseline.value = { quantity: item.value.quantity, stock_log_id: item.value.stock_log_id }; conflicted.value = false; operationError.value = ''; showToast('已更新账面，实盘输入保留，请重新清点核对') }
async function commitMove() {
  if (busy.value || movementError.value || !item.value) return
  operationError.value = ''; busy.value = true
  try {
    if (mode.value === 'count') {
      await showConfirmDialog({ title: '核对盘点结果', message: `账面 ${baseline.value.quantity}${item.value.unit}，实盘 ${quantity.value}${item.value.unit}，差异 ${difference.value}${item.value.unit}。确认已重新清点？`, confirmButtonText: '确认盘点' })
      countStock([{ id: item.value.id, actual: Number(quantity.value), expected_quantity: baseline.value.quantity, expected_stock_log_id: baseline.value.stock_log_id }], true)
    } else moveStock(item.value.id, mode.value, Number(quantity.value), supplier.value, note.value)
    closeMove(); showToast({ message: '演示登记完成，已保存在本机', icon: 'success' })
  } catch (error) { if (error instanceof Error) { operationError.value = error.message; conflicted.value = error.name === 'StocktakeConflict' } } finally { busy.value = false }
}
function mediaReady() { if (!uploading.value) return true; imageError.value = '图片正在保存到本机，请等待完成后继续。'; return false }
function saveImage() { if (!mediaReady() || !item.value || !imageFiles.value[0]) return; imageError.value = ''; try { const version = addItemImage(item.value.id, imageFiles.value[0]); imageFiles.value = []; showToast(version.status === 'pending' ? '本机图片已提交待审，当前图不变' : '图片已在本机生效') } catch (error) { imageError.value = error instanceof Error ? error.message : '图片未能保存，请重试' } }
async function removeImages() { if (!mediaReady() || !item.value) return; try { await showConfirmDialog({ title: '移除全部物品图片？', message: '将移除当前图和全部图片版本记录。仅影响本机演示。', confirmButtonText: '确认移除' }); if (!mediaReady()) return; removeItemImages(item.value.id); showToast('本机图片记录已移除') } catch (error) { if (error instanceof Error) showToast(error.message) } }
function submitDelete() { if (!item.value) return; try { deleteItem(item.value.id, deleteName.value); deleteOpen.value = false; router.replace('/inventory'); showToast('物品已从本机演示列表删除，流水保留') } catch (error) { showToast(error instanceof Error ? error.message : '删除失败') } }
</script>

<template>
  <div v-if="item" class="page detail-page warehouse-page">
    <div class="item-intro"><van-tag plain>{{ item.category }}</van-tag><h1>{{ item.name }}</h1><p>{{ item.spec || '未填规格' }} · {{ item.location || '未填位置' }}</p></div>
    <van-notice-bar v-if="item.status !== 'approved'" wrapable :scrollable="false" :text="item.status === 'pending' ? '物品待管理员审核，审核后才能入库、出库和盘点。' : `已退回：${item.reject_reason || '请联系管理员了解原因'}。可查看原登记内容。`" />
    <section class="stock-summary"><p>当前库存</p><div><strong>{{ item.quantity }}</strong><span>{{ item.unit }}</span></div><van-tag v-if="isLow(item)" plain type="warning">库存不足 · 安全库存 {{ item.safety_stock }}{{ item.unit }}</van-tag><span v-else class="muted">安全库存 {{ item.safety_stock }}{{ item.unit }}{{ item.safety_stock === 0 ? '（不提醒）' : '' }}</span></section>
    <div v-if="item.status === 'approved'" class="detail-actions"><van-button block plain type="primary" icon="arrow-down" @click="openMove('in')">采购入库</van-button><van-button block type="primary" icon="arrow-up" @click="openMove('out')">消耗出库</van-button><van-button block plain icon="balance-list-o" class="warehouse-wide" @click="openMove('count')">单项盘点</van-button></div>
    <section class="section"><div class="section-heading"><h2>物品档案</h2><van-button v-if="session.role === 'admin'" size="small" plain type="primary" :to="`/inventory/${item.id}/edit`">编辑档案</van-button></div><van-cell-group inset><van-cell title="分类" :value="item.category" /><van-cell title="规格" :value="item.spec || '未填写'" /><van-cell title="单位" :value="item.unit" /><van-cell title="存放位置" :value="item.location || '未填写'" /><van-cell title="有效期" :value="getExpiry(item).label" /><van-cell title="到期提醒" value="到期前15天内" /><van-cell title="审核状态"><template #value><van-tag plain :type="item.status === 'approved' ? 'success' : item.status === 'rejected' ? 'danger' : 'warning'">{{ statusText(item.status) }}</van-tag></template></van-cell><van-cell title="登记人" :value="item.created_name" /><van-cell v-if="item.note" title="备注" :label="item.note" /></van-cell-group></section>
    <section class="section"><div class="section-heading"><h2>物品图片</h2><van-button v-if="session.role === 'admin' && (item.current_image || versions.length)" size="small" plain type="danger" :disabled="uploading" @click="removeImages">移除图片</van-button></div><MediaGallery v-if="item.current_image" :files="[item.current_image]" /><p v-else class="quiet-empty">尚无生效图片。员工上传的新图片需审核后展示在这里。</p><DemoUpload v-model="imageFiles" accept="image/jpeg,image/png" :max-count="1" :max-size="15 * 1024 * 1024" label="选择物品图片（JPG / PNG，15MB内）" /><p v-if="imageError" class="warehouse-error" role="alert">{{ imageError }}</p><van-button v-if="imageFiles.length" block plain type="primary" :disabled="uploading" @click="saveImage">{{ session.role === 'admin' ? '确认在本机生效' : '提交图片审核' }}</van-button><p class="section-caption">仅在本机演示保存。{{ session.role === 'staff' ? '图片待审期间仍展示当前生效图片。' : '新图片生效后，原图片保留为历史版本。' }}</p></section>
    <section v-if="versions.length" class="section"><div class="section-heading"><h2>图片版本</h2></div><van-cell-group inset><template v-for="version in versions" :key="version.id"><van-cell :title="`第 ${version.version_no} 版 · ${version.file.name}`" :label="`${version.uploaded_name} · ${version.uploaded_at}${version.reject_reason ? `\n退回原因：${version.reject_reason}` : ''}`"><template #value><van-tag :type="version.status === 'approved' ? 'success' : version.status === 'rejected' ? 'danger' : version.status === 'pending' ? 'warning' : 'default'" plain>{{ version.status === 'approved' ? '当前有效' : statusText(version.status) }}</van-tag></template></van-cell><div class="warehouse-version-media"><MediaGallery v-if="canOpenImageVersion(version)" :files="[version.file]" compact /><p v-else class="section-caption">退回图片仅管理员可预览。</p></div></template></van-cell-group><van-button v-if="session.role === 'admin' && versions.some(v => v.status === 'pending')" block plain class="secondary-wide" to="/reviews">前往审核中心</van-button></section>
    <section class="section"><div class="section-heading"><h2>最近库存流水</h2><span class="muted">最多100条</span></div><van-cell-group v-if="logs.length" inset><van-cell v-for="log in logs" :key="log.id" :title="logActionText[log.action]" :label="`${log.at} · ${log.operator}\n结余 ${log.after_qty}${item.unit}${log.supplier ? `\n供应商：${log.supplier}` : ''}${log.note ? `\n${log.note}` : ''}`" :value="`${log.change_qty > 0 ? '+' : ''}${log.change_qty}${item.unit}`" /></van-cell-group><van-empty v-else description="还没有库存流水" /></section>
    <van-button v-if="session.role === 'admin'" block plain type="danger" class="secondary-wide" @click="deleteName = ''; deleteOpen = true">删除物品</van-button>
    <van-popup v-model:show="showMove" position="bottom" round closeable safe-area-inset-bottom :close-on-click-overlay="false" class="move-popup" @closed="cleanupMove">
      <h2 class="popup-title">{{ title }}</h2><p class="popup-subtitle">{{ item.name }} · {{ item.spec || item.unit }}</p><div class="move-preview"><span>{{ mode === 'count' ? '加载账面' : '当前' }} <strong>{{ mode === 'count' ? baseline.quantity : item.quantity }}</strong> {{ item.unit }}</span><van-icon name="arrow" /><span>{{ mode === 'count' ? '实盘结余' : '预计结余' }} <strong>{{ afterQuantity }}</strong> {{ item.unit }}</span></div>
      <van-notice-bar v-if="operationError" wrapable :scrollable="false" :text="operationError" /><van-button v-if="conflicted" block plain type="primary" class="warehouse-gap" @click="reloadBaseline">更新账面并重新核对</van-button>
      <van-form @submit="commitMove"><van-cell-group inset><van-field class="quantity-field" name="qty" label-align="top" :label="mode === 'count' ? '实际清点数量' : `${mode === 'in' ? '入库' : '出库'}数量`" required :error="!!movementError" :error-message="movementError || '数量按整数登记'"><template #input><van-stepper v-model="quantity" integer :min="mode === 'count' ? 0 : 1" :max="mode === 'out' ? item.quantity : undefined" :auto-fixed="false" allow-empty input-width="76px" button-size="44px" :aria-label="mode === 'count' ? '实际清点数量' : `${mode === 'in' ? '入库' : '出库'}数量`" /><span class="unit-label">{{ item.unit }}</span></template><template #error-message="{ message }"><span :class="{ 'quantity-hint': !movementError }" aria-live="polite">{{ message }}</span></template></van-field><van-cell v-if="mode === 'count'" title="盘点差异" :value="`${difference}${item.unit}`" /><van-field v-if="mode === 'in'" v-model="supplier" label="供应商" placeholder="选填" maxlength="200" /><van-field v-if="mode !== 'count'" v-model="note" label="备注" placeholder="选填，记录来源或用途" type="textarea" rows="2" maxlength="200" show-word-limit /></van-cell-group><p class="section-caption">确认后更新本机演示库存并记录流水，刷新会保留。{{ mode === 'count' ? '提交前将检查账面是否发生变化。' : '' }}</p><div class="popup-actions"><van-button block plain native-type="button" :disabled="busy" @click="closeMove">取消</van-button><van-button block type="primary" native-type="submit" :loading="busy" :disabled="!!movementError || conflicted">确认{{ mode === 'count' ? '盘点' : mode === 'in' ? '入库' : '出库' }}</van-button></div></van-form>
    </van-popup>
    <van-popup v-model:show="deleteOpen" position="bottom" round closeable safe-area-inset-bottom class="move-popup"><h2 class="popup-title">删除物品</h2><p class="popup-subtitle">将从本机列表移除“{{ item.name }}”及图片版本，库存流水保留。请手输完整物品名称确认。</p><van-form @submit="submitDelete"><van-field v-model="deleteName" label="物品名称" label-align="top" required :placeholder="item.name" :rules="[{ validator: (value: string) => value.trim() === item!.name, message: '名称不一致，未删除' }]" /><div class="popup-actions"><van-button block plain native-type="button" @click="deleteOpen = false">取消</van-button><van-button block type="danger" native-type="submit" :disabled="deleteName.trim() !== item.name">确认删除</van-button></div></van-form></van-popup>
  </div>
  <div v-else class="page"><van-empty description="物品不存在、已删除或当前账号无权查看"><van-button to="/inventory" type="primary">返回仓库</van-button></van-empty></div>
</template>
