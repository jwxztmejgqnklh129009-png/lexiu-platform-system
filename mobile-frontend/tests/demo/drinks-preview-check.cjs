// Cases: readable-image ordering, first/last/single-page disabled buttons, formal
// prev/next delegation, touch-change/close synchronization, selected-page start,
// unreadable-page feedback and skipped-page mapping. This mounts the actual SFC
// and actual Vant Button on a Vue memory renderer. ImagePreview is a narrow test
// double of the locally verified formal props/events/ref API; real touch/zoom and
// browser layout are covered separately by the root agent's browser acceptance.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const project = path.resolve(__dirname, '../..')
const projectRequire = createRequire(path.join(project, 'package.json'))
const ts = projectRequire('typescript')
const compiler = projectRequire('@vue/compiler-sfc')
const vue = projectRequire('vue')
const vant = projectRequire('vant')
const filename = path.join(project, 'src/pages/DrinksPage.vue')
const descriptor = compiler.parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
const script = compiler.compileScript(descriptor, { id: 'drinks-preview-test' })
const template = compiler.compileTemplate({ id: 'drinks-preview-test', source: descriptor.template.content, filename, compilerOptions: { bindingMetadata: script.bindings } })
assert.equal(template.errors.length, 0)
const records = []

async function mountPage(count = 2, broken = []) {
  const calls = [], toasts = []
  let preview
  const pages = vue.ref(Array.from({ length: count }, (_, i) => ({ id: `page-${i + 1}`, title: `演示页${i + 1}`, image: { id: `image-${i + 1}` } })))
  const Preview = vue.defineComponent({
    props: ['show', 'images', 'startPosition', 'loop', 'closeable', 'showIndex', 'maxZoom', 'minZoom', 'doubleScale', 'closeOnClickImage'],
    emits: ['change', 'close', 'closed', 'update:show'],
    setup(props, { emit, slots, expose }) {
      let index = 0
      const change = target => { index = target; emit('change', index) }
      const api = {
        prev() { calls.push('prev'); change(Math.max(0, index - 1)) },
        next() { calls.push('next'); change(Math.min(props.images.length - 1, index + 1)) },
        touchTo: change,
        closeAt(target = index) { index = target; emit('update:show', false); emit('close', { index }); emit('closed') },
        props,
      }
      preview = api
      expose(api)
      vue.watch(() => props.show, show => { if (show) index = Number(props.startPosition) })
      return () => props.show ? vue.h('preview', {}, slots.cover?.()) : null
    },
  })
  const passthrough = tag => vue.defineComponent({ setup: (_, { attrs, slots }) => () => vue.h(tag, attrs, slots.default?.()) })
  const fakeVant = { ...vant, ImagePreview: Preview, Image: passthrough('image'), Pagination: passthrough('pagination'), showToast: message => toasts.push(message) }
  function evaluate(code) {
    const module = { exports: {} }
    const output = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const require = name => name === 'vue' ? vue : name === 'vant' ? fakeVant : name.endsWith('stores/drinks') ? { drinkPages: pages, drinkNote: vue.ref('演示说明') } : name.endsWith('/media') ? { getMediaUrl: async file => { if (broken.includes(Number(file.id.split('-')[1]))) throw new Error('isolated unreadable image'); return `memory:${file.id}` } } : name.endsWith('.css') ? {} : projectRequire(name)
    class TestImage { naturalWidth = 600; set src(value) { queueMicrotask(() => this.onload?.()) } }
    vm.runInNewContext(output, { module, exports: module.exports, require, Image: TestImage, console }, { filename })
    return module.exports
  }
  const component = evaluate(script.content).default
  component.render = evaluate(template.code).render
  const node = (type, text = '') => ({ type, text, props: {}, children: [], parent: null })
  const renderer = vue.createRenderer({
    createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
    setText: (target, text) => { target.text = text }, setElementText: (target, text) => { target.text = text; target.children = [] },
    patchProp: (target, key, _old, value) => { target.props[key] = value },
    parentNode: target => target.parent, nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] || null,
    insert(target, parent, anchor) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); target.parent = parent; const at = anchor ? parent.children.indexOf(anchor) : -1; if (at < 0) parent.children.push(target); else parent.children.splice(at, 0, target) },
    remove(target) { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); target.parent = null },
  })
  const root = node('root')
  const app = renderer.createApp(component)
  app.component('van-button', vant.Button)
  app.component('van-icon', passthrough('icon'))
  app.component('van-empty', passthrough('empty'))
  app.component('van-notice-bar', passthrough('notice'))
  const instance = app.mount(root)
  const state = instance.$.setupState
  const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await vue.nextTick() }
  const button = label => {
    function find(target) { if (target.type === 'button' && target.props['aria-label'] === label) return target; for (const child of target.children) { const found = find(child); if (found) return found } }
    return find(root)
  }
  await flush()
  return {
    state, calls, toasts, get preview() { return preview }, button, flush,
    async open() { await state.previewImage(); await flush() },
    async click(label) { const target = button(label); assert.ok(target, `Native Vant button ${label} must exist`); target.props.onClick({ stopPropagation() {}, preventDefault() {} }); await flush() },
    unmount: () => app.unmount(),
  }
}

