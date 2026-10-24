<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { DatePicker as VanDatePicker, Picker as VanPicker, showConfirmDialog, showToast, type PickerConfirmEventParams } from 'vant'
import { session } from '../session'
import { emptyRecordFields, findRecord, fieldsOf, createRecord, updateRecord, addRecordVersion, validateRecordAttachment, recordCategories, type RecordKind, type RecordFields } from '../stores/records'
import DemoUpload from '../components/DemoUpload.vue'
import { pendingMediaWrites, type MediaRef } from '../media'

const route = useRoute(); const router = useRouter()
const kind = computed<RecordKind>(() => route.params.kind === 'employee' ? 'employee' : 'company')
const existing = computed(() => { const row = route.params.id ? findRecord(String(route.params.id)) : undefined; return row?.scope === kind.value ? row : undefined })
const editing = computed(() => !!route.params.id)
const fields = reactive<RecordFields>(emptyRecordFields())
const files = ref<MediaRef[]>([]); const versionNote = ref(''); const error = ref(''); const submitting = ref(false); const saved = ref(false)
const baseline = ref('')
watch(() => `${kind.value}:${route.params.id || ''}`, () => {
  Object.assign(fields, existing.value ? fieldsOf(existing.value) : emptyRecordFields())
  if (kind.value === 'employee') { fields.category = '健康证'; fields.expiry_mode = 'date' }
  files.value = []; versionNote.value = ''; error.value = ''; saved.value = false
  baseline.value = JSON.stringify(fields)
}, { immediate: true })
const dirty = computed(() => JSON.stringify(fields) !== baseline.value || files.value.length > 0 || !!versionNote.value)
const dateField = ref<'issue_date' | 'expiry_date'>('expiry_date'); const dateShow = ref(false)
const dateParts = ref<string[]>([])
function openDate(key: 'issue_date' | 'expiry_date') { dateField.value = key; dateParts.value = (fields[key] || new Date().toLocaleDateString('sv-SE')).split('-'); dateShow.value = true }
function confirmDate({ selectedValues }: PickerConfirmEventParams) { fields[dateField.value] = selectedValues.join('-'); dateShow.value = false }
const pickerShow = ref(false); const pickerKind = ref<'category' | 'expiry_mode'>('category')
const pickerValue = ref<string[]>([])
const pickerColumns = computed(() => pickerKind.value === 'category' ? recordCategories.map(v => ({ text: v, value: v })) : [{ text: '指定日期', value: 'date' }, { text: '长期有效', value: 'longterm' }, { text: '待确认', value: 'unknown' }])
const modeText = computed(() => ({ date: '指定日期', longterm: '长期有效', unknown: '待确认' }[fields.expiry_mode]))
function openPicker(key: 'category' | 'expiry_mode') { pickerKind.value = key; pickerValue.value = [fields[key]]; pickerShow.value = true }
function confirmPicker({ selectedValues }: PickerConfirmEventParams) { Object.assign(fields, { [pickerKind.value]: String(selectedValues[0]) }); pickerShow.value = false }
async function submit() {
  if (submitting.value) return
  if (pendingMediaWrites.value > 0) { error.value = '附件正在保存到本机，请完成后再提交'; return }
  error.value = ''; submitting.value = true
  try {
    if (kind.value === 'employee') fields.name = `${fields.holder.trim()} 的健康证`
    if (editing.value) { if (!existing.value) throw new Error('资料不存在或无权编辑'); updateRecord(existing.value.id, fields) }
    else {
      if (files.value[0]) validateRecordAttachment(files.value[0])
      const row = createRecord(kind.value, fields)
      if (files.value[0]) addRecordVersion(row.id, files.value[0], versionNote.value)
      saved.value = true
      showToast(session.role === 'admin' ? '资料已保存并生效' : '资料已提交，等待管理员审核')
      await router.replace(`/records/${kind.value}/${row.id}`); return
    }
    saved.value = true; showToast(session.role === 'admin' ? '资料修改已生效' : '修改已提交，原内容保持生效')
    await router.replace(`/records/${kind.value}/${existing.value!.id}`)
  } catch (e) { error.value = e instanceof Error ? e.message : '未能保存，请重试' }
  finally { submitting.value = false }
}
onBeforeRouteLeave(async () => {
  if (saved.value) return true
  if (pendingMediaWrites.value > 0 || submitting.value) return false
  if (!dirty.value) return true
  try { await showConfirmDialog({ title: '放弃本次编辑？', message: '尚未提交的表单内容将不会保存。', confirmButtonText: '放弃编辑', cancelButtonText: '继续编辑' }); return true } catch { return false }
})
</script>

