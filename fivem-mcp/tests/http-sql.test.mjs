import test from 'node:test';import assert from 'node:assert/strict';
test('only the defined SELECT grammar bypasses confirmation',async()=>{
 const {isReadOnly}=await import('../http-mcp/src/adapters/sql.ts');
 for(const sql of ['SELECT 1',"SELECT ';'",'SELECT * FROM users WHERE id = ? LIMIT 10','SELECT COUNT(*) FROM users','SELECT id FROM users WHERE (id IN (1,2) OR name LIKE ?) ORDER BY id DESC LIMIT 1'])assert.equal(isReadOnly('query',sql),true,sql);
 for(const sql of ['SELECT sleep(1)','SELECT custom_func()','SELECT * INTO OUTFILE \'x\'','SELECT * FROM users FOR UPDATE','WITH x AS (SELECT 1) SELECT * FROM x','SELECT 1 -- comment','SELECT 1; SELECT 2','SELECT (SELECT 1)','SELECT @x','SELECT db.COUNT(*)','SELECT "x"',"SELECT 'bad\\x'",'SELECT','SELECT * FROM a JOIN b'])assert.equal(isReadOnly('query',sql),false,sql);
 assert.equal(isReadOnly('transaction','SELECT 1'),false);
});
