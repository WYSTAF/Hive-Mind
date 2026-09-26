/* ── API agents unit tests ── */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDERS, isApiAgent, buildChatRequest, extractText
} from '../src/lib/api_agents.js';

test('ApiAgentClient: resolves custom agents through REAL background wiring', async () => {
  const { ApiAgentClient } = await import('../src/lib/api_agents.js');
  // This mirrors src/background.js exactly — name => apiConfig[name].
  const apiConfig = {
    openrouter: { enabled: false, key: '' },
    customAgents: [{ id: 'c1', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', key: 'x', model: 'qwen', enabled: true }]
  };
  const client = new ApiAgentClient(name => (name === '*' ? apiConfig : apiConfig[name]));
  assert.equal(client.enabled('custom:c1'), true, 'custom agent must resolve via root config');
  assert.equal(client.enabled('openrouter'), false);
  // ask() must build a real request, not fail with not-configured:
  const origFetch = globalThis.fetch;
  let capturedUrl = null;
  globalThis.fetch = async (url) => { capturedUrl = String(url); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) }; };
  try {
    const res = await client.ask('custom:c1', [{ role: 'user', content: 'q' }]);
    assert.equal(res.status, 'done');
    assert.ok(capturedUrl.startsWith('http://127.0.0.1:11434/v1/chat/completions'));
  } finally {
    globalThis.fetch = origFetch;
  }
});

/* ═══ isApiAgent / PROVIDERS ═══ */
test('isApiAgent: recognizes the three providers only', () => {
  assert.equal(isApiAgent('openrouter'), true);
  assert.equal(isApiAgent('cloudflare'), true);
  assert.equal(isApiAgent('nvidia'), true);
  assert.equal(isApiAgent('chatgpt'), false);
  assert.equal(isApiAgent('nope'), false);
});

/* ═══ custom agents ("custom:<id>") ═══ */
import { getCustomAgent } from '../src/lib/api_agents.js';

const CUSTOM_CFG = {
  customAgents: [
    { id: 'c1', name: 'Local Llama', baseUrl: 'http://127.0.0.1:8080/v1', key: 'sk-x', model: 'llama-3-70b', enabled: true },
    { id: 'c2', name: 'Off', baseUrl: 'https://x/v1', key: 'k', model: 'm', enabled: false }
  ]
};

test('isApiAgent: custom:<id> ids are API agents', () => {
  assert.equal(isApiAgent('custom:c1'), true);
  assert.equal(isApiAgent('custom:nope'), true); // shape-valid; resolution happens later
  assert.equal(isApiAgent('custom'), false);
});

test('getCustomAgent: finds by id, null when absent', () => {
  assert.equal(getCustomAgent(CUSTOM_CFG, 'c1').name, 'Local Llama');
  assert.equal(getCustomAgent(CUSTOM_CFG, 'zz'), null);
  assert.equal(getCustomAgent(undefined, 'c1'), null);
});

test('buildChatRequest: custom agent URL normalizes to …/v1/chat/completions', () => {
  const req = buildChatRequest('custom:c1', CUSTOM_CFG, [{ role: 'user', content: 'hi' }]);
  assert.ok(req);
  assert.equal(req.url, 'http://127.0.0.1:8080/v1/chat/completions');
  const body = JSON.parse(req.init.body);
  assert.equal(body.model, 'llama-3-70b');
});

test('buildChatRequest: custom base without /v1 gets it appended', () => {
  const cfg = { customAgents: [{ id: 'c9', name: 'X', baseUrl: 'https://api.host/', key: 'k', model: 'm', enabled: true }] };
  const req = buildChatRequest('custom:c9', cfg, []);
  assert.equal(req.url, 'https://api.host/v1/chat/completions');
});

test('buildChatRequest: disabled/incomplete custom agents rejected', () => {
  assert.equal(buildChatRequest('custom:c2', CUSTOM_CFG, []), null, 'disabled');
  assert.equal(buildChatRequest('custom:missing', CUSTOM_CFG, []), null, 'unknown id');
  const noModel = { customAgents: [{ id: 'c3', name: 'N', baseUrl: 'https://h/v1', key: 'k', enabled: true }] };
  assert.equal(buildChatRequest('custom:c3', noModel, []), null, 'no model');
});

