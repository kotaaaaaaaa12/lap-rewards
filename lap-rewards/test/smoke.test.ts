import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './fake.ts';
import { handleRequest } from '../src/index.ts';

test('health and schema bootstrap', async () => {
  const env = makeEnv();
  const res = await handleRequest(new Request('https://t.example/api/health'), env);
  assert.equal(res.status, 200);
  const st = await handleRequest(new Request('https://t.example/api/setup/status'), env);
  assert.deepEqual(await st.json(), { needed: true, token_configured: true });
});
