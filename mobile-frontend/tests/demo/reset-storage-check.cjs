// Regression cases, written before the reset fix:
// 1. A successful reset persists every text store before clearing attachment bodies.
// 2. A previous storage warning is cleared before this attempt, not after its writes.
// 3. One failed text write rejects reset and preserves all attachment bodies.
// 4. Fully disabled text storage keeps the old durable records and their attachments.
// 5. Retrying after storage recovers succeeds and clears the previous warning.
// 6. An attachment-store failure rejects reset rather than reporting completion.
// Actual reset/persistence/stores and actual Vue are used with isolated memory storage.
// The IndexedDB boundary is replaced by a counted attachment map; no browser is opened.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const assert = require('node:assert/strict')
const { webcrypto } = require('node:crypto')
const project = path.resolve(__dirname, '../..')
const projectRequire = createRequire(path.join(project, 'package.json'))
const ts = projectRequire('typescript')
const records = []

function isolatedApp() {
  const values = new Map()
  const sessionValues = new Map()
  const attachments = new Map([['uploaded-demo-image', { body: 'isolated attachment body' }]])
  const cache = new Map()
  const writes = []
  let failWrite = () => false
  let mediaFailure = false
  let clears = 0
  let onClear = () => {}
  let persistence
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      writes.push({ key, warning: persistence?.storageProblem.value || '' })
      if (failWrite(key)) throw new Error('Isolated test quota/disabled storage')
      values.set(key, String(value))
    },
    removeItem: key => values.delete(key),
  }
  const media = {
    async clearMedia() {
      clears++
      onClear()
      if (mediaFailure) throw new Error('本机附件未清除，请重试。')
      attachments.clear()
    },
    async getMediaUrl() { throw new Error('Media URL access is outside this reset test') },
  }
  function load(filename) {
    if (!path.extname(filename)) filename += '.ts'
    if (filename === path.join(project, 'src/media.ts')) return media
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }
    cache.set(filename, module)
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const localRequire = specifier => specifier.startsWith('.') ? load(path.resolve(path.dirname(filename), specifier)) : projectRequire(specifier)
    vm.runInNewContext(compiled, { module, exports: module.exports, require: localRequire, crypto: webcrypto, TextEncoder, Uint8Array, console, window: { addEventListener() {} }, localStorage: storage, sessionStorage: { getItem: key => sessionValues.get(key) ?? null, setItem: (key, value) => sessionValues.set(key, String(value)) } }, { filename })
    return module.exports
  }
  const reset = load(path.join(project, 'src/reset.ts'))
  persistence = load(path.join(project, 'src/persistence.ts'))
  const storeSpecs = {
    warehouse: ['inventory', 'stockLogs', 'imageVersions', 'assets', 'assetLogs'],
    records: ['records', 'recordVersions', 'recordEdits'],
    fire: ['firePhotos', 'fireOrders'],
    drinks: ['drinkPages', 'drinkNote'],
    accounts: ['accounts'],
  }
  const refs = []
  for (const [moduleName, names] of Object.entries(storeSpecs)) {
    const store = load(path.join(project, `src/stores/${moduleName}.ts`))
    names.forEach(name => refs.push(store[name]))
  }
  refs.push(load(path.join(project, 'src/reviews.ts')).handledReviews)
  const expected = refs.map(state => JSON.stringify(state.value))
  refs.forEach(state => { state.value = Array.isArray(state.value) ? [...state.value, { id: 'old-reset-test-marker' }] : 'old reset test note' })
  const oldSaved = new Map(values)
  const expectedByKey = new Map([...values.keys()].map((key, index) => [key, expected[index]]))
  writes.length = 0
  return {
    reset: reset.resetDemo, warning: persistence.storageProblem, values, oldSaved, attachments, writes,
    refs, expected, get clears() { return clears },
    failWrites: predicate => { failWrite = predicate },
    failMedia: () => { mediaFailure = true },
    beforeMediaClear: fn => { onClear = fn },
    assertInitialText() {
      refs.forEach((state, index) => assert.ok(JSON.stringify(state.value) === expected[index], `Text store ${index} must hold its initial content`))
      assert.equal(values.size, refs.length)
      for (const [key, text] of expectedByKey) assert.ok(values.get(key) === text, `${key} must persist its initial content before clearing media`)
    },
  }
}

async function check(name, test) {
  try { await test(); records.push({ name, passed: true }) }
  catch (error) { records.push({ name, passed: false, error: error.message }) }
}
async function main() {
  await check('正常重置：文字落盘完成后才清附件', async () => {
    const app = isolatedApp()
    app.beforeMediaClear(() => { app.assertInitialText(); assert.equal(app.warning.value, ''); assert.equal(app.writes.length >= app.refs.length, true) })
    await app.reset()
    assert.equal(app.clears, 1); assert.equal(app.attachments.size, 0); app.assertInitialText()
  })
  await check('旧警告在本次写入前清除，成功后保持为空', async () => {
    const app = isolatedApp(); app.warning.value = '以前的存储提示'
    await app.reset()
    assert.equal(app.writes[0].warning, ''); assert.equal(app.warning.value, ''); assert.equal(app.clears, 1)
  })
  await check('单个文字键写入失败：拒绝完成、保留警告及附件', async () => {
    const app = isolatedApp(); const key = 'lexiu-demo-v1:record-versions'
    app.failWrites(candidate => candidate === key)
    await assert.rejects(app.reset, /文字记录.*未.*保存|文字记录.*保存.*失败/)
    assert.match(app.warning.value, /存储空间不足|禁用保存/); assert.equal(app.clears, 0); assert.equal(app.attachments.size, 1)
    assert.equal(app.values.get(key), app.oldSaved.get(key))
  })
  await check('全部文字保存被禁用：旧持久记录与附件仍配套保留', async () => {
    const app = isolatedApp(); app.failWrites(() => true)
    await assert.rejects(app.reset, /文字记录.*未.*保存|文字记录.*保存.*失败/)
    assert.deepEqual(app.values, app.oldSaved); assert.equal(app.clears, 0); assert.equal(app.attachments.size, 1); assert.notEqual(app.warning.value, '')
  })
  await check('写入恢复后重试：可以清附件且不被旧警告误拦', async () => {
    const app = isolatedApp(); app.failWrites(key => key === 'lexiu-demo-v1:record-versions')
    await assert.rejects(app.reset)
    app.failWrites(() => false); await app.reset()
    app.assertInitialText(); assert.equal(app.warning.value, ''); assert.equal(app.clears, 1); assert.equal(app.attachments.size, 0)
  })
  await check('附件清理失败：向调用方报错，不伪装成重置成功', async () => {
    const app = isolatedApp(); app.failMedia()
    await assert.rejects(app.reset, /附件未清除/)
    app.assertInitialText(); assert.equal(app.clears, 1); assert.equal(app.attachments.size, 1)
  })
  const result = { scope: 'Actual reset.ts, persistence.ts, business stores and Vue; isolated local/session storage; counted attachment map at media boundary; no browser or real data', total: records.length, passed: records.filter(record => record.passed).length, failed: records.filter(record => !record.passed).length, records }
  fs.writeFileSync(path.join(__dirname, 'reset-storage-results.json'), JSON.stringify(result, null, 2))
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  process.exitCode = result.failed ? 1 : 0
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
