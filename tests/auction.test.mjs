import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const out = new URL('../artifacts/auction-flow/test-built/', import.meta.url);
await mkdir(out, { recursive: true });
for (const file of ['marketData', 'tonghuashun', 'marketHealth', 'eastmoneyProvider']) {
  const source = await readFile(new URL(`../src/market/${file}.ts`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll('"./marketData"', '"./marketData.mjs"').replaceAll('"./tonghuashun"', '"./tonghuashun.mjs"').replaceAll('"./marketHealth"', '"./marketHealth.mjs"');
  await writeFile(new URL(`${file}.mjs`, out), js);
}
const data = await import(new URL('marketData.mjs', out));
const { EastmoneyMarketProvider } = await import(new URL('eastmoneyProvider.mjs', out));
const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const stock = { symbol:'603118', name:'测试股票', previousClose:10, seed:0 };
const quote = (time, price, lots) => {
  const f=Array(34).fill('');Object.assign(f,{1:'测试股票',2:'603118',3:String(price),4:'10',6:String(lots),30:`20260828${time}`});
  return `v_sh603118="${f.join('~')}";`;
};
const flush=async()=>{for(let i=0;i<15;i++)await new Promise(setImmediate);};
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name);}

await test('集合竞价状态和源时间边界严格限定',()=>{
  assert.equal(data.marketStatus(Date.parse('2026-08-28T09:15:00+08:00')),'auction');
  assert.equal(data.marketStatus(Date.parse('2026-08-28T09:29:59+08:00')),'auction');
  assert.equal(data.marketStatus(Date.parse('2026-08-28T09:30:00+08:00')),'trading');
  assert.equal(data.isOpeningAuctionTime(Date.parse('2026-08-28T09:25:00+08:00')),true);
  assert.equal(data.isOpeningAuctionTime(Date.parse('2026-08-28T09:25:01+08:00')),false);
});

await test('只采集行情源带时间戳的真实竞价价和源累计量，不生成历史',async()=>{
  let q=quote('091503',10.12,100),id=0;
  let now=Date.parse('2026-08-28T09:16:00+08:00');
  const timers=new Map(),updates=[];
  const provider=new EastmoneyMarketProvider({now:()=>now,request:async url=>{
    if(url.includes('qt.gtimg'))return q;throw Error('分时无竞价历史');
  },schedule:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},cancel:key=>timers.delete(key)});
  const stop=provider.connect(stock,u=>updates.push(u));
  for(const [key,t] of [...timers])if(t.ms===150){timers.delete(key);t.fn();}await flush();
  assert.equal(updates.at(-1).auction.length,1);assert.equal(updates.at(-1).auction[0].reportedVolume,10000);
  assert.ok([...timers.values()].some(t=>t.ms===3000));
  q=quote('091506',10.15,160);
  now+=3000;
  for(const [key,t] of [...timers])if(t.ms===3000){timers.delete(key);t.fn();}await flush();
  assert.deepEqual(updates.at(-1).auction.map(p=>[p.price,p.volume,p.reportedVolume]),[[10.12,10000,10000],[10.15,6000,16000]]);
  q=quote('092600',10.20,200);
  now+=3000;
  for(const [key,t] of [...timers])if(t.ms===3000){timers.delete(key);t.fn();}await flush();
  assert.equal(updates.at(-1).auction.length,2);stop();
});

await test('拒绝上一交易日的竞价快照，不显示为当天竞价',async()=>{
  let id=0;const timers=new Map(),updates=[];
  const now=Date.parse('2026-08-31T09:16:00+08:00');
  const provider=new EastmoneyMarketProvider({now:()=>now,request:async url=>{if(url.includes('qt.gtimg'))return quote('091600',10.18,120);throw Error('无分时');},schedule:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},cancel:key=>timers.delete(key)});
  const stop=provider.connect(stock,u=>updates.push(u));for(const [key,t] of [...timers])if(t.ms===150){timers.delete(key);t.fn();}await flush();
  assert.deepEqual(updates.at(-1).auction,[]);assert.match(updates.at(-1).auctionMessage,/等待真实竞价/);stop();
});