async function check(name, fn) { try { await fn(); records.push({ name, passed: true }) } catch (error) { records.push({ name, passed: false, error: error.message }) } }
async function main() {
  await check('正式组件参数保留触摸、页码、关闭及1–5倍缩放', async () => {
    const app = await mountPage(); await app.open()
    const props = app.preview.props
    assert.equal(props.images.length, 2); assert.equal(props.loop, false); assert.equal(props.closeable, ''); assert.equal(props.showIndex, ''); assert.equal(props.minZoom, 1); assert.equal(props.maxZoom, 5); assert.equal(props.doubleScale, ''); assert.equal(props.closeOnClickImage, false)
    app.unmount()
  })
  await check('第一页：原生Vant上一页禁用，下一页可用', async () => {
    const app = await mountPage(); await app.open()
    assert.equal(app.button('酒水单大图上一页').props.disabled, true); assert.equal(app.button('酒水单大图下一页').props.disabled, false)
    await app.click('酒水单大图上一页'); assert.equal(app.calls.length, 0); app.unmount()
  })
  await check('下一页委托正式next接口并同步页码，末页禁用下一页', async () => {
    const app = await mountPage(); await app.open(); await app.click('酒水单大图下一页')
    assert.deepEqual(app.calls, ['next']); assert.equal(app.state.pageNumber, 2); assert.equal(app.button('酒水单大图上一页').props.disabled, false); assert.equal(app.button('酒水单大图下一页').props.disabled, true)
    await app.click('酒水单大图下一页'); assert.deepEqual(app.calls, ['next']); app.unmount()
  })
  await check('上一页委托正式prev接口，回到第一页后正确禁用', async () => {
    const app = await mountPage(); await app.open(); await app.click('酒水单大图下一页'); await app.click('酒水单大图上一页')
    assert.deepEqual(app.calls, ['next', 'prev']); assert.equal(app.state.pageNumber, 1); assert.equal(app.button('酒水单大图上一页').props.disabled, true); app.unmount()
  })
  await check('触摸change及关闭事件都同步列表当前页', async () => {
    const app = await mountPage(3); await app.open(); app.preview.touchTo(1); await app.flush()
    assert.equal(app.state.pageNumber, 2); app.preview.closeAt(2); await app.flush(); assert.equal(app.state.pageNumber, 3); assert.equal(app.state.previewOpen, false); app.unmount()
  })
  await check('从列表第2页打开时正确选中，并能向前翻页', async () => {
    const app = await mountPage(); app.state.pageNumber = 2; await app.flush(); await app.open()
    assert.equal(app.preview.props.startPosition, 1); assert.equal(app.state.previewIndex, 1); assert.equal(app.button('酒水单大图下一页').props.disabled, true)
    await app.click('酒水单大图上一页'); assert.equal(app.state.pageNumber, 1); app.unmount()
  })
  await check('中间页读取失败：明确提示、仅展示可读图且映射真实页码', async () => {
    const app = await mountPage(3, [2]); await app.open(); assert.match(app.state.previewWarning, /第2页.*无法读取/); assert.equal(app.preview.props.images.length, 2)
    await app.click('酒水单大图下一页'); assert.equal(app.state.pageNumber, 3); assert.equal(app.button('酒水单大图下一页').props.disabled, true); app.unmount()
  })
  await check('仅1张图：两个正式按钮均禁用', async () => {
    const app = await mountPage(1); await app.open(); assert.equal(app.button('酒水单大图上一页').props.disabled, true); assert.equal(app.button('酒水单大图下一页').props.disabled, true); app.unmount()
  })
  await check('全部图片读取失败：反馈错误，不打开空预览', async () => {
    const app = await mountPage(2, [1, 2]); app.state.imageUrl = 'memory:already-cached-image'; app.state.imageFailed = false; await app.open()
    assert.match(app.state.previewWarning, /均无法读取/); assert.equal(app.state.previewOpen, false); assert.ok(app.toasts.length); app.unmount()
  })
  const result = { scope: 'Actual DrinksPage SFC/script/template, actual Vue and Vant Button; Vue memory renderer; ImagePreview formal API test double; no browser, backend or real media', total: records.length, passed: records.filter(row => row.passed).length, failed: records.filter(row => !row.passed).length, records }
  fs.writeFileSync(path.join(__dirname, 'drinks-preview-results.json'), JSON.stringify(result, null, 2))
  process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = result.failed ? 1 : 0
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
