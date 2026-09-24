import test from 'node:test';
import assert from 'node:assert/strict';
import { HostScheduler } from '../http-mcp/src/execution/host.ts';
test('host dispatch is deferred, bounded, fair and stopped work never runs', async()=>{
  const host=new HostScheduler(),order=[];
  const pending=Array.from({length:10},(_,i)=>host.run(()=>order.push(i)));
  pending.push(host.run(()=>order.push('execute'),true));
  assert.deepEqual(order,[]);host.tick();await Promise.all(pending);
  assert.equal(order[8],'execute');
  const stopped=host.run(()=>order.push('bad'));host.stop();
  await assert.rejects(stopped,/HOST_UNAVAILABLE/);host.tick();assert.equal(order.includes('bad'),false);
});
