/* ── Cross-browser API ── */
const browserAPI = typeof chrome !== 'undefined' ? chrome : browser;

import { parseScore, wrapConversation, synthesizeConsensus, isRoundBarrierMet,
         pickAdversary, buildDevilsAdvocatePrompt } from './lib/debate_logic.js';
import { isValidSelectors } from './lib/selectors.js';
import { ApiAgentClient, BudgetTracker, PROVIDERS, isApiAgent, getCustomAgent } from './lib/api_agents.js';
import { detectConvergence } from './lib/convergence.js';
import { runBlindJudge } from './lib/judging.js';
import { computeStats } from './lib/stats.js';
import { BUILTIN_SITES, isSiteEnabled, mergeSites, siteForUrl, siteForOrigin, selectorsForSite } from './lib/sites.js';

/* ═══ Selectors: bundled-first, remote override, runtime cache ═══ */
const REMOTE_SELECTORS_URL = 'https://raw.githubusercontent.com/hivemind-ai/consensus-engine/main/selectors.json';
let selectors = null;

async function loadSelectors() {
  let bundled = null;
  try {
    const resp = await fetch(browserAPI.runtime.getURL('selectors.json'));
    bundled = await resp.json();
  } catch (e) {
    console.error('[HiveMind] Failed to load bundled selectors:', e);
  }

  if (bundled && isValidSelectors(bundled)) {
    selectors = bundled;
    console.log('[HiveMind] Bundled selectors loaded');
  } else {
    console.error('[HiveMind] Bundled selectors invalid or missing');
    selectors = {};
    return false;
  }

  // Remote is an upgrade, never a blocker.
  try {
    const resp = await fetch(REMOTE_SELECTORS_URL, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const remote = await resp.json();
      if (isValidSelectors(remote)) {
        // Merge: remote may override PER-AGENT selector blocks only. Bridge
        // config (ws_url/token) and other local keys are trust boundaries —
        // a compromised upstream must not redirect the panel or its auth.
        const LOCAL_ONLY = ['bridge', 'remote_fetch_url', 'version'];
        const merged = { ...remote };
        for (const key of LOCAL_ONLY) delete merged[key];
        selectors = { ...selectors, ...merged };
        console.log('[HiveMind] Remote selectors merged (validated, local keys preserved)');
      } else {
        console.warn('[HiveMind] Remote selectors failed validation; keeping bundled');
      }
    }
  } catch { /* offline / repo absent — bundled stays */ }

  return true;
}

/* ═══ Telegram dispatcher ═══ */
async function sendTelegram(token, chatId, text) {
  if (!token || !chatId) return;
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `🤖 *AI Consensus Engine — Final Synthesis*\n\n${text}`,
        parse_mode: 'Markdown'
      })
    });
  } catch (e) {
    console.error('[HiveMind] Telegram send failed:', e);
  }
}

/* ═══ WebSocket Bridge ═══ */
class BridgeClient {
  constructor(url, reconnectMs) {
    this.url = url || 'ws://127.0.0.1:8765';
    this.reconnectMs = reconnectMs || 3000;
    this.ws = null;
    this.listeners = {};
    this._closing = false;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this._closing = false;
    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => console.log('[HiveMind] Bridge WS connected');
      this.ws.onmessage = e => {
        try { this._handle(JSON.parse(e.data)); } catch { /* malformed */ }
      };
      this.ws.onclose = () => {
        if (this._closing) return; // intentional disconnect
        setTimeout(() => this.connect(), this.reconnectMs);
      };
      this.ws.onerror = () => {
        try { this.ws.close(); } catch { /* noop */ }
      };
    } catch { /* bad URL etc. */ }
  }

  _handle(msg) {
    const handlers = this.listeners[msg.action];
    if (handlers) handlers.forEach(fn => fn(msg));
  }

  on(action, fn) {
    if (!this.listeners[action]) this.listeners[action] = [];
    this.listeners[action].push(fn);
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  disconnect() {
    if (!this.ws) return;
    this._closing = true;
    try { this.ws.close(); } catch { /* noop */ }
    this.ws = null;
  }
}

let bridge = null;

function initBridge() {
  const b = (selectors && typeof selectors.bridge === 'object') ? selectors.bridge : {};
  let url = b.ws_url || 'ws://127.0.0.1:8765';
  // Optional shared secret — must match the bridge's HIVEMIND_TOKEN env.
  if (b.token) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(b.token);
  if (bridge) bridge.disconnect();
  bridge = new BridgeClient(url, b.reconnect_interval_ms);
  bridge.connect();
}

/* ═══ Constants & session state ═══ */
const ROUND_TIMEOUT_MS = 45000;
const POLL_INTERVAL_MS = 500;
const MAX_ROUNDS = 3;
const HISTORY_LIMIT = 20;

// Survives popup close/reopen and service-worker restarts within the same
// browser session. `currentDebate` itself does not survive worker restarts
// mid-debate (MV3 limitation), but completed history does via storage.
let currentDebate = null;
let abortController = null;
let debateHistory = [];
let apiConfig = {};
let apiBudget = new BudgetTracker(20);
// '*' hands the client the config ROOT — custom-agent definitions live at
// apiConfig.customAgents, which per-name lookups can never reach.
const apiClient = new ApiAgentClient(name => (name === '*' ? apiConfig : apiConfig[name]));

async function restoreApiConfig() {
  try {
    const res = await browserAPI.storage.local.get(['apiAgents', 'apiBudget']);
    if (res.apiAgents && typeof res.apiAgents === 'object') apiConfig = res.apiAgents;
    // Budget window survives worker restarts — otherwise every MV3 kill
    // would hand a fresh hourly quota mid-loop.
    if (res.apiBudget) apiBudget = BudgetTracker.fromJSON(res.apiBudget);
  } catch { /* defaults */ }
}

function persistBudget() {
  browserAPI.storage.local.set({ apiBudget: apiBudget.toJSON() }).catch(() => {});
}

/* ═══ Sites: builtins + user-added, enabled set ═══ */
let userSites = [];
let enabledLazySites = [];

async function restoreSites() {
  try {
    const res = await browserAPI.storage.local.get(['userSites', 'enabledLazySites']);
    if (Array.isArray(res.userSites)) userSites = res.userSites;
    if (Array.isArray(res.enabledLazySites)) enabledLazySites = res.enabledLazySites;
  } catch { /* defaults */ }
  activeSites = mergeSites(BUILTIN_SITES, userSites).filter(s => isSiteEnabled(s, enabledLazySites));
  await registerSiteScripts(activeSites);
}

function siteById(id) {
  return activeSites.find(s => s.id === id) || null;
}

/** Selector config for an agent: remote-override map first, then registry. */
function selectorBlockFor(id) {
  if (selectors && selectors[id]) return selectors[id];
  const site = siteById(id);
  return site ? selectorsForSite(site) : {};
}

async function restoreHistory() {
  try {
    const res = await browserAPI.storage.local.get('debateHistory');
    if (Array.isArray(res.debateHistory)) debateHistory = res.debateHistory.slice(0, HISTORY_LIMIT);
  } catch { /* fresh install */ }
}

