// Saved from the actual inline SFC regression run. Only runtime path setup was added.
const path = require('node:path');
const frontend = path.resolve(__dirname, '../..');
module.paths.unshift(path.join(frontend, 'node_modules'));
process.chdir(frontend);
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript'),vue=require('vue'),{parse,compileScript}=require('@vue/compiler-sfc');let seq=0;const session=vue.reactive({role:'admin',accountId:'admin-demo',name:'演示管理员',signedIn:true});const persistence={persistedRef:(_k,v)=>vue.ref(structuredClone(v)),uid:p=>`${p}-${++seq}`,nowText:()=> '2026-10-24 22:30:00'};function evaluate(source,deps,filename){const mod={exports:{}};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:mod.exports,module:mod,require:n=>{if(n in deps)return deps[n];if(n.endsWith('.vue')||n.endsWith('.css'))return{};throw Error(`Unexpected import ${n}`)},window:{scrollTo(){}},console},{filename});return mod.exports}const w=evaluate(fs.readFileSync('src/stores/warehouse.ts','utf8'),{vue,'../persistence':persistence,'../session':{session}},'warehouse.ts');const route=vue.reactive({params:{},query:{},path:'/inventory/new'});const pendingMediaWrites=vue.ref(0);let leave,update,dialogCount=0,confirm=true,replaced='';const compiled=compileScript(parse(fs.readFileSync('src/pages/InventoryForm.vue','utf8')).descriptor,{id:'InventoryForm-regression'});const component=evaluate(compiled.content,{vue,'vue-router':{useRoute:()=>route,useRouter:()=>({replace:async path=>{replaced=path}}),onBeforeRouteLeave:fn=>{leave=fn},onBeforeRouteUpdate:fn=>{update=fn}},vant:{showConfirmDialog:async()=>{dialogCount++;if(!confirm)throw 'cancel'},showToast:()=>{}},'../session':{session},'../media':{pendingMediaWrites},'../stores/warehouse':w},'InventoryForm.vue');const scope=vue.effectScope();const f=scope.run(()=>component.default.setup({}, {expose(){}}));const checks=[];async function test(name,fn){await fn();checks.push(name)};async function to(id){route.params=id?{id:String(id)}:{};route.path=id?`/inventory/${id}/edit`:'/inventory/new';await vue.nextTick()}
(async()=>{
await test('空白新增初始无改动',()=>assert.equal(f.dirty.value,false));
await test('Vant 0/15 转字符串不算改动',()=>{Object.assign(f.draft,{quantity:'0',safety_stock:'0',warn_days:'15'});assert.equal(f.dirty.value,false)});
await test('空白新增离开不弹确认',async()=>{assert.equal(await leave(),true);assert.equal(dialogCount,0)});
await test('删除数字0仍算改动',()=>{f.draft.quantity='';assert.equal(f.dirty.value,true)});
await test('真实改动离开要求确认',async()=>{confirm=false;assert.equal(await leave(),false);assert.equal(dialogCount,1)});
await test('取消离开保留原输入',()=>assert.equal(f.draft.quantity,''));
await test('改回原值恢复干净状态',()=>{f.draft.quantity='0';assert.equal(f.dirty.value,false)});
await test('文本修改判脏',()=>{f.draft.name='尚未保存';assert.equal(f.dirty.value,true)});
await test('新增转编辑加载对应档案',async()=>{confirm=true;assert.equal(await leave(),true);await to(1);assert.equal(f.draft.name,'百威啤酒');assert.equal(f.draft.quantity,18);assert.equal(f.dirty.value,false)});
await test('编辑数字转字符串保留库存且不判脏',()=>{Object.assign(f.draft,{quantity:'18',safety_stock:'24',warn_days:'15'});assert.equal(f.dirty.value,false)});
await test('编辑不同物品前取消不丢输入',async()=>{f.draft.name='未保存编辑';confirm=false;assert.equal(await update({params:{id:'2'}},{params:{id:'1'}}),false);assert.equal(f.draft.name,'未保存编辑');assert.equal(route.params.id,'1')});
await test('同ID路由更新不无故弹确认',async()=>{const n=dialogCount;assert.equal(await update({params:{id:'1'}},{params:{id:'1'}}),true);assert.equal(dialogCount,n)});
await test('确认后切物品重新初始化档案',async()=>{confirm=true;assert.equal(await update({params:{id:'2'}},{params:{id:'1'}}),true);f.files.value=[{id:'draft',name:'draft.png',mime:'image/png',size:10}];f.step.value=2;f.error.value='旧错误';f.saved.value=true;await to(2);assert.equal(f.draft.name,'科罗娜特级啤酒');assert.equal(f.draft.quantity,72)});
await test('复用重置图片步骤错误已保存标识',()=>{assert.equal(f.files.value.length,0);assert.equal(f.step.value,1);assert.equal(f.error.value,'');assert.equal(f.saved.value,false);assert.equal(f.dirty.value,false)});
await test('外部库存变化不覆盖正在填写草稿',()=>{f.draft.note='正在编辑';w.moveStock(2,'in',5);assert.equal(f.draft.quantity,72);assert.equal(f.draft.note,'正在编辑')});
await test('编辑保存保持最新库存数量',async()=>{await f.save();assert.equal(w.inventory.value.find(x=>x.id===2).quantity,77);assert.equal(w.inventory.value.find(x=>x.id===2).note,'正在编辑');assert.equal(replaced,'/inventory/2')});
await test('编辑返回新增清空上一件资料',async()=>{await to();assert.equal(f.draft.name,'');assert.equal(f.draft.quantity,0);assert.equal(f.draft.safety_stock,0);assert.equal(f.draft.note,'');assert.equal(f.dirty.value,false)});
await test('上传中仍禁止进入核对',()=>{pendingMediaWrites.value=1;f.prepare();assert.equal(f.step.value,1);assert.match(f.error.value,/正在保存/)});
await test('上传中仍禁止离开',async()=>assert.equal(await leave(),false));
await test('日期变化仍判为真实改动',()=>{pendingMediaWrites.value=0;f.draft.expiry_date='2027-01-01';assert.equal(f.dirty.value,true)});
scope.stop();console.log(JSON.stringify({actualSfcRegression:checks.length,passed:checks.length,checks},null,2));})().catch(e=>{console.error(e);process.exitCode=1});
