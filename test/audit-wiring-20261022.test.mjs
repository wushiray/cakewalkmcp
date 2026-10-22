import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../lib/server.js';
import { shutdownShims } from './helpers.mjs';

const client = new Client({ name: 'release-guard-test', version: '1' });
const server = buildServer();
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
await client.connect(b);
after(async () => { await client.close(); await server.close(); await shutdownShims(); });
const call = (name, args) => client.callTool({ name, arguments: args });
const text = r => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

test('MCP deleteNotes refuses a missing or wrong confirmation before opening CAL', async () => {
  for (const confirm of [undefined, 'yes']) {
    const r = await call('cw_cal_run', { program: 'deleteNotes', minKey: 0, maxKey: 127, confirm });
    assert.equal(r.isError, true);
    assert.match(text(r), /NEEDS_CONFIRMATION/);
  }
});
test('MCP raw command and classified command share destructive LOWORD gates', async () => {
  for (const name of ['cw_run_command', 'cw_run_command_classified']) {
    for (const cmdId of [0xE102, 0xE102 + 65536, 0x805D, 0x805D + 65536]) {
      const r = await call(name, { cmdId });
      assert.equal(r.isError, true);
      assert.match(text(r), /NEEDS_CONFIRMATION/);
    }
  }
});
test('MCP schemas reject out-of-range CAL intervals without generating a script', async () => {
  for (const name of ['cw_cal_plan', 'cw_cal_run']) {
    for (const iv of [-128, 128, 1000000000, 1.5]) {
      const r = await call(name, { program: 'addNotes', intervals: [iv] });
      assert.equal(r.isError, true, `${name}: ${iv}`);
    }
  }
});
test('MCP dialog cleanup rejects missing acknowledgement; schemas expose both tokens', async () => {
  const r = await call('cw_close_overlays', { closeDialogs: true });
  assert.equal(r.isError, true);
  assert.match(text(r), /NEEDS_CONFIRMATION/);
  const tools = (await client.listTools()).tools;
  for (const name of ['cw_cal_run', 'cw_run_command_classified', 'cw_close_overlays']) {
    assert.ok(tools.find(t => t.name === name).inputSchema.properties.confirm, name);
  }
});