function persistHistory() {
  browserAPI.storage.local.set({ debateHistory: debateHistory.slice(0, HISTORY_LIMIT) }).catch(() => {});
}

function buildAgentList() {
  // Browser-automation agents (enabled sites) + built-in API agents when
  // configured + any user-defined custom OpenAI-compatible endpoints.
  const list = activeSites.map(s => s.id);
  Object.keys(PROVIDERS).forEach(p => {
    if (apiClient.enabled(p)) list.push(p);
  });
  (Array.isArray(apiConfig.customAgents) ? apiConfig.customAgents : []).forEach(def => {
    if (def && def.id && apiClient.enabled(`custom:${def.id}`)) list.push(`custom:${def.id}`);
  });
  return list;
}

/** Human label for any agent id (custom agents and sites use stored names). */
function agentLabel(id) {
  if (id.startsWith('custom:')) {
    const def = getCustomAgent(apiConfig, id.slice('custom:'.length));
    return (def && def.name) || id;
  }
  const site = siteById(id);
  if (site) return site.label;
  return PROVIDERS[id] ? PROVIDERS[id].label : id;
}

/** Kick off an API agent's round; returns a promise resolving to {text} or throws. */
function askApiAgent(agent, prompt, onDelta) {
  // The stored system prompt describes the cross-critique format; on the
  // opening round there is no conversation yet, so say so explicitly rather
  // than inviting the model to invent one.
  const hasTranscript = prompt.includes('<atagh_fekr_conversation>');
  const system = currentDebate && currentDebate.systemPrompt
    ? currentDebate.systemPrompt
    : null;
  const messages = [
    ...(system
      ? [{
          role: 'system',
          content: hasTranscript
            ? system
            : `${system}\n\nThis is the OPENING round: no other arguments have been collected yet. Give your independent opening position on the question.`
        }]
      : []),
    { role: 'user', content: prompt }
  ];
  const call = typeof onDelta === 'function'
    ? apiClient.askStream(agent, messages, onDelta)
    : apiClient.ask(agent, messages);
  return call.then(res => {
    if (res.status === 'done') return res;
    const err = new Error(res.reason || res.status);
    err.code = res.status;
    throw err;
  });
}

function buildSystemPrompt(tone, systemPrompt) {
  const toneInstructions = {
    friendly: 'Be supportive, encouraging, and constructive in your critiques.',
    neutral: 'Be objective, balanced, and factual in your critiques.',
    brutal_roast: 'Be brutally honest, direct, and unsparing in your critiques.'
  };
  const ti = toneInstructions[tone] || toneInstructions.neutral;
  return `${systemPrompt ? systemPrompt + '\n\n' : ''}${ti}\n\nYou are participating in a multi-agent debate. ` +
    'Provide your response and rate it with a score in the format [Score: X/10]. ' +
    'When reviewing previous arguments from <atagh_fekr_conversation>, critique them and provide an updated argument.';
}

/* ═══ Tab discovery ═══ */
// Sites come from the registry (builtins + user-added), so urlToAgent is a
// data lookup, not a hardcoded three-way if/else.
let activeSites = [];

function urlToAgent(url) {
  const site = siteForUrl(url, activeSites);
  return site ? site.id : null;
}

async function findAgentTabs() {
  const tabs = await browserAPI.tabs.query({});
  const agents = {};
  for (const tab of tabs) {
    const agent = urlToAgent(tab.url);
    // First hit wins — query() order makes "last write" arbitrary when
    // several tabs match the same site.
    if (agent && agents[agent] === undefined) agents[agent] = tab.id;
  }
  return agents;
}

/* ═══ Dynamic content-script registration ═══
 * Manifest-declared scripts cover the always-on sites. Lazy and user-added
 * sites register here via chrome.scripting so adding a site never requires
 * editing the manifest. Registration is idempotent across worker restarts.
 */
const REGISTERED_SCRIPTS = 'hivemind-site-scripts';

async function registerSiteScripts(sites) {
  if (!browserAPI.scripting || !browserAPI.scripting.registerContentScripts) return;
  const prefix = `${REGISTERED_SCRIPTS}-`;
  try {
    // One registered entry PER SITE (ids must be unique) — a single shared id
    // would only ever deliver the engine to the first site.
    const desired = sites
      .filter(s => s.visibility === 'lazy' && Array.isArray(s.origins) && s.origins.length)
      .map(s => ({
        id: prefix + s.id,
        matches: s.origins,
        js: ['src/lib/agent_core.js', 'src/lib/site_bridge.js'],
        runAt: 'document_end',
        allFrames: false
      }));

    const existing = await browserAPI.scripting.getRegisteredContentScripts();
    const ours = (existing || []).filter(s => s.id && s.id.startsWith(prefix));
    const desiredIds = new Set(desired.map(d => d.id));

    // Drop entries for sites that are gone or disabled.
    const stale = ours.filter(o => !desiredIds.has(o.id)).map(o => o.id);
    if (stale.length) {
      await browserAPI.scripting.unregisterContentScripts({ ids: stale }).catch(() => {});
    }

    // Add or refresh the rest.
    const byId = new Map(ours.map(o => [o.id, o]));
    const toRegister = [];
    const toUpdate = [];
    for (const d of desired) {
      const prev = byId.get(d.id);
      const unchanged = prev &&
        JSON.stringify([...(prev.matches || [])].sort()) === JSON.stringify([...d.matches].sort());
      if (unchanged) continue;
      (prev ? toUpdate : toRegister).push(d);
    }
    if (toUpdate.length) await browserAPI.scripting.updateContentScripts(toUpdate).catch(() => {});
    if (toRegister.length) await browserAPI.scripting.registerContentScripts(toRegister).catch(() => {});
  } catch (e) {
    console.warn('[HiveMind] Site script registration unavailable:', e && e.message);
  }
}

/* ═══ Content script communication ═══ */
async function sendToTab(tabId, action, payload = {}) {
  try {
    return await browserAPI.tabs.sendMessage(tabId, { action, ...payload });
  } catch {
    return null; // no receiver — content script missing/reloading
  }
}

/* ═══ Popup + UI plumbing ═══ */
function notifyPopup(type, data) {
  browserAPI.runtime.sendMessage({ type, ...data }).catch(() => {});
}

// Live-feed throttle: at most one agent_partial per agent per window.
const PARTIAL_INTERVAL_MS = 2000;
const lastPartialSent = {};

function maybeSendPartial(agent, tail) {
  if (!tail) return;
  const now = Date.now();
  if (now - (lastPartialSent[agent] || 0) < PARTIAL_INTERVAL_MS) return;
  lastPartialSent[agent] = now;
  notifyPopup('agent_partial', { agent, tail });
}

async function setBadge(text, color) {
  try {
    await browserAPI.action.setBadgeText({ text: text || '' });
    if (color) await browserAPI.action.setBadgeBackgroundColor({ color });
  } catch { /* Firefox mobile etc. */ }
}

/* ═══ Blind judging (pre-finalize, clean completions only) ═══
 * Runs before finalizeDebate so the verdict lands inside the persisted
 * history entry, the synthesis, the bridge payload, and the popup at once.
 * Failures degrade gracefully: no verdict → synthesis simply omits it.
 */
