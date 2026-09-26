/* ── Site registry tests ── */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BUILTIN_SITES, isSiteEnabled, mergeSites, siteForUrl, siteForOrigin, selectorsForSite } from '../src/lib/sites.js';

const REQUIRED_SELECTOR_KEYS = ['input', 'submit', 'output', 'wait_selector'];

test('every built-in site is structurally valid', () => {
  for (const s of BUILTIN_SITES) {
    assert.ok(s.id && /^[a-z0-9_]+$/.test(s.id), `bad id: ${s.id}`);
    assert.ok(s.label, `${s.id} missing label`);
    assert.ok(s.color && s.color.startsWith('#'), `${s.id} missing color`);
    assert.ok(Array.isArray(s.origins) && s.origins.length, `${s.id} missing origins`);
    assert.ok(Array.isArray(s.urlTests) && s.urlTests.length, `${s.id} missing urlTests`);
    for (const k of REQUIRED_SELECTOR_KEYS) {
      assert.ok(Array.isArray(s[k]) && s[k].length, `${s.id}.${k} must be a non-empty array`);
      s[k].forEach(sel => assert.equal(typeof sel, 'string', `${s.id}.${k} entries must be strings`));
    }
    // Every pattern must compile — the validator rejects bad ones upstream,
    // but the registry itself must never ship an uncompilable regex.
    (s.error_patterns || []).forEach(p => { try { new RegExp(p, 'i'); } catch { assert.fail(`${s.id} bad error pattern: ${p}`); } });
    (s.rate_limit_patterns || []).forEach(p => { try { new RegExp(p, 'i'); } catch { assert.fail(`${s.id} bad rate pattern: ${p}`); } });
    // Origin patterns are well-formed match patterns.
    s.origins.forEach(o => assert.match(o, /^https?:\/\/[^/]+\/\*$/, `${s.id} bad origin: ${o}`));
  }
});

test('site ids are unique', () => {
  const ids = BUILTIN_SITES.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('the AI sites named in the product brief are present', () => {
  const ids = BUILTIN_SITES.map(s => s.id);
  for (const wanted of ['chatgpt', 'claude', 'gemini', 'grok', 'deepseek']) {
    assert.ok(ids.includes(wanted), `missing site: ${wanted}`);
  }
});

test('isSiteEnabled: always-on sites are on; lazy sites need opting in', () => {
  const always = BUILTIN_SITES.find(s => s.visibility === 'always');
  const lazy = BUILTIN_SITES.find(s => s.visibility === 'lazy');
  assert.equal(isSiteEnabled(always, []), true);
  assert.equal(isSiteEnabled(lazy, []), false);
  assert.equal(isSiteEnabled(lazy, [lazy.id]), true);
});

test('mergeSites: user sites override builtins by id and are appended', () => {
  const custom = [{ id: 'chatgpt', label: 'My GPT', origins: ['https://my.host/*'], urlTests: ['my.host'] },
                  { id: 'newsite', label: 'New', origins: ['https://n.host/*'], urlTests: ['n.host'] }];
  const merged = mergeSites(BUILTIN_SITES, custom);
  const byId = Object.fromEntries(merged.map(s => [s.id, s]));
  assert.equal(byId.chatgpt.label, 'My GPT', 'user site wins over builtin');
  assert.ok(byId.newsite, 'new site appended');
  assert.equal(merged.length, BUILTIN_SITES.length + 1, 'no duplicate ids');
});

test('mergeSites: malformed user entries are dropped, not crashed on', () => {
  const merged = mergeSites(BUILTIN_SITES, [null, {}, { id: 'x' }, { id: 'y', origins: [] }]);
  assert.equal(merged.length, BUILTIN_SITES.length);
});

test('siteForUrl: maps known hosts and prefers the longest match', () => {
  assert.equal(siteForUrl('https://chatgpt.com/c/abc', BUILTIN_SITES).id, 'chatgpt');
  assert.equal(siteForUrl('https://claude.ai/chat/1', BUILTIN_SITES).id, 'claude');
  assert.equal(siteForUrl('https://chat.deepseek.com/', BUILTIN_SITES).id, 'deepseek');
  assert.equal(siteForUrl('https://grok.com/?q=1', BUILTIN_SITES).id, 'grok');
  assert.equal(siteForUrl('https://news.example.com', BUILTIN_SITES), null);
  assert.equal(siteForUrl('', BUILTIN_SITES), null);
});

test('siteForUrl: a longer urlTest must not be shadowed by a shorter one', () => {
  const sites = [
    { id: 'short', urlTests: ['ai.example.com'] },
    { id: 'long', urlTests: ['chat.ai.example.com'] }
  ];
  assert.equal(siteForUrl('https://chat.ai.example.com/x', sites).id, 'long');
});

test('selectorsForSite: returns exactly the block the content engine expects', () => {
  const block = selectorsForSite(BUILTIN_SITES[0]);
  for (const k of REQUIRED_SELECTOR_KEYS) assert.ok(Array.isArray(block[k]), `missing ${k}`);
  assert.equal(typeof block.wait_selector_visible, 'boolean');
  assert.ok(Array.isArray(block.error_patterns));
});

/* ═══ siteForOrigin (dynamic site bridge resolution) ═══ */
test('siteForOrigin: resolves every registered host, including alias hosts', () => {
  const cases = [
    ['https://chatgpt.com/c/1', 'chatgpt'],
    ['https://claude.ai/chat', 'claude'],
    ['https://gemini.google.com/app', 'gemini'],
    ['https://chat.deepseek.com/', 'deepseek'],
    ['https://grok.com/', 'grok'],
    ['https://x.com/i/grok', 'grok'],        // alias host via origins
    ['https://chat.mistral.ai/chat', 'mistral'],
    ['https://www.perplexity.ai/search', 'perplexity'],
    ['https://copilot.microsoft.com/', 'copilot']
  ];
  for (const [origin, want] of cases) {
    const got = siteForOrigin(origin, BUILTIN_SITES);
    assert.equal(got && got.id, want, `${origin} should resolve to ${want}`);
  }
});

test('siteForOrigin: unknown and malformed origins return null', () => {
  assert.equal(siteForOrigin('https://random.example.com', BUILTIN_SITES), null);
  assert.equal(siteForOrigin('not-a-url', BUILTIN_SITES), null);
  assert.equal(siteForOrigin('', BUILTIN_SITES), null);
});

test('siteForOrigin: strips www and matches subdomains', () => {
  const s = siteForOrigin('https://www.deepseek.com/chat', BUILTIN_SITES);
  assert.equal(s && s.id, 'deepseek');
});
