import test from 'node:test';import assert from 'node:assert/strict';
test('offline reference hits make no request and online failures remain structured',async()=>{
 const {ReferenceSearch}=await import('../http-mcp/src/reference/search.ts');let requests=0;
 const search=new ReferenceSearch(true,async()=>{requests++;throw Error('offline');});
 const hit=await search.search({query:'PLAYER_PED_ID'});assert.equal(hit.searchedOnline,false);assert.equal(requests,0);assert.equal(hit.items[0].name,'PLAYER_PED_ID');
 await assert.rejects(search.search({query:'unfindable'}),/REFERENCE_UNAVAILABLE/);assert.ok(requests>0);
 const off=new ReferenceSearch(false,async()=>{throw Error('must not fetch');});assert.deepEqual((await off.search({query:'unfindable'})).items,[]);
});
