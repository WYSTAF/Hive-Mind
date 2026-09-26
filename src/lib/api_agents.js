/* ── API Agents ──
 * Free-tier OpenAI-compatible providers as debate panelists, joining (or
 * replacing) the browser-automation agents. Pure logic + a fetch adapter —
 * unit-testable without a browser.
 *
 * Providers:
 *  - openrouter : https://openrouter.ai/api/v1/chat/completions
 *      free models like "meta-llama/llama-3.3-70b-instruct:free"
 *      auth: Bearer key
 *  - cloudflare : per-account endpoint
 *      https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/meta/llama-3.1-8b-instruct
 *      auth: Bearer token (API token with Workers AI permission)
 *  - nvidia     : https://integrate.api.nvidia.com/v1/chat/completions
 *      auth: Bearer key (nvapi-…)
 *
 * All three speak the OpenAI chat-completions shape for responses.
 */

export const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    color: '#6366f1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free'
  },
  cloudflare: {
    label: 'Cloudflare',
    color: '#f38020',
    defaultModel: '@cf/meta/llama-3.1-8b-instruct'
  },
  nvidia: {
    label: 'Nvidia NIM',
    color: '#76b900',
    defaultModel: 'meta/llama-3.1-8b-instruct'
  }
};

export function isApiAgent(name) {
  // Built-in providers, or a user-defined custom agent ("custom:<id>").
  if (Object.prototype.hasOwnProperty.call(PROVIDERS, name)) return true;
  return typeof name === 'string' && name.startsWith('custom:');
}

/** Look up a custom agent definition from stored config (apiConfig.customAgents). */
export function getCustomAgent(cfg, id) {
  const list = (cfg && Array.isArray(cfg.customAgents)) ? cfg.customAgents : [];
  return list.find(a => a.id === id) || null;
}

/** Build {url, init} or null when config is incomplete/disabled.
 * `cfg` is either a provider block or, for custom agents, the whole stored
 * apiConfig (the agent definition lives in cfg.customAgents). */