<template>
  <div v-if="!editing || existing" class="page form-page">
    <div class="page-heading"><div><h1>{{ editing ? '编辑资料' : (kind === 'company' ? '新增企业证照' : '新增员工健康证') }}</h1><p>{{ session.role === 'admin' ? '保存后直接生效' : editing ? '审核前保留原有生效内容' : '提交后由管理员审核' }}</p></div></div>
    <van-form @submit="submit" :disabled="submitting || pendingMediaWrites > 0">
      <van-cell-group inset>
        <van-field v-if="kind === 'employee'" v-model="fields.holder" name="holder" label="员工姓名" placeholder="填写健康证上的姓名" required maxlength="80" :rules="[{ required: true, message: '请填写员工姓名' }]" />
        <van-field v-else v-model="fields.name" name="name" label="资料名称" placeholder="填写证照或资料名称" required maxlength="200" :rules="[{ required: true, message: '请填写资料名称' }]" />
        <van-field v-if="kind === 'company'" :model-value="fields.category" label="资料分类" readonly is-link @click="openPicker('category')" />
        <van-field v-if="kind === 'company'" v-model="fields.cert_type" label="证件类型" placeholder="选填" maxlength="100" />
        <van-field v-model="fields.cert_no" label="证件编号" placeholder="选填" maxlength="100" />
        <van-field v-model="fields.issuer" label="签发单位" placeholder="选填" maxlength="200" />
        <van-field v-if="kind === 'company'" v-model="fields.holder" label="持有人" placeholder="选填" maxlength="100" />
        <van-field v-if="kind === 'company'" v-model="fields.keeper" label="保管人" placeholder="选填" maxlength="100" />
        <van-field :model-value="fields.issue_date" label="签发日期" placeholder="选填，点击选择" readonly is-link @click="openDate('issue_date')" />
        <van-field v-if="fields.issue_date" label="清除签发日"><template #input><van-button native-type="button" size="small" plain @click="fields.issue_date = ''">清除日期</van-button></template></van-field>
        <van-field v-if="kind === 'company'" :model-value="modeText" label="有效期类型" readonly is-link @click="openPicker('expiry_mode')" />
        <van-field v-if="fields.expiry_mode === 'date'" :model-value="fields.expiry_date" name="expiry_date" label="有效期至" placeholder="请选择到期日期" readonly is-link required :rules="[{ required: true, message: '请选择有效期至' }]" @click="openDate('expiry_date')" />
        <van-field v-model.number="fields.remind_days" label="提醒天数" type="digit" :rules="[{ validator: (v: string) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 3650, message: '请输入 0–3650 的整数' }]" />
        <van-field v-model="fields.paper_location" label="纸质存放" placeholder="选填，便于找原件" maxlength="200" />
        <van-field v-model="fields.note" label="备注" type="textarea" rows="3" autosize maxlength="2000" show-word-limit placeholder="选填" />
      </van-cell-group>
      <p class="section-caption">提醒天数按原字段保留；当前列表仍沿用原项目“15天内到期”提醒档位。</p>
      <section v-if="!editing" class="section file-section"><div class="section-heading"><h2>首个附件 · 选填</h2></div><DemoUpload v-model="files" accept=".jpg,.jpeg,.png,.pdf,.doc,.docx,.xls,.xlsx" :max-count="1" :disabled="submitting || pendingMediaWrites > 0" label="选择资料附件" /><van-field v-if="files.length" v-model="versionNote" label="版本说明" placeholder="选填" maxlength="500" /><p class="section-caption">支持图片、PDF、Word、Excel，单文件不超过20MB；附件独立记录版本。</p></section>
      <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
      <div class="form-actions"><van-button block plain native-type="button" :disabled="submitting || pendingMediaWrites > 0" @click="router.push(editing && existing ? `/records/${kind}/${existing.id}` : `/records/${kind}`)">取消</van-button><van-button block type="primary" native-type="submit" :loading="submitting" :disabled="pendingMediaWrites > 0">{{ session.role === 'admin' ? '保存并生效' : '提交审核' }}</van-button></div>
    </van-form>
    <van-popup v-model:show="dateShow" position="bottom" round safe-area-inset-bottom><VanDatePicker v-model="dateParts" :title="dateField === 'issue_date' ? '选择签发日期' : '选择有效期至'" :min-date="new Date(1970, 0, 1)" :max-date="new Date(2100, 11, 31)" @confirm="confirmDate" @cancel="dateShow = false" /></van-popup>
    <van-popup v-model:show="pickerShow" position="bottom" round safe-area-inset-bottom><VanPicker v-model="pickerValue" :title="pickerKind === 'category' ? '选择资料分类' : '选择有效期类型'" :columns="pickerColumns" @confirm="confirmPicker" @cancel="pickerShow = false" /></van-popup>
  </div>
  <van-empty v-else description="资料不存在或当前账户无权编辑"><van-button :to="`/records/${kind}`" type="primary">返回列表</van-button></van-empty>
</template>
