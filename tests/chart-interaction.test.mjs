import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const main=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
test('日K默认使用红涨绿跌且颜色可调',()=>{
  assert.match(main,/candleUp: "#df3f45"/);assert.match(main,/candleDown: "#20a66a"/);
  assert.match(main,/upColor: theme\.candleUp/);assert.match(main,/downColor: theme\.candleDown/);
  assert.match(main,/\['candleUp','K线上涨'\]/);assert.match(main,/\['candleDown','K线下跌'\]/);
});
test('Ctrl滚轮围绕鼠标位置缩放并限制范围',()=>{
  assert.match(main,/chartMode !== "daily" \|\| !event\.ctrlKey/);
  assert.match(main,/coordinateToLogical\(event\.offsetX\)/);
  assert.match(main,/Math\.max\(8, Math\.min\(150,/);
  assert.match(main,/setVisibleLogicalRange/);
});
test('普通滚轮在日K区域不切换股票',()=>assert.match(main,/closest\("#chart"\).*return/));
test('Ctrl滚轮阻止WebView页面缩放',()=>assert.match(main,/event\.ctrlKey\) \{ event\.preventDefault\(\); return; \}/));
test('日K支持拖动平移和双击复位',()=>{
  assert.match(main,/pressedMouseMove: true/);assert.match(main,/dailyChart\.addEventListener\("dblclick"/);
  assert.match(main,/chart\.timeScale\(\)\.fitContent\(\)/);
});
test('刷新日K不会覆盖用户缩放范围',()=>assert.match(main,/if \(!dailyZoomAdjusted\) chart\.timeScale\(\)\.fitContent\(\)/));
console.log(`CHART_INTERACTION_RESULT ${passed}/${passed} passed`);