async function maybeRunBlindJudge(debate) {
  if (!debate.blindJudge || debate.aborted || debate.judge) return;
  const lastRound = debate.rounds[debate.rounds.length - 1];
  if (!lastRound) return;

  // Judge independence: prefer an enabled API provider that did NOT
  // participate in this debate — LLM judges score familiar (self-generated)
  // text higher regardless of quality, so a panelist grading its own round
  // is a biased verdict. Fall back to any enabled provider only if every
  // enabled one debated.
  const panelists = Object.keys(debate.agents).filter(a => isApiAgent(a));
  const eligible = Object.keys(PROVIDERS).filter(p => apiClient.enabled(p) && !panelists.includes(p));
  const anyEnabled = Object.keys(PROVIDERS).filter(p => apiClient.enabled(p));
  if (!anyEnabled.length) return;
  const judgeName = eligible.length
    ? (eligible.includes('openrouter') ? 'openrouter' : eligible[0])
    : anyEnabled[0];

  const judgeAttempt = runBlindJudge(
    messages => apiClient.ask(judgeName, messages).then(res => {
      if (res.status !== 'done') throw new Error(res.reason || res.status);
      return res.text;
    }),
    debate.prompt,
    lastRound.responses
  ).catch(err => ({ ok: false, error: String((err && err.message) || err) }));

  const result = await Promise.race([
    judgeAttempt,
    // Loser of the race must still be handled or it can raise an unhandled
    // rejection that kills an MV3 service worker.
    sleep(20000).then(() => ({ ok: false, error: 'judge timed out' }))
  ]);
  // Keep a handle so the loser's late rejection is never unhandled.
  judgeAttempt.catch(() => {});

  if (result && result.ok) {
    debate.judge = { judge: judgeName, verdict: result.verdict };
    notifyPopup('agent_update', { agent: '__judge__', status: 'done', score: null });
  } else {
    console.warn('[HiveMind] Blind judge skipped:', result && result.error);
  }
}

/* ═══ Winner selection ═══ */
// Blind-judge pick first — it's the only externally-graded score; fall back
// to the highest final-round self-score.
function computeWinner(debate) {
  if (debate.judge && Array.isArray(debate.judge.verdict) && debate.judge.verdict.length) {
    return debate.judge.verdict[0].agent;
  }
  const lr = debate.rounds[debate.rounds.length - 1];
  let best = null;
  let bestScore = -1;
  Object.entries((lr && lr.responses) || {}).forEach(([a, r]) => {
    const sc = Number(r.score) || 0;
    if (sc > bestScore) { bestScore = sc; best = a; }
  });
  return best;
}

/* ═══ Finalization — single idempotent exit path ═══ */
// Telegram credentials ride on the debate object so every exit path
// (complete / round-timeout / abort) delivers identically.
function finalizeDebate(debate) {
  if (debate.finalized) return debate;
  debate.finalized = true;

  const agentList = Object.keys(debate.agents);
  const winner = computeWinner(debate);
  debate.winner = winner;
  const finalConsensus = synthesizeConsensus(debate);
  debate.finalConsensus = finalConsensus;

  // Persist the display label with each agent: sites and custom API agents
  // can be renamed/removed later, and history should still read correctly.
  const snapshotAgents = Object.fromEntries(
    agentList.map(a => [a, {
      status: debate.agents[a].status,
      score: debate.agents[a].score,
      label: agentLabel(a)
    }])
  );

  bridge.send({
    action: 'debate_complete',
    final_consensus: finalConsensus,
    rounds: debate.rounds,
    winner,
    stopped_reason: debate.stoppedReason,
    aborted: !!debate.aborted
  });

  const { token: tgTok, chat: tgChat } = debate.telegram || {};
  if (!debate.aborted && tgTok && tgChat) {
    sendTelegram(tgTok, tgChat, finalConsensus);
  }

  // Persist to history with per-response text capped — full texts stay in
  // the live debate/popup; storage.local has a finite quota and 20 debates
  // of untruncated transcripts could exceed it.
  const HISTORY_TEXT_CAP = 6000;
  const histRounds = debate.rounds.map(r => ({
    round: r.round,
    responses: Object.fromEntries(
      Object.entries(r.responses || {}).map(([a, d]) => [
        a, { score: d.score, text: String(d.text || '').slice(0, HISTORY_TEXT_CAP) }
      ])
    )
  }));
  debateHistory.unshift({
    prompt: String(debate.prompt || '').slice(0, 2000),
    systemPrompt: String(debate.systemPrompt || '').slice(0, 2000),
    tone: debate.tone,
    finishedAt: Date.now(),
    rounds: histRounds,
    agents: snapshotAgents,
    finalConsensus: finalConsensus.slice(0, HISTORY_TEXT_CAP),
    judge: debate.judge || null,
    stoppedReason: debate.stoppedReason || null,
    adversary: debate.adversary || null,
    winner: debate.winner || null,
    aborted: !!debate.aborted
  });
  debateHistory = debateHistory.slice(0, HISTORY_LIMIT);
  persistHistory();

  notifyPopup('debate_complete', {
    agents: snapshotAgents,
    rounds: debate.rounds,
    consensus: finalConsensus,
    winner
  });

  // Desktop notification — debates take minutes; the user has moved on.
  try {
    const snippet = finalConsensus.replace(/\s+/g, ' ').slice(0, 180);
    browserAPI.notifications.create(`hivemind-${Date.now()}`, {
      type: 'basic',
      iconUrl: browserAPI.runtime.getURL('icons/icon128.png'),
      title: debate.aborted ? 'HiveMind — debate stopped' : 'HiveMind — consensus reached',
      message: snippet + (finalConsensus.length > snippet.length ? '…' : '')
    });
  } catch { /* notifications unavailable */ }

  setBadge('done', '#22c55e');
  setTimeout(() => setBadge(''), 8000);

  currentDebate = null;
  updateKeepAlive();
  return debate;
}

/* ═══ Per-round helpers ═══ */

// Salvage answers that arrived but never cleared the barrier — used both by
// the timeout path and the all-done-with-nothing path.
function collectPendingResponses(debate, agentList) {
  const salvaged = {};
  agentList.forEach(a => {
    const s = debate.agents[a];
    if (s.completed && s.text && !s.timedOut && !s.recordedInRound) {
      salvaged[a] = { text: s.text, score: s.score };
      s.recordedInRound = true;
    }
  });
  return salvaged;
}

function pushRound(debate, responses) {
  if (!Object.keys(responses).length) return false;
  debate.rounds.push({ round: debate.rounds.length + 1, responses });
  notifyPopup('chart_update', { rounds: debate.rounds });
  bridge.send({ action: 'debate_event', kind: 'round_complete', round: debate.rounds.length, responses });
  if (!debate.finalized) setBadge(`R${debate.rounds.length}`, '#f59e0b');
  return true;
}

