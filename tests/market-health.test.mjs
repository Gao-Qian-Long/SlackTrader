import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import ts from 'typescript';
const out=new URL('../artifacts/market-health-v08/test-built/',import.meta.url);await mkdir(out,{recursive:true});
for(const file of ['marketData','tonghuashun','marketHealth','eastmoneyProvider']){const input=await readFile(new URL(`../src/market/${file}.ts`,import.meta.url),'utf8');const js=ts.transpileModule(input,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replaceAll('"./marketData"','"./marketData.mjs"').replaceAll('"./tonghuashun"','"./tonghuashun.mjs"').replaceAll('"./marketHealth"','"./marketHealth.mjs"');await writeFile(new URL(`${file}.mjs`,out),js)}
const health=await import(new URL('marketHealth.mjs',out));const {EastmoneyMarketProvider}=await import(new URL('eastmoneyProvider.mjs',out));
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name)}

await test('错误统一为五类且不向界面传播底层长文本',()=>{
 assert.equal(health.classifyMarketError(Error('HTTP 429 retryAfterMs=60000')),'rate_limit');
 assert.equal(health.classifyMarketError(Error('请求超时（10秒）')),'timeout');
 assert.equal(health.classifyMarketError(Error('DNS connect failed')),'connection');
 assert.equal(health.classifyMarketError(Error('日期不一致，数据过期')),'stale');
 assert.equal(health.classifyMarketError(Error('bad payload with private detail')),'invalid_response');
});

await test('健康评分使用25%新延迟并按冷却、失败、延迟、默认顺序排序',()=>{
 let now=1000;const tracker=new health.SourceHealthTracker(()=>now);
 tracker.success('quote:tencent','quote','tencent',100);tracker.success('quote:tencent','quote','tencent',300);
 tracker.success('quote:sina','quote','sina',80);assert.equal(tracker.get('quote:tencent').latencyEwmaMs,150);
 const rows=[{key:'quote:tencent',source:'tencent'},{key:'quote:sina',source:'sina'},{key:'quote:eastmoney',source:'eastmoney'}];
 assert.equal(tracker.order(rows,true)[0].source,'sina');
 tracker.failure('quote:sina','quote','sina',Error('HTTP 429 retryAfterMs=60000'),20);
 assert.equal(tracker.order(rows,true)[0].source,'tencent');assert.equal(tracker.get('quote:sina').cooldownUntil,61000);
 assert.deepEqual(tracker.order(rows,false).map(x=>x.source),['tencent','sina','eastmoney']);
});

await test('报价、分时、日K健康状态彼此独立并在恢复后清零失败',()=>{
 let now=5000;const tracker=new health.SourceHealthTracker(()=>now);
 tracker.failure('minute:tencent','minute','tencent',Error('超时'),500);
 tracker.success('quote:tencent','quote','tencent',100);tracker.failure('daily:tencent','daily','tencent',Error('HTTP 500'),200);
 assert.equal(tracker.get('quote:tencent').consecutiveFailures,0);assert.equal(tracker.get('minute:tencent').consecutiveFailures,1);assert.equal(tracker.get('daily:tencent').consecutiveFailures,1);
 now+=31000;tracker.success('minute:tencent','minute','tencent',120);assert.equal(tracker.get('minute:tencent').consecutiveFailures,0);
});

await test('新鲜度只在竞价和连续交易时段触发指定阈值',()=>{
 const now=100000;
 assert.equal(health.freshness('auction',now,now-10001).quoteStale,true);assert.equal(health.freshness('auction',now,now-10000).quoteStale,false);
 assert.equal(health.freshness('trading',now,now-15001,now-90001).quoteStale,true);assert.equal(health.freshness('trading',now,now-15000,now-90000).historyStale,false);
 for(const status of ['preopen','break','closed']){const r=health.freshness(status,now,0,0);assert.equal(r.quoteStale,false);assert.equal(r.historyStale,false)}
});

await test('本地诊断最多200条、清理7天记录且剔除证券和URL等额外字段',()=>{
 let now=8*86400_000;const map=new Map(),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};const log=new health.LocalDiagnosticLog(storage,()=>now);
 storage.setItem(health.DIAGNOSTIC_STORAGE_KEY,JSON.stringify([{at:0,kind:'quote',source:'tencent',durationMs:1,outcome:'failure'}]));
 for(let i=0;i<220;i++)log.append({at:now+i,kind:'quote',source:'tencent',durationMs:i,outcome:'diagnostic',code:'timeout',symbol:'603118',url:'https://private.example',position:999});
 const rows=log.read(),raw=storage.getItem(health.DIAGNOSTIC_STORAGE_KEY);assert.equal(rows.length,200);assert.ok(raw.length<=65536);for(const secret of ['603118','private.example','position'])assert.ok(!raw.includes(secret));
});

await test('手动检测依次访问当前个股三个报价源、绕过缓存且不改变图表数据',async()=>{
 let now=Date.parse('2026-09-14T10:00:00+08:00'),calls=[];
 const t=Array(40).fill('');Object.assign(t,{1:'测试',2:'603118',3:'10.2',4:'10',6:'100',30:'20260914100000'});
 const sina=['测试','10','10','10.2','10.3','9.9','0','0','10000',...Array(21).fill(''),'2026-09-14','10:00:00'];
 const request=async url=>{calls.push(url);now+=10;if(url.includes('qt.gtimg'))return `v_sh603118="${t.join('~')}";`;if(url.includes('sinajs'))return `var hq_str_sh603118="${sina.join(',')}";`;return JSON.stringify({data:{f57:'603118',f58:'测试',f43:1020,f59:2,f60:1000,f86:Math.floor(now/1000)}})};
 const provider=new EastmoneyMarketProvider({now:()=>now,request,schedule:(fn,ms)=>setTimeout(fn,ms),cancel:id=>clearTimeout(id)});const stock={symbol:'603118',name:'测试',previousClose:10,seed:1};
 const first=await provider.diagnoseCurrentStock(stock),second=await provider.diagnoseCurrentStock(stock);assert.deepEqual(first.map(x=>x.source),['tencent','sina','eastmoney']);assert.ok(first.every(x=>x.ok));assert.equal(second.length,3);assert.equal(calls.length,6);assert.equal(provider.getHealthSnapshot().endpoints.filter(x=>x.kind==='quote').length,3);
});

console.log(`MARKET_HEALTH_RESULT ${passed}/${passed} passed`);
