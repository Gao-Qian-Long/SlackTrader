import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const read = file => readFile(new URL('../' + file, import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const data = await import('data:text/javascript;base64,' + Buffer.from(compile(await read('src/market/marketData.ts'))).toString('base64'));
const ths = await import('data:text/javascript;base64,' + Buffer.from(compile(await read('src/market/tonghuashun.ts')).replace('from "./marketData"', 'from ' + JSON.stringify('data:text/javascript;base64,' + Buffer.from(compile(await read('src/market/marketData.ts'))).toString('base64')))).toString('base64'));
const main = await read('src/main.ts'), css = await read('src/styles.css');
const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
const draw = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name.text === 'drawIntradayChart').getText(ast);
const theme = {volumeUp:'#8a6265',volumeDown:'#52766a',muted:'#596168',up:'#8e969c',down:'#737b81',line:'#858f96',average:'#686b6d'};
const point = (time, price, volume) => ({time:Date.parse(`2026-09-03T${time}:00+08:00`)/1000,price,volume});
function render(history, {width=300,height=112,ratio=1,compact=false,chartMode='intraday',detailed=false}={}) {
  const bars=[],texts=[];
  const context = {globalAlpha:1,save(){this.savedAlpha=this.globalAlpha;},restore(){this.globalAlpha=this.savedAlpha;},
    fillRect(x,y,w,h){bars.push({x,y,w,h,color:this.fillStyle,alpha:this.globalAlpha});},fillText(text,x,y){texts.push({text,x,y});}};
  for(const key of ['setTransform','clearRect','beginPath','moveTo','lineTo','stroke','setLineDash','rect','clip'])context[key]=()=>{};
  const canvas = {clientWidth:width,clientHeight:height,getContext:()=>context};
  vm.runInNewContext(compile(draw)+';drawIntradayChart();',{latestUpdate:{history,snapshot:{stock:{previousClose:10}}},compact,chartMode,detailed,
    theme,document:{querySelector:()=>canvas},window:{devicePixelRatio:ratio}});
  return {bars,texts,context,canvas};
}
let passed=0;
const test=(name,fn)=>{fn();passed++;console.log('PASS '+name);};
const tencent=rows=>JSON.stringify({data:{sz000001:{data:{date:'20260903',data:rows}}}});
test('腾讯累计量先排序去重再转分钟量，均价保持累计口径',()=>{
  const points=data.parseTencentMinute(tencent(['0932 10 250 250000','0930 10 100 100000','0931 10 190 190000','0931 10 200 200000']),'sz000001');
  assert.deepEqual(points.map(p=>p.volume),[10000,10000,5000]);assert.ok(points.every(p=>p.average===10));
});
test('累计量的缺失、回退、零增量不会产生负数或虚假峰值',()=>{
  const points=data.parseTencentMinute(tencent(['0930 10 100 100000','0931 10 x x','0932 10 90 90000','0933 10 100 100000','0934 10 120 120000']),'sz000001');
  assert.deepEqual(points.map(p=>p.volume),[10000,0,0,0,2000]);
});
test('东方财富分钟量不重复差分，手换股',()=>{
  const points=data.parseEastmoneyMinute(JSON.stringify({data:{trends:['2026-09-03 09:30,10,10,10,10,200,200000,10','2026-09-03 09:31,10,10,10,10,100,100000,10']}}));
  assert.deepEqual(points.map(p=>p.volume),[20000,10000]);
});
test('同花顺板块分钟量保持原始口径',()=>{
  const body={bk_881129:{name:'测试板块',pre:'1000',date:'20260903',data:'0930,1001,10000,10,1000;0931,1002,5000,10,500'}};
  const parsed=ths.parseTonghuashunMinute(`quotebridge_v6_time_bk_881129_last(${JSON.stringify(body)})`,'bk_881129');
  assert.deepEqual(parsed.history.map(p=>p.volume),[1000,500]);assert.equal(parsed.quote.volume,1500);
});
test('量柱按相邻分钟价格分低调红绿，平价灰色，比例正确',()=>{
  const r=render([point('09:30',11,100),point('09:31',10,50),point('09:32',10,25)]);
  assert.deepEqual(r.bars.map(b=>b.color),[theme.volumeUp,theme.volumeDown,theme.muted]);
  assert.equal(r.bars[0].h/r.bars[1].h,2);assert.equal(r.bars[1].h/r.bars[2].h,2);
  assert.ok(r.bars.every(b=>b.alpha===.65));assert.equal(r.context.globalAlpha,1);
});
test('午休不留空档、开收盘柱不越界，高DPI尺寸正确',()=>{
  for(const ratio of [1,1.25,1.5,2])for(const [width,height] of [[300,112],[375,150],[232,90]]) {
    const r=render([point('09:30',11,10),point('11:30',10,30),point('13:00',11,20),point('15:00',10,40)],{width,height,ratio});
    assert.equal(r.bars[1].x,r.bars[2].x);assert.equal(r.canvas.width,Math.round(width*ratio));
    assert.ok(r.bars.every(b=>b.x>=29&&b.x+b.w<=width-38&&b.y>=18&&b.y+b.h<=height-14));
  }
});
test('缺失或异常成交量不画假柱，小窗和日K不受影响',()=>{
  const history=[point('09:30',10,0),point('09:31',10,-1),point('09:32',10,NaN)];
  assert.equal(render(history).bars.length,0);assert.ok(render(history).texts.some(t=>t.text==='量—'));
  assert.equal(render([]).bars.length,0);
  assert.equal(render([point('09:30',11,10)],{compact:true}).bars.length,0);
  assert.equal(render([point('09:30',11,10)],{chartMode:'daily'}).bars.length,0);
});
test('顶部26px横排保留按钮空间和拖动，新量柱色向后兼容且可调整',()=>{
  assert.match(css,/grid-template-rows: 26px 1fr 28px/);assert.match(css,/padding: 2px 49px 2px 7px/);
  assert.match(css,/\.identity \{ display: flex; align-items: center/);
  assert.match(css,/\.quote \{ display: flex; align-items: center/);
  assert.match(css,/\.identity \.stock-name \{[^}]*text-overflow: ellipsis/);
  assert.match(main,/<header class="topbar" data-drag-handle>/);
  assert.match(main,/\['volumeUp','量柱上涨'\]/);assert.match(main,/\['volumeDown','量柱下跌'\]/);
  assert.match(main,/return \{ \.\.\.DEFAULT_THEME, \.\.\.JSON\.parse/);
});
test('详细图扩大量柱并提供5个时间刻度和量轴',()=>{
  const r=render([point('09:30',11,10000),point('15:00',10,5000)],{width:638,height:304,detailed:true});
  assert.equal(r.bars[0].h,64);assert.ok(r.bars[0].x>=43);assert.ok(r.bars[1].x+r.bars[1].w<=638-52);
  for(const text of ['09:30','10:30','11:30/13:00','14:00','15:00','1.0万','0'])assert.ok(r.texts.some(t=>t.text===text));
});
for (const scale of [1, 1.5, 2]) {
  const declarations=['setCompact','toggleDetailed'].map(name=>ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name.text===name).getText(ast)).join('\n');
  const area={position:{x:-800,y:0},size:{width:800,height:500}};
  const state={position:{x:-250,y:450},size:{width:232*scale,height:28*scale},mode:'daily',button:{setAttribute(){}}};
  const context=vm.createContext({document:{body:{classList:{toggle(){}}},querySelector:s=>s==='.detail-button'?state.button:{classList:{remove(){}}}},
    localStorage:{setItem(){}},isTauri:true,resizeGeneration:0,microAnchorPosition:null,compact:true,detailed:false,
    currentMonitor:async()=>({scaleFactor:scale,workArea:area}),
    appWindow:{outerPosition:async()=>state.position,outerSize:async()=>state.size,setPosition:async p=>{state.position=p;},setSize:async s=>{state.size={width:s.width*scale,height:s.height*scale};}},
    PhysicalPosition:class{constructor(x,y){this.x=x;this.y=y;}},LogicalSize:class{constructor(width,height){this.width=width;this.height=height;}},
    setChartMode:mode=>{state.mode=mode;},setTimeout:fn=>fn(),chart:{timeScale:()=>({fitContent(){}})},drawIntradayChart(){}});
  vm.runInContext(compile(declarations),context);
  await vm.runInContext('toggleDetailed()',context);
  assert.equal(state.mode,'intraday');assert.equal(state.button.textContent,'返回小图');assert.equal(context.compact,false);
  assert.equal(state.size.width,Math.min(640,Math.floor(800/scale)-16)*scale);
  assert.equal(state.size.height,Math.min(360,Math.floor(500/scale)-16)*scale);
  assert.ok(state.position.x>=-800&&state.position.x+state.size.width<=0&&state.position.y>=0&&state.position.y+state.size.height<=500);
  await vm.runInContext('toggleDetailed()',context);assert.equal(state.size.width,300*scale);assert.equal(state.button.textContent,'详细图');
  await vm.runInContext('toggleDetailed();',context);await vm.runInContext('setCompact(true)',context);
  assert.equal(context.detailed,false);assert.equal(state.size.width,232*scale);
  await vm.runInContext('setCompact(false)',context);assert.equal(state.size.width,300*scale);
  console.log(`PASS 详细图切换/收回/再展开和工作区适配 scale=${scale}`);passed++;
}
console.log(`INTRADAY_VOLUME_RESULT ${passed}/${passed} passed`);