async function injectToAgent(aState, agent, prompt) {
  const result = await sendToTab(aState.tabId, 'inject_prompt', {
    prompt,
    selectors: selectorBlockFor(agent)
  });
  if (!result || result.status === 'error') {
    // No receiver usually means the tab has no content script yet — common
    // right after enabling a site. Inject the engine once, then retry.
    if (result === null) {
      const site = siteById(agent);
      if (site && await ensureScriptInTab(aState.tabId, site)) {
        const afterInject = await sendToTab(aState.tabId, 'inject_prompt', {
          prompt,
          selectors: selectorBlockFor(agent)
        });
        if (afterInject && afterInject.status !== 'error') return true;
      }
    }
    // Otherwise one plain retry — transient failures happen after navigation.
    await sleep(1000);
    const retry = await sendToTab(aState.tabId, 'inject_prompt', {
      prompt,
      selectors: selectorBlockFor(agent)
    });
    if (!retry || retry.status === 'error') {
      aState.status = (retry && retry.text) ? `error: ${retry.text}` : 'unreachable';
      aState.completed = true;
      aState.timedOut = true;
      notifyPopup('agent_update', { agent, status: aState.status.startsWith('error') ? 'error' : 'missing-tab' });
      return false;
    }
  }
  return true;
}

/**
 * Inject the engine into an open tab that has no content script yet. Keeps
 * "just enabled this site" working without a manual tab reload.
 */
