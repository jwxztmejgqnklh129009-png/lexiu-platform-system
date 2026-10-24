// Runs the actual TypeScript stores with Vue and isolated, in-memory browser storage.
// It neither opens a browser nor reads any real browser or business data.
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const assert = require('node:assert/strict')
const { webcrypto } = require('node:crypto')
const project = path.resolve(__dirname, '../..')
const projectRequire = createRequire(path.join(project, 'package.json'))
const ts = projectRequire('typescript')
const values = new Map()
const sessionValues = new Map()
const memoryStorage = map => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) })
const cache = new Map()
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }
  cache.set(filename, module)
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const localRequire = specifier => specifier.startsWith('.') ? load(path.resolve(path.dirname(filename), specifier)) : projectRequire(specifier)
  const context = { module, exports: module.exports, require: localRequire, crypto: webcrypto, TextEncoder, Uint8Array, console, window: { addEventListener() {} }, localStorage: memoryStorage(values), sessionStorage: memoryStorage(sessionValues) }
  vm.runInNewContext(compiled, context, { filename })
  return module.exports
}
const records = []
async function check(name, fn) {
  try { await fn(); records.push({ name, passed: true }) }
  catch (error) { records.push({ name, passed: false, error: error.message }) }
}
async function rejects(fn, pattern) { await assert.rejects(async () => fn(), pattern) }

