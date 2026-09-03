import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const readme=await readFile(new URL('../README.md',import.meta.url),'utf8');
const version=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version;
const tag=`v${version.split('.').slice(0,2).join('.')}`;
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
test('README使用正式项目名称和当前版本',()=>{
  assert.match(readme,/^# SlackTrader（蓝牙助手）/);assert.ok(readme.includes(`> 当前版本：**${tag}**`));
});
test('README不包含具体证券、板块代码或旧映射',()=>{
  assert.doesNotMatch(readme,/\b(?:[0368]\d{5}|BK\d{4}|bk_\d{6})\b/);
  assert.doesNotMatch(readme,/特定标的名称|旧版映射/);
});
test('README不嵌入可能包含用户配置的截图',()=>assert.doesNotMatch(readme,/!\[[^\]]*\]\([^)]*\)/));
test('README包含隐私、限制、安装和免责声明',()=>{
  for(const heading of ['## 安装与升级','## 数据与隐私','## 已知限制','## 免责声明'])assert.ok(readme.includes(heading));
});
test('README发布资产统一指向当前版本',()=>{
  for(const name of ['Setup-x64.exe','Portable-x64.exe','Source.zip'])assert.ok(readme.includes(`SlackTrader-${tag}-${name}`));
  assert.doesNotMatch(readme,/SlackTrader-v0\.[0-3]-/);
});
test('README没有本地状态或内部调试记录',()=>assert.doesNotMatch(readme,/本地未发布|长期空白|内部调试|原始代码|用户个人/));
test('README说明当前已发布功能、详细图和量柱',()=>{
  for(const text of [`## ${tag} 更新`,'安装版、便携版及源码均包含下列更新','详细图','返回小图','分钟成交量','780 × 440','关联板块对照','不是交易所逐笔成交'])assert.ok(readme.includes(text));
});
console.log(`README_RESULT ${passed}/${passed} passed`);