async function ensureScriptInTab(tabId, site) {
  if (!browserAPI.scripting || !browserAPI.scripting.executeScript) return false;
  const engine = 'src/lib/agent_core.js';
  // Only the three manifest sites have dedicated config files; everything
  // else (lazy built-ins, user-added) uses the self-resolving bridge.
  const known = new Set(['chatgpt', 'claude', 'gemini']);
  const siteScript = known.has(site.id) && site.visibility === 'always'
    ? `src/content_scripts/${site.id}.js`
    : 'src/lib/site_bridge.js';
  try {
    await browserAPI.scripting.executeScript({ target: { tabId }, files: [engine, siteScript] });
    return true;
  } catch (e) {
    console.warn('[HiveMind] Could not inject engine into tab:', e && e.message);
    return false;
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ═══ API agent rounds ═══
 * API agents run as promises alongside the tab-polling loop. The promise
 * resolves the answer into agent state; completion is observed by the poll
 * tick like any other agent. A per-agent round token invalidates responses
 * from a previous round that land after a re-entry reset — without it, a
 * slow round-N answer could be recorded as a round-N+1 answer.
 */
function launchApiRound(debate, s, agent, roundPrompt) {
  const token = ++s.roundToken;

  // Budget guard: over-quota API agents hold this round instead of firing
  // (they may re-enter when the window slides). Not counted as a failure.
  if (!apiBudget.trySpend()) {
    persistBudget();
    s.status = 'quota-hold';
    s.timedOut = true;
    s.completed = true;
    notifyPopup('agent_update', { agent, status: 'quota-hold' });
    return;
  }
  persistBudget();

  let lastStreamNotify = 0;
  s.pendingPromise = askApiAgent(agent, roundPrompt, delta => {
    // Throttled live-feed streaming for API agents (2s window, like tabs).
    const now = Date.now();
    if (now - lastStreamNotify < PARTIAL_INTERVAL_MS) return;
    lastStreamNotify = now;
    notifyPopup('agent_partial', { agent, tail: String(delta || '').slice(-160) });
  })
    .then(res => {
      // timedOut check: a round-deadline verdict must not be overwritten by
      // this zombie settling late (roundToken alone doesn't cover it —
      // the agent was never relaunched, so its token still matches).
      if (currentDebate !== debate || debate.finalized || s.roundToken !== token || s.timedOut) return;
      s.text = res.text;
      s.score = parseScore(res.text);
      s.status = 'done';
      s.completed = true;
      notifyPopup('agent_partial', { agent, tail: String(res.text || '').slice(-160) });
      notifyPopup('agent_update', { agent, status: 'done', score: s.score });
    })
    .catch(err => {
      if (currentDebate !== debate || debate.finalized || s.roundToken !== token || s.timedOut) return;
      s.completed = true;
      if (err.code === 'rate_limited') {
        s.timedOut = true;
        s.status = 'rate-limited';
        notifyPopup('agent_update', { agent, status: 'rate-limited' });
      } else if (err.code === 'timeout') {
        s.timedOut = true;
        s.status = 'timeout';
        notifyPopup('agent_update', { agent, status: 'timeout' });
      } else {
        s.timedOut = true;
        s.status = 'error';
        notifyPopup('agent_update', { agent, status: 'error' });
      }
    });
}

/* ═══ Debate runner ═══ */
async function runDebate(opts) {
  const {
    prompt, system_prompt, tone, telegram_token, telegram_chat,
    smart_stop = true, blind_judge = true, devils_advocate = false
  } = opts;
  // Synchronous single-debate claim: assigning currentDebate BEFORE the
  // first await closes the window where two start_debate messages could
  // both pass this guard and run concurrent loops against the same tabs.
  if (currentDebate) return null;

  abortController = new AbortController();
  const signal = abortController.signal;

  const fullSystemPrompt = buildSystemPrompt(tone, system_prompt);

  const debate = {
    prompt,
    systemPrompt: fullSystemPrompt,
    tone,
    rounds: [],
    agents: {},
    startTime: Date.now(),
    roundClosing: false,
    finalized: false,
    aborted: false,
    smartStop: !!smart_stop,
    blindJudge: !!blind_judge,
    devilsAdvocate: !!devils_advocate,
    adversary: null,
    stoppedReason: null,
    judge: null,
    telegram: { token: telegram_token || '', chat: telegram_chat || '' }
  };
  currentDebate = debate;
  updateKeepAlive(); // alarm wakes the worker for the debate's duration
  const agentList = buildAgentList();
  const agentTabs = await findAgentTabs();

  agentList.forEach(a => {
    if (isApiAgent(a)) {
      debate.agents[a] = {
        status: 'thinking', score: 0, text: '', tabId: null,
        kind: 'api', pendingPromise: null, roundToken: 0,
        completed: false, timedOut: false, recordedInRound: false
      };
      return;
    }
    const hasTab = !!agentTabs[a];
    debate.agents[a] = {
      status: hasTab ? 'thinking' : 'missing-tab',
      score: 0,
      text: '',
      tabId: agentTabs[a] || null,
      kind: 'tab',
      completed: !hasTab,
      timedOut: !hasTab,
      recordedInRound: !hasTab // missing tabs have nothing to record
    };
    if (!hasTab) notifyPopup('agent_update', { agent: a, status: 'missing-tab' });
  });

  setBadge(String(debate.rounds.length + 1), '#f59e0b');

  notifyPopup('debate_started', {
    rounds: debate.rounds,
    agents: Object.fromEntries(agentList.map(a => [a, { status: debate.agents[a].status, score: 0 }]))
  });
  bridge.send({ action: 'debate_event', kind: 'debate_started', prompt });

  // Round 1 broadcast — system prompt + tone ride along on the first inject.
  // The question is explicitly delimited so models don't treat the debate
  // instructions as the thing to answer.
  const firstPrompt =
    `${fullSystemPrompt}\n\n` +
    `Note: no other arguments have been collected yet — this is your opening statement.\n\n` +
    `--- QUESTION TO DEBATE ---\n${prompt}\n--- END QUESTION ---`;
  await Promise.allSettled(agentList.map(async a => {
    const s = debate.agents[a];
    if (s.kind === 'api') {
      launchApiRound(debate, s, a, prompt);
    } else if (s.tabId) {
      await injectToAgent(s, a, firstPrompt);
    }
  }));

  bridge.send({
    action: 'start_debate',
    prompt,
    system_prompt: fullSystemPrompt,
    tone
  });

  let roundDeadline = Date.now() + ROUND_TIMEOUT_MS;
  // Hard ceiling: all rounds could each burn their full window plus slack.
  const debateHardDeadline = debate.startTime + MAX_ROUNDS * ROUND_TIMEOUT_MS + 15000;

  return await new Promise(resolve => {
    let ticking = false;
    const poll = setInterval(async () => {
      if (ticking) return; // previous tick still awaiting
      ticking = true;
      try {
        await tick();
      } catch (e) {
        console.error('[HiveMind] Poll tick error:', e);
      } finally {
        ticking = false;
      }
    }, POLL_INTERVAL_MS);

    async function tick() {
      if (signal.aborted) {
        clearInterval(poll);
        currentDebate = null;
        updateKeepAlive();
        resolve(null);
        return;
      }
      // Abort can land while this tick is mid-await (e.g. inside the poll
      // allSettled below). On resume, everything downstream — barrier,
      // smart-stop, finalize — must be skipped for an already-finalized
      // debate, or phantom rounds get pushed over the abort's final state.
      if (debate.finalized || currentDebate !== debate) {
        clearInterval(poll);
        return;
      }

      /* ── Hard debate-level ceiling ──
       * Backstop independent of round progress: even with rounds closing
       * late, never run past max_rounds × window + slack. */
      if (Date.now() >= debateHardDeadline) {
        clearInterval(poll);
        agentList.forEach(a => {
          const s = debate.agents[a];
          if (!s.completed && !s.timedOut) {
            s.status = 'timeout';
            s.completed = true;
            s.timedOut = true;
            notifyPopup('agent_update', { agent: a, status: 'timeout' });
          }
        });
        if (!debate.roundClosing && debate.rounds.length < MAX_ROUNDS) {
          debate.roundClosing = true;
          pushRound(debate, collectPendingResponses(debate, agentList));
          debate.roundClosing = false;
        }
        finalizeDebate(debate);
        resolve(debate);
        return;
      }

      /* ── Per-round deadline ── */
      if (Date.now() >= roundDeadline) {
        // Mark every still-unfinished agent — tab OR api — as having missed
        // this round. An API agent hung past its fetch timeouts must not sit
        // in the barrier forever, stalling all remaining rounds.
        agentList.forEach(a => {
          const s = debate.agents[a];
          if (!s.completed && !s.timedOut) {
            s.status = 'timeout';
            s.timedOut = true;
            s.completed = true;
            notifyPopup('agent_update', { agent: a, status: 'timeout' });
          }
        });


        // Close this round with whatever arrived…
        if (!debate.roundClosing) {
          debate.roundClosing = true;
          pushRound(debate, collectPendingResponses(debate, agentList));
          debate.roundClosing = false;
        }

        // …then decide: keep debating with survivors, or end here.
        const survivors = agentList.filter(a => {
          const s = debate.agents[a];
          if (s.kind === 'api') return s.status === 'done';
          return !!s.tabId && s.status === 'done';
        });
        if (survivors.length > 0 && debate.rounds.length < MAX_ROUNDS && !signal.aborted) {
          // Timed-out agents with tabs get one more chance next round.
          const conversationXml = wrapConversation(debate.rounds);
          const isFinalRound = debate.rounds.length === MAX_ROUNDS - 1;
          const adversary = (debate.devilsAdvocate && isFinalRound)
            ? pickAdversary(debate.rounds, agentList)
            : null;
          if (adversary) {
            debate.adversary = adversary;
            notifyPopup('agent_update', { agent: adversary, status: 'adversary' });
          }
          const critiquePrompt = adversary
            ? buildDevilsAdvocatePrompt(prompt, conversationXml)
            : `${prompt}\n\nReview the previous arguments:\n${conversationXml}\n\n` +
              'Provide your updated argument and score in the format [Score: X/10]. Do not repeat your own previous arguments.';
          await Promise.allSettled(agentList.map(async a => {
            const s = debate.agents[a];
            const participates = s.kind === 'api'
              ? s.status === 'done'
              : (s.tabId && (s.status === 'done' || s.status === 'timeout'));
            if (!participates) return;
            s.completed = false;
            s.timedOut = false;
            s.recordedInRound = false;
            s.text = '';
            s.score = 0;
            s.status = 'thinking';
            notifyPopup('agent_update', { agent: a, status: 'thinking' });
            if (s.kind === 'api') launchApiRound(debate, s, a, critiquePrompt);
            else await injectToAgent(s, a, critiquePrompt);
          }));
          if (signal.aborted || debate.finalized || currentDebate !== debate) return;

          roundDeadline = Date.now() + ROUND_TIMEOUT_MS;
        } else {
          // Nobody left standing or rounds exhausted — finish up.
          clearInterval(poll);
          finalizeDebate(debate);
          resolve(debate);
          return;
        }
      }

      /* ── Poll live agents ── */
      await Promise.allSettled(agentList.map(async a => {
        const s = debate.agents[a];
        if (s.completed || s.timedOut || !s.tabId) return;

        const result = await sendToTab(s.tabId, 'poll_response', {});
        if (result === null) {
          s.status = 'unreachable';
          s.completed = true;
          s.timedOut = true;
          notifyPopup('agent_update', { agent: a, status: 'error' });
          return;
        }

        switch (result.status) {
          case 'done':
            s.completed = true;
            s.text = result.text;
            s.score = parseScore(result.text);
            s.status = 'done';
            notifyPopup('agent_update', { agent: a, status: 'done', score: s.score });
            break;
          case 'thinking':
            if (result.tail) maybeSendPartial(a, result.tail);
            break;
          case 'rate_limited':
            s.completed = true;
            s.timedOut = true;
            s.status = 'rate-limited';
            notifyPopup('agent_update', { agent: a, status: 'rate-limited' });
            break;
          case 'error':
            s.completed = true;
            s.timedOut = true;
            s.status = 'error';
            notifyPopup('agent_update', { agent: a, status: 'error' });
            break;
          default:
            break; // thinking/idle — keep waiting
        }
      }));

      // Abort/finalize may have landed while polling was in flight (the
      // abort handler finalizes synchronously). Resumed code below must not
      // touch the debate further.
      if (signal.aborted || debate.finalized || currentDebate !== debate) return;

      /* ── Round barrier ──
       * Includes BOTH kinds: tab agents with live tabs and API agents whose
       * promise hasn't settled yet. An API-only panel must be able to close
       * rounds, and a finished tab panelist must not trigger the next round
       * while an API answer is still in flight. */
      const activeNames = agentList.filter(a => {
        const s = debate.agents[a];
        if (s.kind === 'api') return !s.timedOut;
        return !!s.tabId && !s.timedOut;
      });
      const barrierMet = activeNames.length > 0 && isRoundBarrierMet(debate.agents, activeNames);

      if (barrierMet && !debate.roundClosing) {
        debate.roundClosing = true;
        try {
          const closed = pushRound(debate, collectPendingResponses(debate, agentList));

          // ── Smart Stop: is the panel just echoing itself now? ──
          if (closed && debate.smartStop && debate.rounds.length < MAX_ROUNDS) {
            const conv = detectConvergence(debate.rounds);
            if (conv.converged) {
              debate.stoppedReason = `Smart Stop after round ${debate.rounds.length}: ${conv.reason}`;
              notifyPopup('chart_update', { rounds: debate.rounds });
              clearInterval(poll);
              await maybeRunBlindJudge(debate);
              finalizeDebate(debate);
              resolve(debate);
              return;
            }
          }

          if (closed && debate.rounds.length < MAX_ROUNDS && !signal.aborted) {
            const conversationXml = wrapConversation(debate.rounds);
            const isFinalRound = debate.rounds.length === MAX_ROUNDS - 1;
            // Devil's Advocate: on the final round, the lowest previous
            // scorer argues AGAINST the majority instead of restating.
            const adversary = (debate.devilsAdvocate && isFinalRound)
              ? pickAdversary(debate.rounds, agentList)
              : null;
            if (adversary) {
              debate.adversary = adversary;
              notifyPopup('agent_update', { agent: adversary, status: 'adversary' });
            }
            const critiquePrompt = adversary
              ? buildDevilsAdvocatePrompt(prompt, conversationXml)
              : `${prompt}\n\nReview the previous arguments:\n${conversationXml}\n\n` +
                'Provide your updated argument and score in the format [Score: X/10]. Do not repeat your own previous arguments.';

            await Promise.allSettled(agentList.map(async a => {
              const s = debate.agents[a];
              // Survivors plus timed-out tab agents get another chance; API
              // agents that finished normally always continue.
              const participates = s.kind === 'api'
                ? (s.status === 'done' || s.status === 'rate-limited')
                : (s.tabId && (!s.timedOut || s.status === 'timeout'));
              if (!participates) return;
              s.completed = false;
              s.timedOut = false;
              s.recordedInRound = false;
              s.text = '';
              s.score = 0;
              s.status = 'thinking';
              notifyPopup('agent_update', { agent: a, status: 'thinking' });
              if (s.kind === 'api') launchApiRound(debate, s, a, critiquePrompt);
              else await injectToAgent(s, a, critiquePrompt);
            }));
            // An abort during the re-inject loop must not arm a fresh round
            // window on an already-finalized debate.
            if (signal.aborted || debate.finalized || currentDebate !== debate) return;

            roundDeadline = Date.now() + ROUND_TIMEOUT_MS; // fresh window per round
          }
        } finally {
          debate.roundClosing = false;
        }
      }

      /* ── Completion checks ── */
      const maxRoundsReached = debate.rounds.length >= MAX_ROUNDS;
      if (maxRoundsReached && !debate.roundClosing) {
        clearInterval(poll);
        await maybeRunBlindJudge(debate);
        finalizeDebate(debate);
        resolve(debate);
        return;
      }

      // All agents settled AND at least one round closed → done. If all
      // settled but zero rounds produced (everything died instantly), hold
      // until the round-deadline backstop salvages/finalizes above.
      const allSettled = agentList.every(a => {
        const s = debate.agents[a];
        return s.completed || s.timedOut;
      });
      const anyLive = agentList.some(a => {
        const s = debate.agents[a];
        if (s.kind === 'api') return !s.timedOut && !s.completed;
        return !!s.tabId && !s.timedOut && !s.completed;
      });
      if (allSettled && !anyLive && !debate.roundClosing && debate.rounds.length >= 1) {
        clearInterval(poll);
        await maybeRunBlindJudge(debate);
        finalizeDebate(debate);
        resolve(debate);
      }
    }
  });
}

/* ═══ Post-debate follow-up Q&A ═══
 * One question, one agent: the debate's winner (blind-judge pick, else
 * highest final-round score). Tab agents get a fresh inject+poll loop; API
 * agents answer via askStream. Budget guard applies to API follow-ups too.
 */
function pickLastWinner() {
  const d = debateHistory[0];
  if (!d) return null;
  if (d.winner) return d.winner;
  if (d.judge && Array.isArray(d.judge.verdict) && d.judge.verdict.length) {
    return d.judge.verdict[0].agent;
  }
  const lr = (d.rounds || [])[((d.rounds || []).length || 1) - 1];
  let best = null;
  let bestScore = -1;
  Object.entries((lr && lr.responses) || {}).forEach(([a, resp]) => {
    const sc = Number(resp.score) || 0;
    if (sc > bestScore) { bestScore = sc; best = a; }
  });
  return best;
}

let followUpInFlight = false;

async function runFollowUp(question) {
  // Single-flight + no-debate guard: a follow-up injecting into a tab while
  // a debate owns that agent would corrupt the live round, and two
  // concurrent follow-ups would interleave poll cycles.
  if (currentDebate && !currentDebate.finalized) {
    return { ok: false, error: 'A debate is running — wait for it to finish.' };
  }
  if (followUpInFlight) {
    return { ok: false, error: 'Another follow-up is already in progress.' };
  }
  followUpInFlight = true;
  try {
    return await doFollowUp(question);
  } finally {
    followUpInFlight = false;
  }
}

async function doFollowUp(question) {
  const winner = pickLastWinner();
  if (!winner) return { ok: false, error: 'No completed debate to follow up on.' };
  const last = debateHistory[0];
  const context =
    `Earlier, a multi-agent panel debated:\n"${String(last.prompt || '').slice(0, 1000)}"\n\n` +
    `The panel's synthesis was:\n${String(last.finalConsensus || '').slice(0, 2500)}\n\n` +
    `Answer this follow-up question directly and concisely:\n${question}`;

  if (isApiAgent(winner)) {
    if (!apiBudget.trySpend()) {
      persistBudget();
      return { ok: false, error: 'Hourly API budget exhausted — try again later.' };
    }
    persistBudget();
    const res = await apiClient.askStream(winner, [{ role: 'user', content: context }], () => {});
    if (res.status !== 'done') return { ok: false, error: `${winner}: ${res.reason || res.status}` };
    return { ok: true, agent: winner, text: res.text };
  }

  // Tab agent: fresh submission cycle against the live page.
  const tabs = await findAgentTabs();
  const tabId = tabs[winner];
  if (!tabId) return { ok: false, error: `${winner} has no open tab.` };

  const s = {
    tabId, status: 'thinking', completed: false, timedOut: false,
    recordedInRound: false, text: '', score: 0, kind: 'tab'
  };
  const injected = await injectToAgent(s, winner, context);
  if (!injected) return { ok: false, error: `${winner} tab unreachable.` };

  const deadline = Date.now() + ROUND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const result = await sendToTab(tabId, 'poll_response', {});
    if (result && result.status === 'done' && result.text) {
      return { ok: true, agent: winner, text: result.text };
    }
    if (result && (result.status === 'rate_limited' || result.status === 'error')) {
      return { ok: false, error: `${winner}: ${result.reason || result.status}` };
    }
    if (result === null) break;
  }
  return { ok: false, error: `${winner} did not respond within ${ROUND_TIMEOUT_MS / 1000}s.` };
}

/* ═══ Selector Doctor ═══
 * Aggregated health report: per-tab selector resolution (via the engine's
 * read-only diagnose action), API agent config validity, bridge status.
 * Never mutates debate state — safe anytime.
 */
async function runDiagnostics() {
  const tabs = await findAgentTabs();
  const agents = {};

  await Promise.allSettled(buildAgentList().map(async a => {
    if (isApiAgent(a)) {
      let model;
      let label = PROVIDERS[a] ? PROVIDERS[a].label : a;
      if (a.startsWith('custom:')) {
        const def = getCustomAgent(apiConfig, a.slice('custom:'.length));
        model = def ? def.model : null;
        label = def ? def.name : a;
      } else {
        model = (apiConfig[a] && (apiConfig[a].model || PROVIDERS[a].defaultModel)) || null;
      }
      agents[a] = { kind: 'api', label, enabled: apiClient.enabled(a), model };
      return;
    }
    const tabId = tabs[a];
    if (!tabId) {
      agents[a] = { kind: 'tab', present: false };
      return;
    }
    const res = await sendToTab(tabId, 'diagnose', {
      selectors: selectorBlockFor(a)
    });
    agents[a] = {
      kind: 'tab',
      present: true,
      reachable: !!res,
      report: res ? res.report : null
    };
  }));

  return {
    checkedAt: Date.now(),
    selectorsVersion: (selectors && selectors.version) || null,
    bridgeConnected: !!(bridge && bridge.ws && bridge.ws.readyState === WebSocket.OPEN),
    budgetRemaining: (() => {
      try { return apiBudget.wouldAllow(); } catch { return null; }
    })(),
    agents
  };
}

/* ═══ Custom site onboarding ═══
 * Requests host permission for the origin, stores a site entry with a
 * generic-but-capable selector config, and registers its content script.
 * Nothing here requires a manifest edit — the site is data from here on.
 */
async function addCustomSite(msg) {
  const label = String(msg.label || '').trim();
  let origin;
  try {
    origin = new URL(String(msg.url || '').trim());
  } catch {
    return { ok: false, error: 'That does not look like a valid URL.' };
  }
  if (!/^https?:$/.test(origin.protocol)) {
    return { ok: false, error: 'Only http(s) sites are supported.' };
  }
  const pattern = `${origin.protocol}//${origin.host}/*`;
  const host = origin.hostname.replace(/^www\./, '');
  const id = (msg.id && String(msg.id).trim()) || host.split('.')[0];

  // Permission must be granted before a script can be injected there.
  // Firefox lacks permissions.* for some cases — treat as granted and let
  // injection fail loudly if it truly isn't.
  const hasPermission = await browserAPI.permissions.contains({ origins: [pattern] }).catch(() => true);
  if (!hasPermission) {
    const granted = await browserAPI.permissions.request({ origins: [pattern] }).catch(() => false);
    if (!granted) return { ok: false, error: 'Permission denied for that site.' };
  }

  const site = {
    id,
    label: label || host,
    color: '#9370db',
    visibility: 'lazy',
    origins: [pattern],
    urlTests: [host],
    // Generic config — refine with the Selector Doctor if it misses.
    input: [
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']",
      "textarea"
    ],
    submit: [
      "button[aria-label='Send message']",
      "button[aria-label='Send']",
      "button[type='submit']"
    ],
    output: [
      "div[data-message-author-role='assistant']",
      "div[class*='markdown']",
      "div[class*='prose']"
    ],
    wait_selector: ["button[aria-label='Stop']", "button[aria-label='Stop generating']"],
    wait_selector_visible: true,
    error_patterns: ["something went wrong", "an error occurred"],
    rate_limit_patterns: ["rate limit", "too many requests"]
  };

  userSites = userSites.filter(s => s.id !== id).concat(site);
  enabledLazySites = Array.from(new Set([...enabledLazySites, id]));
  await browserAPI.storage.local.set({ userSites, enabledLazySites });
  activeSites = mergeSites(BUILTIN_SITES, userSites).filter(s => isSiteEnabled(s, enabledLazySites));
  await registerSiteScripts(activeSites);
  return { ok: true, id, sites: activeSites.map(s => s.id) };
}

async function removeCustomSite(siteId) {
  const id = String(siteId || '');
  userSites = userSites.filter(s => s.id !== id);
  enabledLazySites = enabledLazySites.filter(x => x !== id);
  await browserAPI.storage.local.set({ userSites, enabledLazySites });
  activeSites = mergeSites(BUILTIN_SITES, userSites).filter(s => isSiteEnabled(s, enabledLazySites));
  await registerSiteScripts(activeSites);
  return { ok: true, sites: activeSites.map(s => s.id) };
}

/* ═══ State snapshot for popup restore ═══ */
function getStateSnapshot() {
  const bridgeConnected = !!(bridge && bridge.ws && bridge.ws.readyState === WebSocket.OPEN);
  if (!currentDebate) {
    return { running: false, bridgeConnected, history: debateHistory };
  }
  return {
    running: true,
    bridgeConnected,
    startedAt: currentDebate.startTime,
    rounds: currentDebate.rounds,
    agents: Object.fromEntries(
      Object.keys(currentDebate.agents).map(a => [
        a, { status: currentDebate.agents[a].status, score: currentDebate.agents[a].score }
      ])
    ),
    history: debateHistory
  };
}

/* ═══ Message router (popup + content scripts) ═══ */
browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'start_debate':
      runDebate(msg).then(
        result => { try { sendResponse({ ok: true, result }); } catch { /* popup closed */ } },
        err => { try { sendResponse({ ok: false, error: String((err && err.message) || err) }); } catch { /* popup closed */ } }
      );
      return true; // async response

    case 'abort_debate':
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      // Tell live agents to stop generating — otherwise tab panelists keep
      // burning tokens on an answer nobody will read.
      if (currentDebate) {
        Object.values(currentDebate.agents).forEach(s => {
          if (s.tabId && !s.timedOut) sendToTab(s.tabId, 'cancel', {});
        });
      }
      if (currentDebate) {
        if (!currentDebate.finalized) {
          // Keep whatever rounds closed — abort preserves partial results,
          // and finalizeDebate already notifies the popup with them.
          currentDebate.aborted = true;
          finalizeDebate(currentDebate);
        }
        currentDebate = null;
        updateKeepAlive();
      } else {
        notifyPopup('debate_error', {});
      }
      sendResponse({ ok: true });
      break;

    case 'get_state':
      sendResponse(getStateSnapshot());
      break;

    case 'clear_history':
      debateHistory = [];
      persistHistory();
      sendResponse({ ok: true });
      break;

    case 'save_api_config': {
      apiConfig = msg.config && typeof msg.config === 'object' ? msg.config : {};
      browserAPI.storage.local.set({ apiAgents: apiConfig }).catch(() => {});
      sendResponse({ ok: true });
      break;
    }

    case 'get_api_config':
      sendResponse({ config: apiConfig });
      break;

    // Site bridge asks for its own config. Resolve by the page's ORIGIN
    // first (authoritative), then by the id hint. Unknown → empty, and the
    // bridge falls back to its generic config.
    case 'get_site_selectors': {
      const site = siteForOrigin(String(msg.origin || ''), activeSites)
        || siteById(String(msg.site || ''));
      sendResponse({ selectors: site ? selectorsForSite(site) : {} });
      break;
    }

    // ── Add a custom site (fully automated onboarding) ──
    // Requests host permission for the origin, stores a site entry with a
    // generic-but-capable selector config, and registers the content script.
    case 'add_custom_site':
      addCustomSite(msg).then(
        r => { try { sendResponse(r); } catch { /* popup closed */ } },
        err => { try { sendResponse({ ok: false, error: String((err && err.message) || err) }); } catch { /* popup closed */ } }
      );
      return true; // async response

    case 'remove_custom_site':
      removeCustomSite(msg.site).then(
        r => { try { sendResponse(r); } catch { /* popup closed */ } },
        err => { try { sendResponse({ ok: false, error: String((err && err.message) || err) }); } catch { /* popup closed */ } }
      );
      return true; // async response

    // Sites drawer: all known sites (built-in + user) with enabled state.
    case 'list_sites': {
      const all = mergeSites(BUILTIN_SITES, userSites);
      const enabled = new Set(activeSites.map(s => s.id));
      sendResponse({
        sites: all.map(s => ({
          id: s.id,
          label: s.label,
          color: s.color,
          always: s.visibility === 'always',
          custom: userSites.some(u => u.id === s.id),
          enabled: enabled.has(s.id)
        }))
      });
      break;
    }

    // Popup builds its agent rail from this roster — no hardcoded cards.
    case 'get_agent_roster': {
      const roster = buildAgentList().map(id => {
        const site = siteById(id);
        const provider = PROVIDERS[id];
        const custom = id.startsWith('custom:')
          ? getCustomAgent(apiConfig, id.slice('custom:'.length))
          : null;
        return {
          id,
          kind: site ? 'site' : (provider || custom ? 'api' : 'site'),
          label: agentLabel(id),
          color: (site && site.color) || (provider && provider.color) || '#9370db',
          enabled: true
        };
      });
      sendResponse({ roster, sites: activeSites.map(s => ({ id: s.id, label: s.label, color: s.color })) });
      break;
    }

    // Enable/disable a lazy site (or a user-added one) at runtime.
    case 'set_site_enabled': {
      const id = String(msg.site || '');
      const on = !!msg.enabled;
      const next = on
        ? Array.from(new Set([...enabledLazySites, id]))
        : enabledLazySites.filter(x => x !== id);
      enabledLazySites = next;
      browserAPI.storage.local.set({ enabledLazySites: next }).catch(() => {});
      activeSites = mergeSites(BUILTIN_SITES, userSites).filter(s => isSiteEnabled(s, next));
      registerSiteScripts(activeSites)
        .then(() => sendResponse({ ok: true, sites: activeSites.map(s => s.id) }),
              err => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true; // async response
    }

    case 'run_diagnostics':
      runDiagnostics().then(
        report => { try { sendResponse(report); } catch { /* popup closed */ } },
        err => { try { sendResponse({ error: String((err && err.message) || err) }); } catch { /* popup closed */ } }
      );
      return true; // async response

    case 'follow_up':
      runFollowUp(String(msg.question || '').slice(0, 2000)).then(
        result => { try { sendResponse(result); } catch { /* popup closed */ } },
        err => { try { sendResponse({ ok: false, error: String((err && err.message) || err) }); } catch { /* popup closed */ } }
      );
      return true; // async response

    default:
      // Not ours — don't respond or hold the channel.
      break;
  }
});