test('PROVIDERS: every entry has label, color, defaultModel', () => {
  for (const [key, p] of Object.entries(PROVIDERS)) {
    assert.ok(p.label && p.color && p.defaultModel, `provider ${key} incomplete`);
  }
});

/* ═══ buildChatRequest ═══ */
test('buildChatRequest: disabled or keyless config → null', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  assert.equal(buildChatRequest('openrouter', { enabled: false, key: 'k' }, msgs), null);
  assert.equal(buildChatRequest('openrouter', { enabled: true }, msgs), null);
  assert.equal(buildChatRequest('openrouter', null, msgs), null);
});

test('buildChatRequest: cloudflare requires accountId', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  assert.equal(buildChatRequest('cloudflare', { enabled: true, key: 'k' }, msgs), null);
  const req = buildChatRequest('cloudflare', { enabled: true, key: 'k', accountId: 'abc' }, msgs);
  assert.ok(req);
  assert.ok(req.url.includes('/accounts/abc/ai/run/'));
});

test('buildChatRequest: URLs point at the right hosts', () => {
  const msgs = [{ role: 'user', content: 'x' }];
  assert.ok(buildChatRequest('openrouter', { enabled: true, key: 'k' }, msgs).url.startsWith('https://openrouter.ai/api/v1/'));
  assert.ok(buildChatRequest('nvidia', { enabled: true, key: 'nvapi-x' }, msgs).url.startsWith('https://integrate.api.nvidia.com/v1/'));
});

test('buildChatRequest: model falls back to provider default', () => {
  const req = buildChatRequest('nvidia', { enabled: true, key: 'k' }, []);
  const body = JSON.parse(req.init.body);
  assert.equal(body.model, PROVIDERS.nvidia.defaultModel);
});

test('buildChatRequest: explicit model override wins', () => {
  const req = buildChatRequest('nvidia', { enabled: true, key: 'k', model: 'custom/model' }, []);
  const body = JSON.parse(req.init.body);
  assert.equal(body.model, 'custom/model');
});

test('buildChatRequest: cloudflare body omits model field (URL carries it)', () => {
  const req = buildChatRequest('cloudflare', { enabled: true, key: 'k', accountId: 'a' }, []);
  const body = JSON.parse(req.init.body);
  assert.equal(body.model, undefined);
  assert.ok(Array.isArray(body.messages));
});

test('buildChatRequest: unknown provider rejected', () => {
  assert.equal(buildChatRequest('chatgpt', { enabled: true, key: 'k' }, []), null);
});

test('buildChatRequest: request carries a timeout signal and auth header', () => {
  const req = buildChatRequest('openrouter', { enabled: true, key: 'secret' }, []);
  assert.ok(req.init.signal instanceof AbortSignal);
  assert.equal(req.init.headers['Authorization'], 'Bearer secret');
});

/* ═══ extractText ═══ */
test('extractText: OpenAI shape (openrouter/nvidia)', () => {
  assert.equal(extractText('nvidia', { choices: [{ message: { content: 'hello [Score: 8/10]' } }] }), 'hello [Score: 8/10]');
});

test('extractText: Cloudflare success shape', () => {
  assert.equal(extractText('cloudflare', { success: true, result: { response: 'cf says hi' } }), 'cf says hi');
});

test('extractText: failure payloads return null', () => {
  assert.equal(extractText('cloudflare', { success: false, errors: ['nope'] }), null);
  assert.equal(extractText('nvidia', { choices: [] }), null);
  assert.equal(extractText('nvidia', null), null);
  assert.equal(extractText('nvidia', 'garbage'), null);
});

test('extractText: empty-string content treated as no-answer', () => {
  assert.equal(extractText('nvidia', { choices: [{ message: { content: '   ' } }] }), null);
});