await test('竞价按钮只在详细图显示，时间轴端点对齐并显示区间量柱和源累计量',()=>{
  assert.match(main,/data-mode="auction">竞价/);assert.match(css,/body\.detailed \.chart-tabs button\[data-mode="auction"\]/);
  const ast=ts.createSourceFile('main.ts',main,ts.ScriptTarget.Latest,true);
  const draw=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='drawIntradayChart').getText(ast);
  const texts=[],paths=[],bars=[];const context={textAlign:'left',fillText(text,x,y){texts.push({text,x,y,align:this.textAlign})},beginPath(){paths.push([])},moveTo(x,y){paths.at(-1)?.push([x,y])},lineTo(x,y){paths.at(-1)?.push([x,y])},stroke(){},setLineDash(){},setTransform(){},clearRect(){},save(){},restore(){},rect(){},clip(){},fillRect(x,y,width,height){bars.push({x,y,width,height})}};
  const canvas={clientWidth:600,clientHeight:300,getContext:()=>context};
  const points=['09:15','09:20','09:25'].map((t,i)=>({time:Date.parse(`2026-08-28T${t}:00+08:00`)/1000,price:10+i*.1,average:99,volume:(i+1)*100,reportedVolume:(i+1)*100}));
  vm.runInNewContext(ts.transpileModule(draw,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+';drawIntradayChart()',{latestUpdate:{auction:points,snapshot:{stock:{previousClose:10}}},chartMode:'auction',compact:false,detailed:true,sectorComparison:false,theme:{muted:'#777',up:'#aaa',down:'#555',line:'#999',average:'#123',volumeUp:'#a66',volumeDown:'#6a6'},window:{devicePixelRatio:1},document:{querySelector:()=>canvas}});
  for(const label of ['09:15','09:20','09:25','成交量','累计 300股'])assert.ok(texts.some(item=>item.text===label));
  assert.equal(texts.find(item=>item.text==='09:15').align,'left');
  assert.equal(texts.find(item=>item.text==='09:20').align,'center');
  assert.equal(texts.find(item=>item.text==='09:25').align,'right');
  assert.equal(bars.length,3);
  assert.equal(context.strokeStyle,'#999');
  assert.match(main,/auctionHistoryV1:/);assert.match(main,/retainAuctionForToday\(update\)/);
});

await test('当天竞价采样本地保存并在重启模型中恢复，过期数据不恢复',()=>{
  const ast=ts.createSourceFile('main.ts',main,ts.ScriptTarget.Latest,true);
  const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text==='retainAuctionForToday').getText(ast).replace('Date.now()','now');
  const store=new Map(),localStorage={setItem:(k,v)=>store.set(k,v),getItem:k=>store.get(k)??null,removeItem:k=>store.delete(k)};
  const now=Date.parse('2026-08-28T10:00:00+08:00'),point={time:Date.parse('2026-08-28T09:20:00+08:00')/1000,price:10.2,average:10.2,volume:100,reportedVolume:100};
  const context={localStorage,now,chinaDate:data.chinaDate,isOpeningAuctionTime:data.isOpeningAuctionTime};vm.runInNewContext(ts.transpileModule(fn,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const base={snapshot:{stock:{...stock},timestamp:now},auction:[point]};context.retainAuctionForToday(base);assert.equal(store.size,1);
  const restored={snapshot:{stock:{...stock},timestamp:now},auction:[],auctionMessage:'等待'};context.retainAuctionForToday(restored);assert.equal(restored.auction.length,1);assert.equal(restored.auctionMessage,undefined);
  const stale={snapshot:{stock:{...stock},timestamp:Date.parse('2026-08-27T15:00:00+08:00')},auction:[]};context.retainAuctionForToday(stale);assert.deepEqual(stale.auction,[]);
});

console.log(`AUCTION_RESULT ${passed}/${passed} passed`);
