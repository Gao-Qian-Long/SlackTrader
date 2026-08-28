import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const out = new URL('../artifacts/market-fix/test-built/', import.meta.url);
await mkdir(out, { recursive: true });
for (const file of ['marketData', 'tonghuashun', 'eastmoneyProvider']) {
  const input = await readFile(new URL(`../src/market/${file}.ts`, import.meta.url), 'utf8');
  const js = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll('"./marketData"', '"./marketData.mjs"').replaceAll('"./tonghuashun"', '"./tonghuashun.mjs"');
  await writeFile(new URL(`${file}.mjs`, out), js);
}
const data = await import(new URL('marketData.mjs', out));
const ths = await import(new URL('tonghuashun.mjs', out));
const { EastmoneyMarketProvider } = await import(new URL('eastmoneyProvider.mjs', out));
const stock = { symbol: '603118', name: '测试股票', previousClose: 10, seed: 0 };
const timestamp = '20260828100000';
const t = Array(34).fill(''); Object.assign(t, { 1:'测试股票', 2:'603118', 3:'10.25', 4:'10', 6:'100', 30:timestamp });
const tencent = `v_sh603118="${t.join('~')}";`;
const s = Array(33).fill(''); Object.assign(s, { 0:'测试股票', 2:'10', 3:'10.25', 8:'10000', 30:'2026-08-28', 31:'10:00:00' });
const sina = `var hq_str_sh603118="${s.join(',')}";`;
const minute = JSON.stringify({data:{sh603118:{data:{date:'20260828',data:['0930 10.1 100 100000','0931 10.25 200 202000']}}}});
const daily = JSON.stringify({data:{sh603118:{qfqday:[['2026-08-28','10','10.25','10.4','9.9','20']]}}});
const eastQuote = JSON.stringify({data:{f57:'603118',f58:'测试股票',f43:1025,f60:1000,f59:2,f86:1787882400}});
const eastMinute = JSON.stringify({data:{trends:['2026-08-28 09:30,10,10.1,10.1,10,100,100000,10']}});
const sector={symbol:'881129',name:'通信设备',previousClose:1000,seed:0,kind:'sector',dataSymbol:'90.BK0448',quantity:600,costPrice:18.13};
const wrap=(path,obj)=>`quotebridge_${path}(${JSON.stringify(obj)})`;
const thsQuote=wrap('v6_realhead_bk_881129_last',{items:{5:'881129',name:'通信设备',10:'9494.464',6:'9585.511',13:'100',updateTime:'2026-08-28 15:00',time:'2026-08-28 17:20:57 北京时间'}});
const thsMinute=wrap('v6_time_bk_881129_last',{bk_881129:{name:'通信设备',pre:'9585.511',date:'20260828',data:'0930,9535.200,1967880900,63.527,30977001;1500,9494.464,1518290000,67.822,26601200'}});
const thsDaily=wrap('v6_line_bk_881129_01_last',{name:'通信设备',data:'20260827,9294.854,9589.994,9294.247,9585.511,2930410500;'});
const thsToday=wrap('v6_line_bk_881129_01_today',{bk_881129:{1:'20260828',7:'9535.200',8:'9711.803',9:'9492.669',11:'9494.464',13:'2580618500'}});
const flush = async () => { for (let i=0; i<15; i++) await new Promise(setImmediate); };
function harness(request, now = Date.parse('2026-08-28T10:00:00+08:00')) {
  const timers = new Map(); let id=0;
  const clock = { now };
  const provider = new EastmoneyMarketProvider({ request, now:() => clock.now,
    schedule:(fn,ms) => {timers.set(++id,{fn,ms}); return id;}, cancel:id => timers.delete(id) });
  const run = async ms => {
    const matching = [...timers].filter(([,t]) => t.ms === ms);
    for (const [key,t] of matching) { timers.delete(key); t.fn(); }
    await flush();
  };
  return {provider,timers,clock,run};
}
let passed=0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
await test('腾讯/新浪报价价格、昨收、中文及源时间解析', () => {
  const a=data.parseTencentQuote(tencent,'sh603118'), b=data.parseSinaQuote(sina,'sh603118');
  assert.deepEqual(a,b); assert.equal(a.price,10.25); assert.equal(a.timestamp,Date.parse('2026-08-28T10:00:00+08:00'));
});
await test('拒绝空值、错误代码、无昨收和无源时间，不伪造行情', () => {
  assert.throws(()=>data.parseTencentQuote('v_sh603118="";','sh603118'));
  assert.throws(()=>data.parseTencentQuote(tencent,'sz000001'));
  assert.throws(()=>data.parseSinaQuote(sina.replace('10,10.25','0,10.25'),'sh603118'));
  assert.throws(()=>data.parseEastmoneyQuote(eastQuote.replace('1787882400','0'),'1.603118'));
});
await test('东方财富精度0合法，板块代码隔离', () => {
  assert.equal(data.parseEastmoneyQuote(eastQuote.replace('"f59":2','"f59":0'),'1.603118').price,1025);
  assert.throws(()=>data.eastmoneyId({...stock,symbol:'881129'}));
  assert.throws(()=>data.mainlandId({...stock,symbol:'881129'}));
});
await test('分时手/股换算和日K解析', () => {
  const points=data.parseTencentMinute(minute,'sh603118');
  assert.equal(points[1].average,10.1); assert.equal(points[1].volume,20000);
  assert.equal(data.parseTencentDaily(daily,'sh603118')[0].close,10.25);
  assert.equal(data.parseEastmoneyMinute(eastMinute).length,1);
});
await test('北京时区和周末、午休刷新状态', () => {
  assert.equal(data.marketStatus(Date.parse('2026-08-29T10:00:00+08:00')),'closed');
  assert.equal(data.marketStatus(Date.parse('2026-08-28T12:00:00+08:00')),'break');
  assert.equal(data.marketStatus(Date.parse('2026-08-28T10:00:00+08:00')),'trading');
});
await test('分时永久挂起时，报价独立到达；取消后迟到数据不回调', async () => {
  let resolveHistory; const updates=[];
  const h=harness(url=>url.includes('qt.gtimg')?Promise.resolve(tencent):new Promise(r=>{resolveHistory=r;}));
  const stop=h.provider.connect(stock,u=>updates.push(u)); await h.run(150);
  assert.equal(updates.length,1); assert.equal(updates[0].snapshot.price,10.25); assert.deepEqual(updates[0].history,[]);
  stop(); resolveHistory(minute); await flush(); assert.equal(updates.length,1); assert.equal(h.timers.size,0);
});
await test('腾讯失败切新浪；分时全部失败不阻断报价', async () => {
  const calls=[], updates=[], errors=[];
  const h=harness(async url=>{calls.push(url); if(url.includes('hq.sinajs'))return sina; throw new Error('连接失败');});
  const stop=h.provider.connect(stock,u=>updates.push(u),e=>errors.push(e)); await h.run(150);
  assert.equal(updates.at(-1).quoteSource,'新浪'); assert.equal(updates.at(-1).snapshot.price,10.25);
  assert.match(updates.at(-1).historyMessage,/待恢复/); assert.equal(errors.length,0);
  assert.equal(calls.filter(u=>u.includes('push2.eastmoney')).length,0); stop();
});
await test('429 Retry-After冷却生效，恢复后重新尝试', async () => {
  let count=0; const h=harness(async url=>{
    if(url.includes('qt.gtimg')) {count++; if(count===1)throw new Error('HTTP 429; retryAfterMs=60000'); return tencent;}
    if(url.includes('hq.sinajs'))return sina;
    return minute;
  });
  const updates=[];const stop=h.provider.connect(stock,u=>updates.push(u));await h.run(150);
  h.clock.now+=5000;await h.run(5000);assert.equal(count,1);
  h.clock.now+=60000;await h.run(5000);assert.equal(count,2);assert.equal(updates.at(-1).quoteSource,'腾讯');stop();
});
await test('全源故障不捏造更新；第一轮失败立即退避到10秒', async () => {
  const updates=[], errors=[]; const h=harness(async()=>{throw new Error('HTTP 503');});
  const stop=h.provider.connect(stock,u=>updates.push(u),e=>errors.push(e));await h.run(150);
  assert.equal(updates.length,0);assert.equal(errors.length,1);assert.ok([...h.timers.values()].some(t=>t.ms===10000));stop();
});
await test('休市报价60秒、分时300秒，日K短时缓存', async () => {
  let dailyCalls=0;const h=harness(async url=>{if(url.includes('fqkline')){dailyCalls++;return daily;}return url.includes('qt.gtimg')?tencent:minute;},Date.parse('2026-08-29T10:00:00+08:00'));
  const stop=h.provider.connect(stock,()=>{});await h.run(150);
  assert.deepEqual([...h.timers.values()].map(t=>t.ms).sort((a,b)=>a-b),[60000,300000]);
  await h.provider.getDailyCandles(stock);await h.provider.getDailyCandles(stock);assert.equal(dailyCalls,1);stop();
});
await test('切换股票防抖取消，报价日期不匹配不显示旧分时', async () => {
  let calls=0; const updates=[];const h=harness(async url=>{calls++;return url.includes('qt.gtimg')?tencent:minute.replace('20260828','20260827');});
  const stop0=h.provider.connect(stock,()=>assert.fail('cancelled callback'));stop0();await h.run(150);assert.equal(calls,0);
  const stop=h.provider.connect(stock,u=>updates.push(u));await h.run(150);
  assert.deepEqual(updates.at(-1).history,[]);assert.match(updates.at(-1).historyMessage,/日期/);stop();
});
await test('未迁移的其他东方财富板块保持原生口径', async () => {
  const calls=[],errors=[];const h=harness(async url=>{calls.push(url);throw new Error('连接失败');});
  const stop=h.provider.connect({...stock,symbol:'880000',kind:'sector',dataSymbol:'90.BK0448'},()=>{},e=>errors.push(e));await h.run(150);
  assert.ok(calls.length===2 && calls.every(u=>u.includes('eastmoney.com')&&u.includes('90.BK0448')));
  assert.match(errors[0],/板块数据源待恢复/);stop();
});
await test('沪深北代码路由，北交所920代码不误投上海', () => {
  for (const [symbol,id] of [['603118','sh603118'],['000001','sz000001'],['300750','sz300750'],['920001','bj920001'],['430047','bj430047'],['000300','sh000300']]) {
    assert.equal(data.mainlandId({...stock,symbol}),id);
  }
});
await test('手动新浪优先与分时腾讯故障独立回退东方财富', async () => {
  const calls=[],updates=[]; const h=harness(async url=>{
    calls.push(url);
    if(url.includes('hq.sinajs')) return sina;
    if(url.includes('web.ifzq')) throw new Error('HTTP 503');
    if(url.includes('trends2')) return eastMinute;
    throw new Error('unexpected '+url);
  });
  h.provider.setPreference('sina');const stop=h.provider.connect(stock,u=>updates.push(u));await h.run(150);
  assert.equal(updates.at(-1).quoteSource,'新浪');assert.equal(updates.at(-1).historySource,'东方财富');
  assert.equal(updates.at(-1).history.length,1);assert.ok(!calls.some(url=>url.includes('qt.gtimg')));stop();
});
await test('旧报价错误不会被成功的分时回调清除', async () => {
  const updates=[];let broken=false;
  const h=harness(async url=>{
    if(url.includes('minute')) return minute;
    if(broken) throw new Error('offline');
    return tencent;
  });
  const stop=h.provider.connect(stock,u=>updates.push(u));await h.run(150);
  broken=true;h.clock.now+=5000;await h.run(5000);assert.ok(updates.at(-1).quoteError);
  h.clock.now+=30000;await h.run(30000);assert.ok(updates.at(-1).quoteError);assert.equal(updates.at(-1).snapshot.price,10.25);stop();
});
await test('881129旧映射自动迁移bk_881129并保留持仓字段',()=>{
  const migrated=data.normalizeInstrument(sector);
  assert.equal(migrated.dataSymbol,'bk_881129');assert.equal(migrated.quantity,600);assert.equal(migrated.costPrice,18.13);
  assert.equal(ths.tonghuashunId(migrated),'bk_881129');assert.deepEqual(data.normalizeInstrument(migrated),migrated);
});
await test('同花顺报价保留三位精度和行情时间，不使用17点响应时间',()=>{
  const q=ths.parseTonghuashunQuote(thsQuote,'bk_881129');
  assert.equal(q.price,9494.464);assert.equal(q.previousClose,9585.511);
  assert.equal(q.timestamp,Date.parse('2026-08-28T15:00:00+08:00'));
  assert.equal(data.round((q.price-q.previousClose)/q.previousClose*100),-.95);
});
await test('JSONP拒绝错误代码、尾随脚本、时间缺失和HTML响应',()=>{
  assert.throws(()=>ths.parseTonghuashunQuote(thsQuote,'bk_881130'));
  assert.throws(()=>ths.parseTonghuashunQuote(thsQuote+';alert(1)','bk_881129'));
  assert.throws(()=>ths.parseTonghuashunQuote(thsQuote.replace('"updateTime"','"otherTime"'),'bk_881129'));
  assert.throws(()=>ths.parseTonghuashunQuote('<html>error</html>','bk_881129'));
  assert.throws(()=>ths.parseTonghuashunQuote(thsQuote.replace('"5":"881129"','"5":"881130"'),'bk_881129'));
});
await test('板块分时不把每股均价63元画到9500点坐标上',()=>{
  const r=ths.parseTonghuashunMinute(thsMinute,'bk_881129');
  assert.equal(r.history.length,2);assert.equal(r.quote.price,9494.464);assert.equal(r.quote.note,'分时末笔');
  assert.ok(r.history.every(p=>p.average===undefined));
  assert.throws(()=>ths.parseTonghuashunMinute(thsMinute.replace('0930,','2460,'),'bk_881129'));
  assert.throws(()=>ths.parseTonghuashunMinute(thsMinute.replace('20260828','20260231'),'bk_881129'));
});
await test('日K字段顺序正确并合并当日K线，日期去重',()=>{
  const h=ths.parseTonghuashunDaily(thsDaily,'bk_881129');const today=ths.parseTonghuashunToday(thsToday,'bk_881129');
  assert.equal(h[0].high,9589.994);assert.equal(h[0].close,9585.511);
  const merged=ths.mergeTonghuashunDaily(h,[today]);assert.equal(merged.length,2);assert.equal(merged.at(-1).close,9494.464);
  assert.deepEqual(ths.mergeTonghuashunDaily(merged,[today]),merged);
});
await test('板块分时故障不阻断实时报价；不调用其他平台',async()=>{
  const calls=[],updates=[],errors=[];const h=harness(async url=>{calls.push(url);if(url.includes('realhead'))return thsQuote;throw Error('offline');});
  const stop=h.provider.connect(sector,u=>updates.push(u),e=>errors.push(e));await h.run(150);
  assert.equal(updates.at(-1).snapshot.price,9494.464);assert.match(updates.at(-1).historyMessage,/待恢复/);
  assert.equal(errors.length,0);assert.ok(calls.every(u=>u.startsWith('https://d.10jqka.com.cn/')));stop();
});
await test('板块报价故障回退真实分时末笔，缓存合并重复请求',async()=>{
  const calls=[],updates=[];const h=harness(async url=>{calls.push(url);if(url.includes('realhead'))throw Error('HTTP 502');return thsMinute;});
  const stop=h.provider.connect(sector,u=>updates.push(u));await h.run(150);
  assert.equal(updates.at(-1).quoteSource,'同花顺（分时末笔）');assert.equal(updates.at(-1).snapshot.price,9494.464);
  assert.equal(updates.at(-1).history.length,2);assert.equal(calls.filter(u=>u.includes('/time/')).length,1);stop();
});
await test('同花顺v6分时故障转v4同代码，个股优先级不污染板块',async()=>{
  const calls=[],updates=[];const h=harness(async url=>{calls.push(url);if(url.includes('realhead'))return thsQuote;if(url.includes('/v6/'))throw Error('HTTP 503');return thsMinute.replace('quotebridge_v6_','quotebridge_v4_');});
  h.provider.setPreference('eastmoney');const stop=h.provider.connect(sector,u=>updates.push(u));await h.run(150);
  assert.equal(updates.at(-1).history.length,2);assert.equal(updates.at(-1).historySource,'同花顺');
  assert.ok(calls.every(u=>u.includes('10jqka.com.cn')&&u.includes('bk_881129')));stop();
});
await test('同花顺全端点失败不冒用BK0448或模拟数据',async()=>{
  const calls=[],updates=[],errors=[];const h=harness(async url=>{calls.push(url);throw Error('HTTP 503');});
  const stop=h.provider.connect(sector,u=>updates.push(u),e=>errors.push(e));await h.run(150);
  assert.equal(updates.length,0);assert.equal(errors.length,1);assert.match(errors[0],/同花顺/);
  assert.ok(calls.every(u=>u.includes('bk_881129')&&!u.includes('BK0448')));stop();
});
await test('同花顺日K双版本回退、当日合并和缓存',async()=>{
  let calls=0;const h=harness(async url=>{calls++;if(url.includes('/v6/'))throw Error('HTTP 503');return (url.includes('today')?thsToday:thsDaily).replace('quotebridge_v6_','quotebridge_v4_');});
  const candles=await h.provider.getDailyCandles(sector);assert.equal(candles.at(-1).time,'2026-08-28');assert.equal(candles.length,2);
  await h.provider.getDailyCandles(sector);assert.equal(calls,4);
});
console.log(`RESULT ${passed}/${passed} passed`);
