// Run from mobile-frontend: node tests/demo/record-form-router-regression.mjs
// Mount the real RecordForm SFC setup with the real memory router. Only visual
// rendering, toast/dialog presentation and browser storage are replaced.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse, compileScript } from '@vue/compiler-sfc'
import { rolldown } from 'rolldown'

process.on('uncaughtException', error => {
  console.error(String(error.stack || error).split('\n').filter(line => !line.includes('data:text/javascript')).join('\n'))
  process.exit(1)
})

const memoryStorage = () => {
  const rows = new Map()
  return { getItem: key => rows.get(key) || null, setItem: (key, value) => rows.set(key, value) }
}
globalThis.localStorage = memoryStorage()
globalThis.sessionStorage = memoryStorage()
globalThis.window = { addEventListener() {} }

const root = process.cwd().replaceAll('\\', '/')
const entry = 'virtual:record-form-regression'
const bundle = await rolldown({
  input: entry,
  platform: 'node',
  plugins: [{
    name: 'real-sfc-router-test',
    resolveId(id) {
      if (id === entry || id === 'virtual:vant-presentation') return id
      if (id === 'vant') return 'virtual:vant-presentation'
      if (id.endsWith('/DemoUpload.vue')) return 'virtual:upload-presentation'
    },
    async load(id) {
      if (id === entry) return `
        export { createRenderer, h, nextTick } from 'vue';
        export { createRouter, createMemoryHistory, RouterView, isNavigationFailure, NavigationFailureType } from 'vue-router';
        export { default as RecordForm } from '${root}/src/pages/RecordForm.vue';
        export { session } from '${root}/src/session.ts';
        export { pendingMediaWrites } from '${root}/src/media.ts';
        export { records, recordEdits, resetRecords } from '${root}/src/stores/records.ts';
      `
      if (id === 'virtual:vant-presentation') return `
        export const DatePicker = {render:()=>null};
        export const Picker = {render:()=>null};
        export const showToast = ()=>{};
        export const showConfirmDialog = ()=>Promise.reject('cancel');
      `
      if (id === 'virtual:upload-presentation') return 'export default {render:()=>null}'
      if (id.endsWith('.vue')) {
        const { descriptor } = parse(await readFile(id, 'utf8'), { filename: id })
        const script = compileScript(descriptor, { id: 'record-form-router-regression', genDefaultAs: '__realSfc' })
        // Retain the real SFC setup, refs, methods and lifecycle/router guards.
        // Template layout is intentionally outside this nonbrowser regression.
        return { code: `${script.content}\n__realSfc.render=()=>null;export default __realSfc;`, moduleType: 'ts' }
      }
    },
  }],
})
try {
  const output = await bundle.generate({ format: 'es' })
  const chunk = output.output.find(row => row.type === 'chunk')
  const m = await import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`)
  const renderer = m.createRenderer({
    createElement: tag => ({ tag, children: [] }), createText: text => ({ text }),
    createComment: text => ({ text }), setElementText() {}, setText() {},
    patchProp() {},
    insert(child, parent, anchor) {
      if (child.parent) child.parent.children = child.parent.children.filter(row => row !== child)
      child.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index < 0) parent.children.push(child)
      else parent.children.splice(index, 0, child)
    },
    remove(child) { if (child.parent) child.parent.children = child.parent.children.filter(row => row !== child) },
    parentNode: child => child.parent || null,
    nextSibling: child => child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
  })
  const router = m.createRouter({ history: m.createMemoryHistory(), routes: [
    { path: '/records/:kind/new', component: m.RecordForm },
    { path: '/records/:kind/:id/edit', component: m.RecordForm },
    { path: '/records/:kind/:id', component: { render: () => null } },
    { path: '/outside', component: { render: () => null } },
  ] })
  m.resetRecords()
  Object.assign(m.session, { role: 'staff', accountId: 'staff-demo', name: '演示员工A', signedIn: true })
  await router.push('/records/company/new')
  await router.isReady()
  const app = renderer.createApp({ render: () => m.h(m.RouterView) })
  app.use(router)
  app.mount({ children: [] })
  await m.nextTick()
  let assertions = 0
  const check = fn => { fn(); assertions++ }
  const form = () => {
    const instance = router.currentRoute.value.matched.at(-1).instances.default
    assert.ok(instance, 'actual RouterView must have mounted RecordForm')
    return instance.$.setupState
  }
  const aborted = value => m.isNavigationFailure(value, m.NavigationFailureType.aborted)

  // Uploading cannot leave or submit, even when the empty form is not dirty.
  m.pendingMediaWrites.value = 1
  const awaitedFailure = await router.push('/outside')
  check(() => assert.equal(aborted(awaitedFailure), true))
  let state = form()
  const beforeUploadAttempt = m.records.value.length
  await state.submit()
  check(() => assert.equal(m.records.value.length, beforeUploadAttempt))
  check(() => assert.match(state.error, /正在保存/))
  m.pendingMediaWrites.value = 0

  // An unsaved in-flight submit remains protected.
  state.submitting = true; state.saved = false
  const submittingFailure = await router.push('/outside')
  check(() => assert.equal(aborted(submittingFailure), true))
  state.submitting = false

  // Actual SFC submit creates once and must navigate through its own guard.
  Object.assign(state.fields, { name: '路由回归新增资料', expiry_date: '2030-01-01' })
  const beforeCreate = m.records.value.length
  const first = state.submit()
  const duplicateClick = state.submit()
  await Promise.all([first, duplicateClick])
  await m.nextTick()
  check(() => assert.equal(m.records.value.length, beforeCreate + 1))
  const created = m.records.value.find(row => row.name === '路由回归新增资料')
  check(() => assert.equal(router.currentRoute.value.path, `/records/company/${created.id}`))
  check(() => assert.equal(router.currentRoute.value.matched.at(-1).components.default === m.RecordForm, false))

  // Employee edit also leaves the form after saving an application, while the
  // existing live data remains unchanged until approval.
  await router.push('/records/company/company-license-demo/edit')
  await m.nextTick()
  state = form()
  const originalIssuer = state.fields.issuer
  state.fields.issuer = '路由回归修改单位'
  const beforeEdit = m.recordEdits.value.length
  await state.submit()
  await m.nextTick()
  check(() => assert.equal(m.recordEdits.value.length, beforeEdit + 1))
  check(() => assert.equal(router.currentRoute.value.path, '/records/company/company-license-demo'))
  check(() => assert.equal(m.records.value.find(row => row.id === 'company-license-demo').issuer, originalIssuer))

  // Failed validation remains on the form and can be corrected without an
  // extra record being created; dirty cancel continues to block navigation.
  await router.push('/records/company/new')
  await m.nextTick()
  state = form()
  const beforeFailure = m.records.value.length
  await state.submit()
  check(() => assert.equal(m.records.value.length, beforeFailure))
  check(() => assert.equal(router.currentRoute.value.path, '/records/company/new'))
  check(() => assert.equal(state.submitting, false))
  state.fields.name = '未保存草稿'
  const cancelFailure = await router.push('/outside')
  check(() => assert.equal(aborted(cancelFailure), true))
  check(() => assert.equal(router.currentRoute.value.path, '/records/company/new'))

  app.unmount()
  console.log(JSON.stringify({ passed: assertions, actualSfc: resolve('src/pages/RecordForm.vue'), realMemoryRouter: true, browserStorageAccessed: false }))
} finally { await bundle.close() }
