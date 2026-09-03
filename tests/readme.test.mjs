import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const readme=await readFile(new URL('../README.md',import.meta.url),'utf8');
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
test('README使用正式项目名称和当前版本',()=>{
  assert.match(readme,/^# SlackTrader（蓝牙助手）/);assert.match(readme,/> 当前版本：\*\*v0\.4\*\*/);
});
test('README不包含具体证券、板块代码或旧映射',()=>{
  assert.doesNotMatch(readme,/\b(?:[0368]\d{5}|BK\d{4}|bk_\d{6})\b/);
  assert.doesNotMatch(readme,/特定标的名称|旧版映射/);
});
test('README不嵌入可能包含用户配置的截图',()=>assert.doesNotMatch(readme,/!\[[^\]]*\]\([^)]*\)/));
test('README包含隐私、限制、安装和免责声明',()=>{
  for(const heading of ['## 安装与升级','## 数据与隐私','## 已知限制','## 免责声明'])assert.ok(readme.includes(heading));
});
test('README发布资产统一指向v0.4',()=>{
  for(const name of ['Setup-x64.exe','Portable-x64.exe','Source.zip'])assert.ok(readme.includes(`SlackTrader-v0.4-${name}`));
  assert.doesNotMatch(readme,/SlackTrader-v0\.[0-3]-/);
});
test('README没有本地状态或内部调试记录',()=>assert.doesNotMatch(readme,/本地未发布|长期空白|内部调试|原始代码|用户个人/));
test('README区分开发分支与已发布版本并说明详细图和量柱',()=>{
  for(const text of ['## 开发分支更新','尚未更新到 Release 安装包','详细图','返回小图','分钟成交量','780 × 440','关联板块对照','不是交易所逐笔成交'])assert.ok(readme.includes(text));
});
console.log(`README_RESULT ${passed}/${passed} passed`);
