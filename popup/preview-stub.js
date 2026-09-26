/* ── Dev-only preview shim ──
 * Lets popup.js run in a plain browser tab (no extension context) for design
 * work: provides an in-memory chrome.storage, canned runtime messaging, and
 * sample debate state. Entirely inert when the real extension APIs exist.
 */
(function () {
  'use strict';
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) return; // real extension

  const mem = {
    settings: { tone: 'neutral' },
    apiAgents: {
      openrouter: { enabled: true, key: 'sk-or-demo-key', model: '' },
      customAgents: [{ id: 'c1', name: 'Local Ollama', baseUrl: 'http://127.0.0.1:11434/v1', key: 'x', model: 'qwen2.5:72b', enabled: true }]
    },
    debateHistory: [{
      prompt: 'Should AI research be open-sourced?',
      finishedAt: Date.now() - 3600e3,
      rounds: [
        { round: 1, responses: { chatgpt: { text: 'Openness wins.', score: 7 }, claude: { text: 'Careful with capabilities.', score: 8 }, gemini: { text: 'Distribution matters.', score: 6 } } },
        { round: 2, responses: { chatgpt: { text: 'Revised: guardrails + openness.', score: 8 }, claude: { text: 'Still worried about misuse.', score: 9 } } }
      ],
      agents: { chatgpt: { status: 'done', score: 8 }, claude: { status: 'done', score: 9 }, gemini: { status: 'timeout', score: 0 }, openrouter: { status: 'missing-tab', score: 0 } },
      finalConsensus: '## AI Consensus Synthesis\n\n### Scores by round\n- Round 1: claude: 8/10 | chatgpt: 7/10 | gemini: 6/10\n- Round 2: claude: 9/10 | chatgpt: 8/10\n\nStrongest improvement: **chatgpt** (+1 points from round 1 to round 2).\n\n### Blind Judgement (by openrouter)\n1. **claude** — 9/10 — sharpest rebuttal handling\n2. **chatgpt** — 8/10 — solid but repetitive\n\n### Synthesis\nThe panel leans toward openness **with staged capability gating**.',
      judge: { judge: 'openrouter', verdict: [{ agent: 'claude', score: 9, oneLine: 'sharpest rebuttal handling' }, { agent: 'chatgpt', score: 8, oneLine: 'solid but repetitive' }] },
      winner: 'claude',
      stoppedReason: null
    }]
  };

  const listeners = [];

  window.chrome = {
    runtime: {
      id: 'preview-stub',
      lastError: null,
      getURL: p => p,
      sendMessage: (msg, cb) => {
        // Async responses like the real API.
        setTimeout(() => {
          if (msg.action === 'list_sites') {
            cb({
              sites: [
                { id: 'chatgpt', label: 'ChatGPT', color: '#10a37f', always: true, custom: false, enabled: true },
                { id: 'claude', label: 'Claude', color: '#d97706', always: true, custom: false, enabled: true },
                { id: 'gemini', label: 'Gemini', color: '#4285f4', always: true, custom: false, enabled: true },
                { id: 'grok', label: 'Grok', color: '#8b5cf6', always: false, custom: false, enabled: false },
                { id: 'deepseek', label: 'DeepSeek', color: '#4d6bfe', always: false, custom: false, enabled: false },
                { id: 'perplexity', label: 'Perplexity', color: '#20808d', always: false, custom: false, enabled: false },
                { id: 'localai', label: 'My Local AI', color: '#9370db', always: false, custom: true, enabled: true }
              ]
            });
          } else if (msg.action === 'add_custom_site') {
            cb({ ok: true, id: 'newsite' });
          } else if (msg.action === 'set_site_enabled') {
            cb({ ok: true, sites: ['chatgpt', 'claude', 'gemini'] });
          } else if (msg.action === 'remove_custom_site') {
            cb({ ok: true, sites: ['chatgpt'] });
          } else if (msg.action === 'get_agent_roster') {
            // Mirrors the real roster: enabled sites + built-in API agents.
            cb({
              roster: [
                { id: 'chatgpt', kind: 'site', label: 'ChatGPT', color: '#10a37f' },
                { id: 'claude', kind: 'site', label: 'Claude', color: '#d97706' },
                { id: 'gemini', kind: 'site', label: 'Gemini', color: '#4285f4' },
                { id: 'grok', kind: 'site', label: 'Grok', color: '#8b5cf6' },
                { id: 'deepseek', kind: 'site', label: 'DeepSeek', color: '#4d6bfe' },
                { id: 'openrouter', kind: 'api', label: 'OpenRouter', color: '#6366f1' },
                { id: 'cloudflare', kind: 'api', label: 'Cloudflare', color: '#f38020' },
                { id: 'nvidia', kind: 'api', label: 'Nvidia NIM', color: '#76b900' }
              ],
              sites: []
            });
          } else if (msg.action === 'get_state') {
            const h = mem.debateHistory;
            cb({ running: false, bridgeConnected: false, history: h });
          } else if (msg.action === 'run_diagnostics') {
            // Sample report: one healthy agent, one failing group.
            cb({
              checkedAt: Date.now(),
              selectorsVersion: 2,
              bridgeConnected: true,
              agents: {
                chatgpt: {
                  kind: 'tab', present: true, reachable: true,
                  report: {
                    input: { ok: true, matched: "div[id='prompt-textarea']", matchedIndex: 0, tried: 3, invalidSelectors: [] },
                    submit: { ok: true, matched: "button[data-testid='send-button']", matchedIndex: 0, tried: 4, invalidSelectors: [] },
                    output: { ok: false, matched: null, matchedIndex: null, tried: 2, invalidSelectors: [] },
                    wait_selector: { ok: true, matched: "button[data-testid='stop-button']", matchedIndex: 0, tried: 2, invalidSelectors: [] },
                    outputSample: ''
                  }
                },
                claude: { kind: 'tab', present: true, reachable: false, report: null },
                gemini: { kind: 'tab', present: false },
                openrouter: { kind: 'api', enabled: true, model: 'meta-llama/llama-3.3-70b-instruct:free' },
                cloudflare: { kind: 'api', enabled: false, model: null },
                nvidia: { kind: 'api', enabled: false, model: null }
              }
            });
          } else if (msg.action === 'get_api_config') {
            cb({ config: mem.apiAgents });
          } else if (msg.action === 'start_debate') {
            cb({ ok: true, result: { rounds: [] } });
          } else {
            cb({ ok: true });
          }
        }, 30);
      },
      onMessage: {
        addListener: fn => listeners.push(fn)
      }
    },
    storage: {
      local: {
        // Supports both callback and promise styles like the real API.
        get: (keys, cb) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (mem[k] !== undefined) out[k] = mem[k]; });
          if (typeof cb === 'function') { setTimeout(() => cb(out), 10); return; }
          return Promise.resolve(out);
        },
        set: (obj, cb) => {
          Object.assign(mem, obj);
          if (typeof cb === 'function') { setTimeout(cb, 5); return; }
          return Promise.resolve();
        }
      }
    },
    notifications: { create: () => {} },
    // Dev/test hook: deliver a message to every registered popup listener.
    __fire(msg) {
      listeners.forEach(fn => fn(msg, {}, () => {}));
    }
  };
})();
