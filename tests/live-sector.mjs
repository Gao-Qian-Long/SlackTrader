// npm test transpiles the production modules. Read responses from Rust's live_sector_endpoints.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import * as ths from '../artifacts/market-fix/test-built/tonghuashun.mjs';
import {EastmoneyMarketProvider} from '../artifacts/market-fix/test-built/eastmoneyProvider.mjs';
const dir=process.argv[2];assert.ok(dir,'Usage: node tests/live-sector.mjs <MARKET_LIVE_OUTPUT>');
const names=['ths-quote','ths-minute','ths-minute-v4','ths-daily','ths-today','ths-daily-v4','ths-today-v4'];
const files=Object.fromEntries(await Promise.all(names.map(async name=>[name,await readFile(path.join(dir,name+'.txt'),'utf8')])));
const quote=ths.parseTonghuashunQuote(files['ths-quote'],'bk_881129');
const minute=ths.parseTonghuashunMinute(files['ths-minute'],'bk_881129');
const h=ths.parseTonghuashunDaily(files['ths-daily'],'bk_881129');
const today=ths.parseTonghuashunToday(files['ths-today'],'bk_881129');
const daily=ths.mergeTonghuashunDaily(h,[today]);
assert.equal(quote.name,'通信设备');assert.equal(quote.previousClose,minute.quote.previousClose);
assert.ok(minute.history.length>100);assert.ok(daily.length>=80);
assert.ok(minute.history.every(p=>p.average===undefined));
assert.ok(Math.abs(quote.price-minute.quote.price)/quote.price<.05);
assert.equal(today.time,new Date(quote.timestamp+8*3600_000).toISOString().slice(0,10));
assert.equal(daily.at(-1).time,today.time);
assert.ok(ths.parseTonghuashunMinute(files['ths-minute-v4'],'bk_881129','v4').history.length>100);
assert.equal(ths.parseTonghuashunToday(files['ths-today-v4'],'bk_881129','v4').time,today.time);
assert.ok(ths.parseTonghuashunDaily(files['ths-daily-v4'],'bk_881129','v4').length>=80);
const tasks=new Map();let timer=0;const calls=[];
const provider=new EastmoneyMarketProvider({now:()=>quote.timestamp,
  schedule:(fn,ms)=>{tasks.set(++timer,{fn,ms});return timer;},cancel:id=>tasks.delete(id),
  request:async url=>{calls.push(url);return url.includes('/realhead/')?files['ths-quote']:url.includes('/time/')?files['ths-minute']:url.includes('today.js')?files['ths-today']:files['ths-daily'];}});
const updates=[],errors=[];
const stock={symbol:'881129',name:'通信设备',kind:'sector',dataSymbol:'90.BK0448',previousClose:1000,seed:0};
const stop=provider.connect(stock,u=>updates.push(u),e=>errors.push(e));
for(const [id,task] of [...tasks])if(task.ms===150){tasks.delete(id);task.fn();}
for(let i=0;i<25;i++)await new Promise(setImmediate);
const update=updates.at(-1);assert.equal(errors.length,0);assert.ok(update);
assert.equal(update.snapshot.price,quote.price);assert.equal(update.snapshot.stock.dataSymbol,'bk_881129');
assert.equal(update.history.length,minute.history.length);assert.equal(update.quoteSource,'同花顺');
assert.deepEqual(await provider.getDailyCandles(stock),daily);stop();assert.equal(tasks.size,0);
assert.ok(calls.every(url=>url.includes('10jqka.com.cn')&&url.includes('bk_881129')));
console.log(`LIVE_SECTOR_QUOTE=PASS code=881129 name=${quote.name} price=${quote.price} previousClose=${quote.previousClose} changePercent=${update.snapshot.changePercent} timestamp=${new Date(quote.timestamp).toISOString()}`);
console.log(`LIVE_SECTOR_CHART=PASS minute=${minute.history.length} last=${minute.quote.price} candles=${daily.length} lastDay=${daily.at(-1).time} close=${daily.at(-1).close} noInvalidAverage=true`);
console.log('LIVE_SECTOR_PROVIDER=PASS migrated=true quote=true minute=true daily=true callbacksCancelled=true');
