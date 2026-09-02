import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const main=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
const native=await readFile(new URL('../src-tauri/src/lib.rs',import.meta.url),'utf8');
const ast=ts.createSourceFile('main.ts',main,ts.ScriptTarget.Latest,true);
let passed=0;
function test(name,fn){fn();passed++;console.log('PASS '+name);}
test('窗口静态HTML不包含悬停title',()=>assert.doesNotMatch(main,/\stitle\s*=\s*["']/));
test('报价刷新、切股与错误分支不重新写入title',()=>{
  const visit=node=>{
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&ts.isPropertyAccessExpression(node.left))assert.notEqual(node.left.name.text,'title');
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='setAttribute'){
      const first=node.arguments[0];if(first&&ts.isStringLiteral(first))assert.notEqual(first.text,'title');
    }
    ts.forEachChild(node,visit);
  };visit(ast);
});
test('原生托盘不设置提示，前端不推送盈亏tooltip',()=>{
  assert.doesNotMatch(native,/\.tooltip\s*\(|set_tooltip\s*\(|fn update_tray_tooltip/);
  assert.doesNotMatch(main,/update_tray_tooltip/);
});
test('诊断详情默认折叠，只保留主动查看入口',()=>{
  assert.match(main,/<details class="market-diagnostics"><summary>行情详情（点击查看）<\/summary>/);
  assert.doesNotMatch(main,/market-diagnostics[^>]*\sopen[\s=>]/);
  assert.match(main,/#market-details/);assert.doesNotMatch(main,/悬停查看原因/);
});
test('保留按钮和股票标签的无障碍名称',()=>{
  for(const label of ['展开','收回','隐藏','设置'])assert.ok(main.includes('aria-label="'+label+'"'));
  assert.match(main,/tab\.setAttribute\("aria-label"/);
});
test('日K悬停不弹出轴价格标签',()=>{
  assert.match(main,/vertLine: \{[^}]*labelVisible: false/);
  assert.match(main,/horzLine: \{[^}]*labelVisible: false/);
});
console.log(`NO_HOVER_RESULT ${passed}/${passed} passed`);
