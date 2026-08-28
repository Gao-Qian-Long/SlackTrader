import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const out = new URL('../artifacts/market-fix/test-built/', import.meta.url);
await mkdir(out, { recursive: true });
for (const file of ['marketData', 'eastmoneyProvider']) {
  const input = await readFile(new URL(`../src/market/${file}.ts`, import.meta.url), 'utf8');
  const js = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll('"./marketData"', '"./marketData.mjs"');
  await writeFile(new URL(`${file}.mjs`, out), js);
}
const data = await import(new URL('marketData.mjs', out));
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
  assert.equal(data.eastmoneyId({...stock,symbol:'881129'}),'90.BK0448');
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
await test('板块只访问原东方财富口径', async () => {
  const calls=[],errors=[];const h=harness(async url=>{calls.push(url);throw new Error('连接失败');});
  const stop=h.provider.connect({...stock,symbol:'881129'},()=>{},e=>errors.push(e));await h.run(150);
  assert.ok(calls.length===2 && calls.every(u=>u.includes('eastmoney.com')&&u.includes('90.BK0448')));
  assert.match(errors[0],/板块原数据源异常/);stop();
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
console.log(`RESULT ${passed}/${passed} passed`);