export function buildChatRequest(providerKey, cfg, messages, { timeoutMs = 30000, stream = false } = {}) {
  if (!isApiAgent(providerKey)) return null;
  let c = cfg || {};
  let model;
  let url;

  if (providerKey.startsWith('custom:')) {
    const def = getCustomAgent(cfg, providerKey.slice('custom:'.length));
    if (!def || !def.enabled || !def.key || !def.baseUrl || !def.model) return null;
    // Accept both bare base (…/v1) and full path endings; normalize to …/v1.
    let base = def.baseUrl.replace(/\/+$/, '');
    if (!/\/v\d+$/.test(base)) base += '/v1';
    url = `${base}/chat/completions`;
    model = def.model;
    c = def;
  } else {
    if (!c.enabled || !c.key) return null;
    model = c.model || PROVIDERS[providerKey].defaultModel;
    switch (providerKey) {
      case 'openrouter':
        url = 'https://openrouter.ai/api/v1/chat/completions';
        break;
      case 'cloudflare':
        if (!c.accountId) return null;
        url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(c.accountId)}/ai/run/${encodeURIComponent(model)}`;
        break;
      case 'nvidia':
        url = 'https://integrate.api.nvidia.com/v1/chat/completions';
        break;
      default:
        return null;
    }
  }

  const headers = { 'Content-Type': 'application/json' };
  headers['Authorization'] = `Bearer ${c.key}`;
  if (providerKey === 'openrouter') headers['HTTP-Referer'] = 'https://localhost.hivemind';

  // Cloudflare's Workers AI endpoint takes a slimmer body.
  const bodyObj = providerKey === 'cloudflare'
    ? { messages, max_tokens: 1024, stream }
    : { model, messages, temperature: 0.8, max_tokens: 1024, stream };

  return {
    url,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(timeoutMs)
    }
  };
}

/** Extract assistant text from any of the three response shapes; null on failure payload. */
export function extractText(providerKey, data) {
  if (!data || typeof data !== 'object') return null;
  // OpenAI shape (openrouter, nvidia)
  if (Array.isArray(data.choices) && data.choices.length) {
    const msg = data.choices[0].message || data.choices[0].delta || {};
    return typeof msg.content === 'string' && msg.content.trim() ? msg.content.trim() : null;
  }
  // Cloudflare success shape: { result: { response }, success: true }
  if (data.success === true && data.result && typeof data.result.response === 'string') {
    return data.result.response.trim() || null;
  }
  return null;
}

/* ── Streaming (SSE) ── */

/**
 * Incremental SSE parser. Feed raw network chunks in; get complete
 * `data:` payload strings out. Buffers partial lines across chunks and
 * skips comments / empty lines / [DONE].
 */
export class SSEBufferParser {
  constructor() {
    this.buf = '';
    this.done = false;
  }

  push(chunk) {
    this.buf += chunk;
    const events = [];
    let idx;
    while ((idx = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;           // comments / blanks
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        if (payload === '[DONE]') this.done = true;
        continue;
      }
      events.push(payload);
    }
    return events;
  }
}

/** Pull incremental text out of one streamed JSON event; '' when nothing new. */
export function extractStreamDelta(providerKey, eventObj) {
  if (!eventObj || typeof eventObj !== 'object') return '';
  // OpenAI-style chunk (openrouter, nvidia)
  if (Array.isArray(eventObj.choices) && eventObj.choices.length) {
    const d = eventObj.choices[0].delta || {};
    return typeof d.content === 'string' ? d.content : '';
  }
  // Cloudflare stream mode appends plain text fields per event.
  if (typeof eventObj.response === 'string') return eventObj.response;
  return '';
}

/* ── Budget guard ──
 * Sliding-window cap on API requests per hour across all providers. Free
 * tiers are generous per-model but unforgiving in aggregate; a runaway
 * debate loop shouldn't burn a whole day's quota in minutes.
 */
export class BudgetTracker {
  /**
   * @param {number} maxRequests allowed per windowMs (0 = unlimited)
   * @param {()=>number} nowMs injectable clock
   */
  constructor(maxRequests = 20, windowMs = 3600000, nowMs = Date.now) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.nowMs = nowMs;
    this.hits = []; // timestamps of recent requests
  }

  /** Drop expired entries; true when another request fits the window. */
  wouldAllow() {
    if (!this.maxRequests) return true;
    const cutoff = this.nowMs() - this.windowMs;
    while (this.hits.length && this.hits[0] <= cutoff) this.hits.shift();
    return this.hits.length < this.maxRequests;
  }

  /** Record one request. Returns false (without recording) when over budget. */
  trySpend() {
    if (!this.wouldAllow()) return false;
    this.hits.push(this.nowMs());
    return true;
  }

  /** Snapshot for persistence across service-worker restarts. */
  toJSON() {
    return { maxRequests: this.maxRequests, windowMs: this.windowMs, hits: [...this.hits] };
  }

  /** Restore a snapshot (drops expired hits against the current clock). */
  static fromJSON(data, nowMs = Date.now) {
    const t = new BudgetTracker(data?.maxRequests ?? 20, data?.windowMs ?? 3600000, nowMs);
    if (Array.isArray(data?.hits)) {
      const cutoff = nowMs() - t.windowMs;
      t.hits = data.hits.filter(ts => ts > cutoff && ts <= nowMs());
    }
    return t;
  }
}

export class ApiAgentClient {
  /**
   * @param {(name:string)=>object|undefined} getConfig returns stored provider config
   */
  constructor(getConfig) {
    this.getConfig = getConfig;
  }

  /**
   * Config lookup honoring the background wiring: getConfig(name) returns
   * apiConfig[name] — undefined for "custom:<id>" ids. Custom definitions
   * live at the config ROOT (apiConfig.customAgents); the client resolves
   * them through the special '*' key, which background's getter provides.
   */
  _configFor(name) {
    if (name.startsWith('custom:')) {
      return this.getConfig('*') || null;
    }
    return this.getConfig(name);
  }

  enabled(name) {
    const cfg = this._configFor(name);
    if (name.startsWith('custom:')) {
      const def = getCustomAgent(cfg, name.slice('custom:'.length));
      return !!(def && def.enabled && def.key && def.baseUrl && def.model);
    }
    if (!cfg || !cfg.enabled || !cfg.key) return false;
    if (name === 'cloudflare' && !cfg.accountId) return false;
    return true;
  }

  async ask(name, messages) {
    const req = buildChatRequest(name, this._configFor(name) ?? {}, messages);
    if (!req) return { status: 'error', reason: 'not-configured' };
    try {
      const resp = await fetch(req.url, req.init);
      if (resp.status === 429) return { status: 'rate_limited', reason: `HTTP 429` };
      if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.text()).slice(0, 200); } catch { /* body unreadable */ }
        return { status: 'error', reason: `HTTP ${resp.status} ${detail}`.trim() };
      }
      const text = extractText(name, await resp.json());
      if (!text) return { status: 'error', reason: 'empty-response' };
      return { status: 'done', text };
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        return { status: 'timeout', reason: e.name };
      }
      return { status: 'error', reason: String((e && e.message) || e) };
    }
  }

  /**
   * Streaming variant: same result shape as ask(), plus onDelta(chunkStr)
   * fires per token group as they arrive. Falls back to a plain request
   * when the provider/stream fails mid-flight with nothing received.
   */
  async askStream(name, messages, onDelta) {
    const cfg = this._configFor(name) ?? {};
    const streamReq = buildChatRequest(name, cfg, messages, { stream: true });
    if (streamReq && typeof onDelta === 'function') {
      try {
        const resp = await fetch(streamReq.url, streamReq.init);
        if (resp.ok && resp.body) {
          const parser = new SSEBufferParser();
          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let full = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
              try {
                const delta = extractStreamDelta(name, JSON.parse(payload));
                if (delta) {
                  full += delta;
                  onDelta(delta);
                }
              } catch { /* skip malformed event */ }
            }
          }
          if (full.trim()) return { status: 'done', text: full.trim() };
          // Stream produced nothing usable — fall through to non-stream.
        }
      } catch { /* fall through to non-stream attempt */ }
    }
    return this.ask(name, messages);
  }
}