/* ═══ MV3 keep-alive ═══
 * Per MDN, WebSockets/ports/setInterval do NOT keep a service worker alive —
 * only extension-event traffic resets the ~30s idle timer. Tab agents poll
 * every 500ms (that traffic suffices), but an API-only debate generates no
 * tab traffic, so the worker could be killed mid-debate and the debate would
 * silently die. A periodic alarm fires even from suspension, waking the
 * worker for the duration of any live debate. */
const KEEPALIVE_ALARM = 'hivemind-keepalive';
const BRIDGE_RETRY_ALARM = 'hivemind-bridge-retry';

function updateKeepAlive() {
  try {
    if (currentDebate && !currentDebate.finalized) {
      browserAPI.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
    } else {
      browserAPI.alarms.clear(KEEPALIVE_ALARM);
    }
  } catch { /* alarms unavailable */ }
}

function updateBridgeRetryAlarm() {
  // The setTimeout-based reconnect dies with the worker; an alarm keeps the
  // bridge coming back after long idle periods once the server returns.
  try {
    const needsRetry = !(bridge && bridge.ws &&
      (bridge.ws.readyState === WebSocket.OPEN || bridge.ws.readyState === WebSocket.CONNECTING));
    if (needsRetry) {
      browserAPI.alarms.create(BRIDGE_RETRY_ALARM, { periodInMinutes: 1 });
    } else {
      browserAPI.alarms.clear(BRIDGE_RETRY_ALARM);
    }
  } catch { /* alarms unavailable */ }
}

