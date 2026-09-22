import test from 'node:test';
import assert from 'node:assert/strict';
test('log filters apply before recent limit and raw is opt-in',async()=>{
  const {LogStore}=await import('../http-mcp/src/logs/store.ts');
  const logs=new LogStore();logs.available=true;
  logs.append('script:example','^1first');logs.append('script:other','second');logs.append('script:example','last');
  const result=logs.query({resource:'example',limit:1});
  assert.equal(result.lines.length,1);assert.equal(result.lines[0].message,'last');assert.equal(result.lines[0].raw,undefined);
  assert.equal(logs.query({contains:'first',includeRaw:true}).lines[0].raw,'^1first');
});