async function main() {
  const account = load(path.join(project, 'src/stores/accounts.ts'))
  const drinks = load(path.join(project, 'src/stores/drinks.ts'))
  const { session } = load(path.join(project, 'src/session.ts'))
  const image = { id: 'test-image', name: 'test.png', mime: 'image/png', size: 200 }
  await check('默认员工/管理员专用口令可登录', async () => { await account.login('staff', 'Demo1234!'); assert.equal(session.role, 'staff'); await account.login('admin', 'Demo1234!'); assert.equal(session.role, 'admin') })
  await check('错误口令与空账号拒绝', async () => { await rejects(() => account.login('admin', 'WrongDemo!'), /不正确/); await rejects(() => account.login('', 'Demo1234!'), /长度/) })
  await check('未登录及员工均不能创建账号', async () => { account.logout(); await rejects(() => account.createAccount({ username: 'x', name: '', role: 'staff' }), /管理员/); account.switchDemoRole('staff'); await rejects(() => account.createAccount({ username: 'x', name: '', role: 'staff' }), /管理员/); account.switchDemoRole('admin') })
  await check('账号必填与长度60/61边界', async () => { await rejects(() => account.createAccount({ username: ' ', name: '', role: 'staff' }), /填写/); await rejects(() => account.createAccount({ username: 'x'.repeat(61), name: '', role: 'staff' }), /60/); const result = await account.createAccount({ username: 'x'.repeat(60), name: '', role: 'staff' }); assert.equal(result.account.name.length, 60) })
  await check('姓名61字与未知角色拒绝', async () => { await rejects(() => account.createAccount({ username: 'name-test', name: '名'.repeat(61), role: 'staff' }), /60/); await rejects(() => account.createAccount({ username: 'role-test', name: '', role: 'owner' }), /角色/) })
  await check('密码不足6或超过200拒绝', async () => { await rejects(() => account.createAccount({ username: 'short', name: '', role: 'staff', password: '12345' }), /6–200/); await rejects(() => account.createAccount({ username: 'long', name: '', role: 'staff', password: 'x'.repeat(201) }), /6–200/) })
  let created
  await check('新建账号留空姓名/口令使用明确默认值', async () => { created = await account.createAccount({ username: 'tester', name: '', role: 'staff' }); assert.equal(created.account.name, 'tester'); assert.equal(created.usedDefaultPassword, true); await account.login('tester', 'Demo1234!'); assert.equal(session.accountId, created.account.id); account.switchDemoRole('admin') })
  await check('重复活动账号拒绝', async () => { await rejects(() => account.createAccount({ username: 'tester', name: '重复', role: 'admin' }), /已存在/) })
  await check('当前账号不可删除', async () => { assert.throws(() => account.deleteAccount(session.accountId), /正在使用/) })
  await check('最后管理员保护原因明确', async () => { account.switchDemoRole('staff'); assert.match(account.deletionReason(account.accounts.value.find(row => row.id === 'admin-demo')), /至少/); account.switchDemoRole('admin') })
  await check('删除其他账号是停用且不能再登录', async () => { account.deleteAccount(created.account.id); assert.equal(account.accounts.value.find(row => row.id === created.account.id).active, false); await rejects(() => account.login('tester', 'Demo1234!'), /不正确/) })
  await check('停用同名账号恢复原id和新角色', async () => { const restored = await account.createAccount({ username: 'tester', name: '演示测试', role: 'admin', password: 'Demo5678!' }); assert.equal(restored.reused, true); assert.equal(restored.account.id, created.account.id); assert.equal(restored.account.role, 'admin') })
  await check('错误当前密码及短长新密码拒绝', async () => { await rejects(() => account.changePassword('WrongDemo!', 'Demo5678!'), /当前/); await rejects(() => account.changePassword('Demo1234!', '12345'), /6–200/); await rejects(() => account.changePassword('Demo1234!', 'x'.repeat(201)), /6–200/) })
  await check('密码首尾空格按原后端合法且不得被trim', async () => { await account.changePassword('Demo1234!', ' DemoSpace! '); await rejects(() => account.login('admin', 'DemoSpace!'), /不正确/); await account.login('admin', ' DemoSpace! '); await account.changePassword(' DemoSpace! ', 'Demo1234!'); await account.login('admin', 'Demo1234!') })
  await check('改密后退出，旧密码失败新密码成功', async () => { await account.changePassword('Demo1234!', 'Demo5678!'); assert.equal(session.signedIn, false); await rejects(() => account.login('admin', 'Demo1234!'), /不正确/); await account.login('admin', 'Demo5678!'); assert.equal(session.role, 'admin') })
  await check('存储中无输入密码明文，文字账号导出无摘要', async () => { const text = Array.from(values.values()).join(''); assert.equal(text.includes('Demo1234!'), false); assert.equal(text.includes('Demo5678!'), false); assert.equal(JSON.stringify(account.accountLedger.value).includes('passwordDigest'), false) })
  await check('账号停用同步使当前会话退出', async () => { account.accounts.value = account.accounts.value.map(row => row.id === session.accountId ? { ...row, active: false } : row); assert.equal(session.signedIn, false); account.resetAccounts() })
  await check('其他标签页的口令摘要变更使当前会话退出', async () => { account.switchDemoRole('admin'); account.accounts.value = account.accounts.value.map(row => row.id === session.accountId ? { ...row, passwordDigest: 'changed-in-other-tab' } : row); assert.equal(session.signedIn, false); account.resetAccounts() })
  await check('未登录/员工不能修改酒单', async () => { account.logout(); assert.throws(() => drinks.saveDrinkNote('x'), /管理员/); account.switchDemoRole('staff'); assert.throws(() => drinks.saveDrinkPage({ title: 'x', image }), /管理员/); account.switchDemoRole('admin') })
  await check('初始演示样张可只改标题', async () => { drinks.saveDrinkPage({ id: 'drink-demo-1', title: '新演示标题' }); assert.equal(drinks.drinkPages.value[0].title, '新演示标题') })
  await check('新建酒单必须非空JPG/PNG', async () => { assert.throws(() => drinks.saveDrinkPage({ title: 'no-image' }), /选择/); assert.throws(() => drinks.saveDrinkPage({ title: 'svg', image: { ...image, mime: 'image/svg+xml' } }), /JPG/); assert.throws(() => drinks.saveDrinkPage({ title: 'empty', image: { ...image, size: 0 } }), /空文件/) })
  let newPage
  await check('新增酒单排最后，替换不改页序', async () => { drinks.saveDrinkPage({ title: '新页', image }); newPage = drinks.drinkPages.value.at(-1); drinks.saveDrinkPage({ id: newPage.id, title: '替换标题', image: { ...image, id: 'replacement' } }); assert.equal(drinks.drinkPages.value.at(-1).id, newPage.id); assert.equal(drinks.drinkPages.value.at(-1).image.id, 'replacement') })
  await check('上移下移交换相邻，首尾越界保持', async () => { drinks.moveDrinkPage(newPage.id, 'up'); assert.equal(drinks.drinkPages.value[1].id, newPage.id); drinks.moveDrinkPage(newPage.id, 'down'); assert.equal(drinks.drinkPages.value[2].id, newPage.id); const before = JSON.stringify(drinks.drinkPages.value); drinks.moveDrinkPage(newPage.id, 'down'); drinks.moveDrinkPage(drinks.drinkPages.value[0].id, 'up'); assert.equal(JSON.stringify(drinks.drinkPages.value), before) })
  await check('说明200字可保存，201拒绝，空可清除', async () => { drinks.saveDrinkNote('字'.repeat(200)); assert.equal(drinks.drinkNote.value.length, 200); assert.throws(() => drinks.saveDrinkNote('字'.repeat(201)), /200/); drinks.saveDrinkNote(''); assert.equal(drinks.drinkNote.value, '') })
  await check('删除到零页，旧id再操作拒绝', async () => { const ids = drinks.drinkPages.value.map(row => row.id); ids.forEach(drinks.deleteDrinkPage); assert.equal(drinks.drinkPages.value.length, 0); assert.throws(() => drinks.deleteDrinkPage(ids[0]), /不存在/) })
  await check('本机演示数据确实写入独立存储键', async () => { assert.ok(values.has('lexiu-demo-v1:accounts')); assert.ok(values.has('lexiu-demo-v1:drink-pages')); assert.ok(values.has('lexiu-demo-v1:drink-note')) })
  await check('重置恢复2张样图与seed账号', async () => { drinks.resetDrinks(); account.resetAccounts(); assert.equal(drinks.drinkPages.value.length, 2); assert.equal(account.activeAccounts.value.length, 2); assert.equal(session.accountId, 'staff-demo'); await account.login('admin', 'Demo1234!') })
  const result = { scope: 'Actual stores, actual Vue reactivity; isolated in-memory storage; no browser or backend', total: records.length, passed: records.filter(row => row.passed).length, failed: records.filter(row => !row.passed).length, records }
  fs.writeFileSync(path.join(__dirname, 'drinks-accounts-store-results.json'), JSON.stringify(result, null, 2))
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  process.exitCode = result.failed ? 1 : 0
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1 })
