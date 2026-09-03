import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { releaseInfo, updateManifest, sourceFileAllowed } from '../scripts/release-utils.mjs';
const out = new URL('../artifacts/updater/test-built/', import.meta.url); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(new URL('updater.mjs', out), ts.transpileModule(fs.readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const { UpdateController } = await import(new URL('updater.mjs', out));
let passed = 0;
async function test(name, fn) { await fn(); console.log('PASS ' + name); passed++; }
const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b; }); return {promise,resolve,reject}; };
function fixture(overrides = {}) {
  const events = [], states = [];
  const release = {version:'0.5.0',body:'<img src=x onerror=alert(1)>',async close(){events.push('close');},async download(cb){events.push('download');cb({event:'Started',data:{contentLength:20}});cb({event:'Progress',data:{chunkLength:20}});cb({event:'Finished'});events.push('verified');},async install(){events.push('install');},...overrides};
  const controller = new UpdateController(async options => { events.push(options);return release; }, state => states.push(state));
  return {release,controller,events,states};
}
await test('检查只返回候选版本，禁用降级且有15秒超时，不自动安装', async () => {
  const h=fixture();await h.controller.check();assert.equal(h.controller.state.phase,'available');assert.deepEqual(h.events,[{timeout:15000,allowDowngrades:false}]);
});
await test('无更新显示最新；接口失败不误报最新', async () => {
  const c=new UpdateController(async()=>null,()=>{});await c.check();assert.equal(c.state.phase,'current');
  const fail=new UpdateController(async()=>{throw Error('404');},()=>{});await fail.check();assert.equal(fail.state.phase,'error');assert.match(fail.state.message,/未完成/);
});
await test('有候选版本时后台不反复拉取，手动检查释放旧资源',async()=>{
  const h=fixture();await h.controller.check();await h.controller.check();assert.equal(h.events.length,1);await h.controller.check(true);assert.equal(h.events.filter(e=>e==='close').length,1);
});
await test('重复检查只产生一个请求',async()=>{
  const d=defer();let calls=0;const c=new UpdateController(()=>{calls++;return d.promise;},()=>{});const pending=c.check();await c.check(true);assert.equal(calls,1);d.resolve(null);await pending;
});
await test('下载进度展示，先校验再安装且下载超时5分钟',async()=>{
  const h=fixture();await h.controller.check();await h.controller.downloadAndInstall();assert.deepEqual(h.events.slice(1),['download','verified','install']);assert.equal(h.controller.state.received,20);assert.ok(h.states.some(s=>s.phase==='verifying'));assert.equal(h.controller.state.phase,'installing');
});
await test('Finished事件不等于签名通过：下载Promise未完成时不启动安装',async()=>{
  const d=defer();let installs=0;const h=fixture({download:async(cb,options)=>{assert.equal(options.timeout,300000);cb({event:'Finished'});await d.promise;},install:async()=>{installs++;}});await h.controller.check();const pending=h.controller.downloadAndInstall();await h.controller.downloadAndInstall();assert.equal(installs,0);d.resolve();await pending;assert.equal(installs,1);await h.controller.downloadAndInstall();assert.equal(installs,1);
});
await test('签名失败和网络失败均不安装，可重试',async()=>{
  let calls=0;const h=fixture({download:async()=>{if(++calls===1)throw Error('Signature failed');}});await h.controller.check();await h.controller.downloadAndInstall();assert.equal(h.controller.state.phase,'available');assert.ok(!h.events.includes('install'));await h.controller.downloadAndInstall();assert.ok(h.events.includes('install'));
});
await test('安装向导启动失败保留候选版本并允许重试',async()=>{
  let calls=0;const h=fixture({install:async()=>{if(++calls===1)throw Error('ShellExecute failed');}});await h.controller.check();await h.controller.downloadAndInstall();assert.match(h.controller.state.message,/启动失败/);await h.controller.downloadAndInstall();assert.equal(calls,2);
});
await test('销毁后不安装，检查晚到资源会释放',async()=>{
  const d=defer(),h=fixture({download:()=>d.promise});await h.controller.check();const pending=h.controller.downloadAndInstall();h.controller.dispose();d.resolve();await pending;assert.ok(!h.events.includes('install'));
  const late=defer();let closed=0;const c=new UpdateController(()=>late.promise,()=>{});const check=c.check();c.dispose();late.resolve({close:async()=>closed++});await check;assert.equal(closed,1);
});
await test('重查失败仍可安装此前发现的版本',async()=>{
  const h=fixture();let count=0;const c=new UpdateController(async()=>{if(count++)throw Error('offline');return h.release;},()=>{});await c.check();await c.check(true);assert.equal(c.state.phase,'available');await c.downloadAndInstall();assert.ok(h.events.includes('install'));
});
await test('可信更新地址、公钥、交互安装模式和原应用标识固定',()=>{
  const cfg=JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json'));
  assert.equal(cfg.identifier,'com.bluetoothassistant.desktop');assert.equal(cfg.bundle.createUpdaterArtifacts,true);assert.equal(cfg.plugins.updater.windows.installMode,'basicUi');
  assert.deepEqual(cfg.plugins.updater.endpoints,['https://github.com/Gao-Qian-Long/SlackTrader/releases/latest/download/latest.json']);assert.match(Buffer.from(cfg.plugins.updater.pubkey,'base64').toString(),/minisign public key/);
  assert.ok(JSON.parse(fs.readFileSync('src-tauri/capabilities/default.json')).permissions.includes('updater:default'));assert.match(fs.readFileSync('src-tauri/src/lib.rs','utf8'),/plugin\(tauri_plugin_updater::Builder/);
});
await test('提醒仅在应用内，发布说明用textContent，紧凑模式隐藏',()=>{
  const panel=fs.readFileSync('src/updatePanel.ts','utf8'),css=fs.readFileSync('src/styles.css','utf8');assert.match(panel,/notes\.textContent/);assert.doesNotMatch(panel,/\.innerHTML|new Notification|\.title\s*=/);assert.match(css,/\.compact \.update-notice\s*\{\s*display: none/);assert.match(panel,/6 \* 60 \* 60 \* 1000/);
});
await test('发布清单版本、平台、签名内容及安装地址一致',()=>{
  const info=releaseInfo('0.5.0'),sig=Buffer.from('untrusted comment: test\nfixture').toString('base64');const m=updateManifest(info,sig,'notes','2026-09-03T00:00:00Z');assert.equal(m.platforms['windows-x86_64'].signature,sig);assert.equal(m.platforms['windows-x86_64'].url,'https://github.com/Gao-Qian-Long/SlackTrader/releases/download/v0.5/SlackTrader-v0.5-Setup-x64.exe');assert.equal(m.version,'0.5.0');assert.equal(info.title,'SlackTrader v0.5');assert.equal(info.tag,'v0.5');assert.throws(()=>releaseInfo('0.5.0','v0.5.0'));assert.throws(()=>releaseInfo('0.5.1'));assert.equal(releaseInfo('0.6.0').tag,'v0.6');assert.throws(()=>releaseInfo('0.5.0','v0.4'));assert.throws(()=>releaseInfo('0.5.0-beta'));assert.throws(()=>updateManifest(info,''));
});
await test('发布源码排除私钥、环境文件、用户数据和缓存',()=>{
  for(const p of ['updater.key','signing/generate.log','.env','src/.env.production','secret.pem','artifacts/private.txt','release/file.exe','user-data-backup/state.json','src-tauri/target/app.exe'])assert.equal(sourceFileAllowed(p),false,p);
  for(const p of ['src/updater.ts','docs/UPDATING.md','.github/workflows/release.yml'])assert.equal(sourceFileAllowed(p),true,p);
});
console.log(`UPDATER_RESULT ${passed}/${passed} passed`);