browserAPI.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // Waking is the whole point; nothing further needed.
  } else if (alarm.name === BRIDGE_RETRY_ALARM) {
    updateBridgeRetryAlarm(); // clears itself once connected
    if (!(bridge && bridge.ws && bridge.ws.readyState === WebSocket.OPEN)) {
      bridge.connect();
    }
  }
});

/* ═══ Initialization ═══ */
(async () => {
  await restoreHistory();
  await restoreApiConfig();
  const ok = await loadSelectors();
  await restoreSites(); // populates activeSites + registers lazy site scripts
  console.log(`[HiveMind] Background initialized (selectors ${ok ? 'ok' : 'INVALID'}, sites: ${activeSites.map(s => s.id).join(', ') || 'none'})`);
  initBridge();
  updateBridgeRetryAlarm();

  bridge.on('start_debate', msg => {
    runDebate({
      prompt: msg.prompt,
      system_prompt: msg.system_prompt,
      tone: msg.tone || 'neutral',
      smart_stop: msg.smart_stop !== false,
      blind_judge: msg.blind_judge !== false,
      devils_advocate: !!msg.devils_advocate,
      telegram_token: msg.telegram_token,
      telegram_chat: msg.telegram_chat
    }).then(result => {
      bridge.send({
        action: 'debate_complete',
        request_id: msg.request_id,
        final_consensus: result ? result.finalConsensus : 'Debate aborted or failed.',
        rounds: result ? result.rounds : [],
        winner: result ? result.winner : null,
        stopped_reason: result ? result.stoppedReason : null
      });
    }).catch(err => {
      bridge.send({
        action: 'debate_complete',
        request_id: msg.request_id,
        final_consensus: `Debate error: ${err.message}`,
        rounds: []
      });
    });
  });
})();
