import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { publicAssets, releaseInfo } from '../scripts/release-utils.mjs';
const out=new URL('../artifacts/update-flow/test-built/',import.meta.url);fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(new URL('updatePrompt.mjs',out),ts.transpileModule(fs.readFileSync('src/updatePrompt.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
const {UpdatePrompt}=await import(new URL('updatePrompt.mjs',out));let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
const state={phase:'available',version:'0.7.0',received:0,message:''};
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function fixture(ask=async()=>false){let saved=null,installs=0,calls=0;const prompt=new UpdatePrompt({ask:async v=>{calls++;return ask(v);},install:async()=>{installs++;},readDismissed:()=>saved,saveDismissed:v=>saved=v});return{prompt,get saved(){return saved;},get calls(){return calls;},get installs(){return installs;}};}
await test('发现新版自动询问，选择稍后不下载并记忆版本',async()=>{const h=fixture();await h.prompt.offer(state);assert.equal(h.calls,1);assert.equal(h.installs,0);assert.equal(h.saved,'0.7.0');await h.prompt.offer(state);assert.equal(h.calls,1);});
await test('用户确认后才进入下载安装流程',async()=>{const h=fixture(async()=>true);await h.prompt.offer(state);assert.equal(h.installs,1);await h.prompt.offer(state);assert.equal(h.installs,1);});
await test('手动在线检查可再次询问，新版本也重新询问',async()=>{const h=fixture();await h.prompt.offer(state);await h.prompt.offer(state,true);assert.equal(h.calls,2);await h.prompt.offer({...state,version:'0.8.0'});assert.equal(h.calls,3);});
await test('检查失败、已是最新、下载中均不弹更新确认',async()=>{const h=fixture();for(const phase of ['error','current','checking','downloading','installing'])await h.prompt.offer({...state,phase});assert.equal(h.calls,0);});
await test('并发请求只打开一个确认框',async()=>{const d=defer(),h=fixture(()=>d.promise);const pending=h.prompt.offer(state);await h.prompt.offer(state,true);assert.equal(h.calls,1);d.resolve(true);await pending;assert.equal(h.installs,1);});
await test('关闭应用后的晚到确认不触发安装，弹窗失败可重试',async()=>{const d=defer(),h=fixture(()=>d.promise);const pending=h.prompt.offer(state);h.prompt.dispose();d.resolve(true);await pending;assert.equal(h.installs,0);let calls=0;const retry=fixture(async()=>{if(++calls===1)throw Error('dialog closed');return false;});await retry.prompt.offer(state);await retry.prompt.offer(state);assert.equal(retry.calls,2);});
await test('公开附件严格限定安装版、便携版和更新清单',()=>{assert.deepEqual(publicAssets(releaseInfo('0.6.0')),['SlackTrader-v0.6-Setup-x64.exe','SlackTrader-v0.6-Portable-x64.exe','latest.json']);const workflow=fs.readFileSync('.github/workflows/release.yml','utf8');assert.doesNotMatch(workflow,/Setup-x64\.exe\.sig|Source\.zip|SHA256SUMS/);});
await test('原生更新使用固定配置、直连回退和官方已验证下载资源',()=>{const rust=fs.readFileSync('src-tauri/src/updates.rs','utf8');assert.match(rust,/vec!\["direct", "system"\]/);assert.match(rust,/\.no_proxy\(\)/);assert.match(rust,/resources_table\(\)\.add\(update\)/);assert.doesNotMatch(rust,/allow_downgrades|accept_invalid|version_comparator/);const cap=JSON.parse(fs.readFileSync('src-tauri/capabilities/default.json'));assert.ok(cap.permissions.includes('dialog:allow-message'));});
console.log(`UPDATE_FLOW_RESULT ${passed}/${passed} passed`);
