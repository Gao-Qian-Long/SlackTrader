import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import ts from 'typescript';
const out=new URL('../artifacts/sector-depth/test-built/',import.meta.url);await mkdir(out,{recursive:true});
for(const file of ['marketData','detailData','detailProvider']){
 const src=await readFile(new URL(`../src/market/${file}.ts`,import.meta.url),'utf8');
 const js=ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replaceAll('"./marketData"','"./marketData.mjs"').replaceAll('"./detailData"','"./detailData.mjs"');
 await writeFile(new URL(`${file}.mjs`,out),js);
}
const market=await import(new URL('marketData.mjs',out)), data=await import(new URL('detailData.mjs',out));
const {DetailMarketProvider}=await import(new URL('detailProvider.mjs',out));
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
const stock={symbol:'000938',name:'测试股票',previousClose:10,seed:0},board={code:'BK1444',name:'测试板块'};
const related=JSON.stringify({rc:0,data:{diff:[{f12:'BK1444',f14:'测试板块'},{f12:'BK0447',f14:'另一个板块'}]}});
const sector=JSON.stringify({rc:0,data:{code:'BK1444',market:90,preClose:1000,trends:['2026-09-03 09:15,1000,1000,1000,1000,0,0,1000','2026-09-03 09:30,1000,1001,1001,1000,100,100000,1000','2026-09-03 09:31,1001,1002,1002,1001,50,50000,1001']}});
const trades=JSON.stringify({rc:0,data:{code:'000938',market:0,details:['09:30:00,10,20,5,1','09:30:03,10.01,30,7,2','09:30:03,10.01,10,2,4']}});
const flush=async()=>{for(let i=0;i<20;i++)await new Promise(setImmediate);};
function harness(request){const timers=new Map();let id=0;const clock={now:Date.parse('2026-09-03T10:00:00+08:00')};const provider=new DetailMarketProvider({request,now:()=>clock.now,schedule:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},cancel:id=>timers.delete(id)});return {provider,timers,clock,run:async ms=>{for(const [id,t]of [...timers])if(t.ms===ms){timers.delete(id);t.fn();}await flush();}};}
await test('腾讯与新浪五档手股换算一致，金额使用价格乘股数',()=>{
 const t=Array(34).fill(''),s=Array(33).fill('');Object.assign(t,{1:'测试',2:'000938',3:'10',4:'10',30:'20260903100000'});Object.assign(s,{0:'测试',2:'10',3:'10',30:'2026-09-03',31:'10:00:00'});
 for(let i=0;i<5;i++){const bid=10-i*.01,ask=10.01+i*.01;t[9+i*2]=String(bid);t[10+i*2]=String(i+1);t[19+i*2]=String(ask);t[20+i*2]=String(i+2);s[10+i*2]=String((i+1)*100);s[11+i*2]=String(bid);s[20+i*2]=String((i+2)*100);s[21+i*2]=String(ask);}
 const a=market.parseTencentQuote(`v_sz000938="${t.join('~')}";`,'sz000938'),b=market.parseSinaQuote(`var hq_str_sz000938="${s.join(',')}";`,'sz000938');
 assert.deepEqual(a.orderBook,b.orderBook);assert.equal(a.orderBook.bids.length,5);assert.equal(a.orderBook.asks.length,5);assert.equal(a.orderBook.bids[0].shares*a.orderBook.bids[0].price,1000);
 t[9]='-';t[10]='NaN';assert.equal(market.parseTencentQuote(`v_sz000938="${t.join('~')}";`,'sz000938').orderBook.bids[0].level,2);
});
await test('关联板块只保留源代码并去重，不进行同花顺名称映射',()=>{
 assert.equal(data.parseRelatedSectors(related)[0].code,'BK1444');
 assert.deepEqual(data.parseRelatedSectors(JSON.stringify({rc:0,data:{diff:[{f12:'BK1444',f14:'a'},{f12:'BK1444',f14:'b'},{f12:'881129',f14:'c'}]}})),[{code:'BK1444',name:'b'}]);
 assert.throws(()=>data.parseRelatedSectors('{"rc":102,"data":null}'));
});
await test('指数和板块不冒充个股盘口，普通个股保持支持',()=>{
 assert.equal(data.supportsMarketDepth(stock),true);assert.equal(data.supportsMarketDepth({...stock,kind:'index'}),false);
 assert.equal(data.supportsMarketDepth({...stock,symbol:'881129'}),false);assert.equal(data.supportsMarketDepth({...stock,symbol:'000300'}),false);
});
await test('板块曲线校验代码市场昨收，并排除集合竞价时段',()=>{
 const r=data.parseSectorSeries(sector,board,'测试源');assert.equal(r.history.length,2);assert.equal(r.previousClose,1000);assert.equal(r.source,'测试源');
 assert.throws(()=>data.parseSectorSeries(sector,{...board,code:'BK0447'},'test'));
 assert.throws(()=>data.parseSectorSeries(sector.replace('"preClose":1000','"preClose":0'),board,'test'));
 assert.throws(()=>data.parseSectorSeries(sector.replace('"market":90','"market":0'),board,'test'));
});
await test('分笔真实字段解析：手换股、源方向、倒序、同秒记录保留',()=>{
 const r=data.parseTradeDetails(trades,'000938',0);assert.equal(r.length,3);assert.equal(r[0].time,'09:30:03');assert.equal(r[0].shares,3000);
 assert.deepEqual(r.map(t=>t.side),['buy','neutral','sell']);
});
await test('拒绝错误代码、市场、时间、成交价格及成交量，不补假成交',()=>{
 assert.throws(()=>data.parseTradeDetails(trades,'000001',0));assert.throws(()=>data.parseTradeDetails(trades,'000938',1));
 for(const [from,to]of [['09:30:00','29:99:99'],[',10,20,',',0,20,'],[',10,20,',',10,-20,']])assert.throws(()=>data.parseTradeDetails(trades.replace(from,to),'000938',0));
 assert.deepEqual(data.parseTradeDetails(JSON.stringify({rc:0,data:{code:'000938',market:0,details:[]}}),'000938',0),[]);
});
await test('关联板块缓存10分钟，切股使用各自缓存',async()=>{
 let calls=0;const h=harness(async()=>{calls++;return related;});await h.provider.getRelatedSectors(stock);await h.provider.getRelatedSectors(stock);assert.equal(calls,1);
 await h.provider.getRelatedSectors({...stock,symbol:'000001'});assert.equal(calls,2);h.clock.now+=600001;await h.provider.getRelatedSectors(stock);assert.equal(calls,3);
});
await test('成交详情只读独立轮询，取消后移除定时器',async()=>{
 const updates=[],urls=[];const h=harness(async url=>{urls.push(url);return trades;});const stop=h.provider.connectTrades(stock,r=>updates.push(r),assert.fail);
 await h.run(150);assert.equal(updates.length,1);assert.equal(updates[0].source,'东方财富·分笔聚合');assert.ok(urls.every(u=>u.includes('/details/get')));assert.ok([...h.timers.values()].some(t=>t.ms===5000));stop();assert.equal(h.timers.size,0);
});
await test('取消后丢弃在途成交响应，不复活轮询',async()=>{
 let resolve;const updates=[];const h=harness(()=>new Promise(r=>{resolve=r;}));const stop=h.provider.connectTrades(stock,r=>updates.push(r),assert.fail);await h.run(150);stop();resolve(trades);await flush();assert.equal(updates.length,0);assert.equal(h.timers.size,0);
});
await test('429遵循Retry-After并退避，故障不生成交易',async()=>{
 let calls=0;const updates=[],errors=[];const h=harness(async()=>{calls++;throw Error('HTTP 429; retryAfterMs=60000');});const stop=h.provider.connectTrades(stock,r=>updates.push(r),e=>errors.push(e));
 await h.run(150);assert.equal(updates.length,0);assert.ok([...h.timers.values()].some(t=>t.ms===10000));h.clock.now+=10000;await h.run(10000);assert.equal(calls,1);assert.equal(errors.length,2);stop();
});
await test('板块原源故障使用相同代码备用源并标记可能延迟',async()=>{
 const urls=[],updates=[];const h=harness(async url=>{urls.push(url);if(url.includes('push2his'))throw Error('offline');return sector;});const stop=h.provider.connectSector(board,r=>updates.push(r),assert.fail);await h.run(150);
 assert.equal(updates.length,1);assert.match(updates[0].source,/可能延迟/);assert.equal(urls.length,2);assert.ok(urls.every(u=>u.includes('90.BK1444')));stop();
});
await test('板块所有源失败不返回伪曲线，非交易时段降频',async()=>{
 const errors=[];const h=harness(async()=>{throw Error('offline');});h.clock.now=Date.parse('2026-09-03T12:00:00+08:00');const stop=h.provider.connectSector(board,assert.fail,e=>errors.push(e));await h.run(150);assert.equal(errors.length,1);assert.ok([...h.timers.values()].some(t=>t.ms===120000));stop();
});
await test('新增面板使用文本节点、取消机制和日期对齐，不添加悬停提示',async()=>{
 const panel=await readFile(new URL('../src/detailPanel.ts',import.meta.url),'utf8');
 assert.doesNotMatch(panel,/innerHTML|\.title\s*=|setAttribute\(["']title/);assert.match(panel,/this\.generation\+\+/);assert.match(panel,/this\.stopTrades\?\.\(\)/);
 assert.match(panel,/chinaDate\(quote\.snapshot\.timestamp\) !== chinaDate\(last\.time \* 1000\)/);
});
await test('详细图滚动成交表或板块选择不触发切股',async()=>{
 const main=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
 assert.match(main,/if \(detailed \|\| \(event\.target as Element\)\.closest\("select,\.depth-panel,\.sector-pane"\)\) return;/);
});
console.log(`DETAIL_MARKET_RESULT ${passed}/${passed} passed`);
