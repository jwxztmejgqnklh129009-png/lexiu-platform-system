// Saved from the actual inline asset-log regression run. Only runtime path setup was added.
const path = require('node:path');
const frontend = path.resolve(__dirname, '../..');
module.paths.unshift(path.join(frontend, 'node_modules'));
process.chdir(frontend);
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript'),vue=require('vue');const refs=new Map();let uid=0;const session=vue.reactive({role:'staff',accountId:'staff-demo',name:'演示员工A',signedIn:true});const code=ts.transpileModule(fs.readFileSync('src/stores/warehouse.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;const mod={exports:{}};vm.runInNewContext(code,{exports:mod.exports,module:mod,require:n=>n==='vue'?vue:n==='../session'?{session}:{persistedRef:(key,value)=>{const ref=vue.ref(structuredClone(value));refs.set(key,ref);return ref},uid:p=>`${p}-${++uid}`,nowText:()=> '2026-10-24 21:50:00'},console});const w=mod.exports;const checks=[];function ok(name,fn){fn();checks.push(name)}
ok('领用写入原API字段',()=>{w.moveAsset(1,'take',' 员工甲 ');const l=w.assetLogs.value[0];assert.equal(l.asset_id,1);assert.equal(l.action,'take');assert.equal(l.person,'员工甲');assert.equal(l.at,'2026-10-24 21:50:00');assert.equal(l.note,'');assert.equal(w.assets.value.find(a=>a.id===1).taken_at,l.at)});
ok('归还人员保留且新记录排前',()=>{w.moveAsset(1,'return',' 员工乙 ');assert.equal(w.assetLogs.value[0].person,'员工乙');assert.equal(w.assetLogs.value[0].action,'return');assert.equal(w.assetLogs.value.length,2);assert(w.assetLogs.value[0].id>w.assetLogs.value[1].id);assert.equal(w.assets.value.find(a=>a.id===1).holder,'')});
ok('失败登记不写日志',()=>{const n=w.assetLogs.value.length;assert.throws(()=>w.moveAsset(1,'return','员工丙'));assert.throws(()=>w.moveAsset(1,'take',' '));assert.throws(()=>w.moveAsset(3,'take','员工丙'));assert.equal(w.assetLogs.value.length,n)});
ok('原API备注字段可保留',()=>{w.moveAsset(1,'take','员工丁',' 原备注 ');assert.equal(w.assetLogs.value[0].note,'原备注')});
ok('流水交给公共本机持久化',()=>assert.equal(refs.get('warehouse:asset-logs'),w.assetLogs));
ok('重置清除流水与领用状态',()=>{w.resetWarehouse();assert.equal(w.assetLogs.value.length,0);assert.equal(w.assets.value.find(a=>a.id===1).status,'in_stock')});console.log(JSON.stringify({assetLogChecks:checks,passed:checks.length},null,2));
