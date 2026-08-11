/* ── Cross-browser API ── */
const browserAPI = typeof chrome !== 'undefined' ? chrome : browser;

import { parseScore, wrapConversation, synthesizeConsensus, isRoundBarrierMet } from './lib/debate_logic.js';
import { isValidSelectors } from './lib/selectors.js';

/* ── Selectors: bundled-first with remote validation ── */
const REMOTE_SELECTORS_URL = 'https://raw.githubusercontent.com/hivemind-ai/consensus-engine/main/selectors.json';
let selectors = null;

async function loadSelectors() {
  // Always load bundled first
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
    return;
  }

  // Optionally try remote — only override if valid
  try {
    const resp = await fetch(REMOTE_SELECTORS_URL, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const remote = await resp.json();
      if (isValidSelectors(remote)) {
        selectors = remote;
        console.log('[HiveMind] Remote selectors loaded (validated)');
      } else {
        console.warn('[HiveMind] Remote selectors failed validation; keeping bundled');
      }
    }
  } catch { /* keep bundled */ }
}

/* ── Telegram dispatcher ── */
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

/* ── WebSocket Bridge ── */
class BridgeClient {
  constructor(url) {
    this.url = url || 'ws://127.0.0.1:8765';
    this.ws = null;
    this.pending = [];
    this.listeners = {};
  }

  connect() {
    try {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => console.log('[HiveMind] Bridge WS connected');
      this.ws.onmessage = e => {
        try {
          const msg = JSON.parse(e.data);
          this._handle(msg);
        } catch { /* ignore malformed */ }
      };
      this.ws.onclose = () => {
        console.log('[HiveMind] Bridge WS disconnected, reconnecting…');
        setTimeout(() => this.connect(), 3000);
      };
      this.ws.onerror = () => this.ws.close();
    } catch { /* noop */ }
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
}

const bridge = new BridgeClient();

/* ── State machine ── */
const DEBATE_TIMEOUT_MS = 45000;
const POLL_INTERVAL_MS = 500;
const ROUND_COLORS = ['#FF8C00', '#FF69B4', '#9370DB'];

let currentDebate = null;
let abortController = null;

function buildAgentList() {
  return ['chatgpt', 'claude', 'gemini'];
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

/* ── Content script communication ── */
async function sendToTab(tabId, action, payload) {
  try {
    return await browserAPI.tabs.sendMessage(tabId, { action, ...payload });
  } catch {
    return null;
  }
}

async function findAgentTabs() {
  const tabs = await browserAPI.tabs.query({});
  const agents = {};
  for (const tab of tabs) {
    const url = tab.url || '';
    if (url.includes('chatgpt.com')) agents.chatgpt = tab.id;
    else if (url.includes('claude.ai')) agents.claude = tab.id;
    else if (url.includes('gemini.google.com')) agents.gemini = tab.id;
  }
  return agents;
}

/* ── Parallel execution manager ── */
async function runDebate(prompt, systemPrompt, tone, telegramToken, telegramChat) {
  if (currentDebate) return null;

  abortController = new AbortController();
  const signal = abortController.signal;
  const agentList = buildAgentList();
  const agentTabs = await findAgentTabs();

  const debate = {
    prompt,
    systemPrompt,
    tone,
    rounds: [],
    agents: {},
    startTime: Date.now(),
    roundClosing: false
  };

  agentList.forEach(a => {
    const hasTab = !!agentTabs[a];
    debate.agents[a] = {
      status: hasTab ? 'thinking' : 'missing-tab',
      score: 0,
      text: '',
      tabId: agentTabs[a] || null,
      completed: hasTab ? false : true,
      timedOut: hasTab ? false : true
    };
    if (!hasTab) {
      notifyPopup('agent_update', { agent: a, status: 'missing-tab' });
    }
  });

  currentDebate = debate;

  // Notify popup of initial state
  notifyPopup('chart_update', { rounds: debate.rounds });

  // Broadcast prompt to all agent tabs simultaneously
  const broadcastPromises = agentList.map(async agent => {
    const aState = debate.agents[agent];
    if (!aState.tabId) return;
    try {
      await sendToTab(aState.tabId, 'inject_prompt', {
        prompt,
        selectors: selectors[agent] || {}
      });
    } catch { /* noop */ }
  });

  // Also notify bridge
  bridge.send({
    action: 'start_debate',
    prompt,
    system_prompt: systemPrompt,
    tone
  });

  await Promise.allSettled(broadcastPromises);

  // Polling loop
  const deadline = Date.now() + DEBATE_TIMEOUT_MS;

  return new Promise(resolve => {
    const poll = setInterval(async () => {
      if (signal.aborted) {
        clearInterval(poll);
        currentDebate = null;
        resolve(null);
        return;
      }

      // Check timeout
      const now = Date.now();
      if (now >= deadline) {
        clearInterval(poll);
        // Mark remaining thinking agents as timeout
        agentList.forEach(a => {
          if (debate.agents[a].status === 'thinking') {
            debate.agents[a].status = 'timeout';
            debate.agents[a].timedOut = true;
            notifyPopup('agent_update', { agent: a, status: 'timeout' });
          }
        });
        currentDebate = null;
        resolve(debate);
        return;
      }

      // Poll each active agent
      const pollPromises = agentList.map(async agent => {
        const aState = debate.agents[agent];
        if (aState.completed || aState.timedOut || !aState.tabId) return;

        const result = await sendToTab(aState.tabId, 'poll_response', {});
        if (result === null) return;

        // Check various response states
        if (result.status === 'done' && result.text) {
          aState.completed = true;
          aState.text = result.text;
          aState.score = parseScore(result.text);
          aState.status = 'done';
          notifyPopup('agent_update', { agent, status: 'done', score: aState.score });
        } else if (result.status === 'rate_limited') {
          aState.completed = true;
          aState.status = 'rate-limited';
          aState.timedOut = true;
          notifyPopup('agent_update', { agent, status: 'rate-limited' });
        }
        // If still 'thinking', do nothing
      });

      await Promise.allSettled(pollPromises);

      // Barrier sync: only close round when ALL active agents are done/timedOut
      const activeNames = agentList.filter(a => debate.agents[a].tabId);
      const barrierMet = isRoundBarrierMet(debate.agents, activeNames);

      if (barrierMet && !debate.roundClosing && debate.rounds.length < 3) {
        debate.roundClosing = true;

        const roundNum = debate.rounds.length + 1;

        // Gather all non-timed-out agents for scoring in this round
        const roundResponses = {};
        agentList.forEach(a => {
          const aState = debate.agents[a];
          if (aState.completed && aState.text && !aState.timedOut) {
            roundResponses[a] = { text: aState.text, score: aState.score };
          }
        });

        if (Object.keys(roundResponses).length > 0) {
          debate.rounds.push({
            round: roundNum,
            responses: roundResponses
          });

          notifyPopup('chart_update', { rounds: debate.rounds });

          // If fewer than 3 rounds and we have enough data, trigger cross-critique
          if (debate.rounds.length < 3 && !signal.aborted) {
            // Reset completed flag for next round, feed conversation context
            const conversationXml = wrapConversation(debate.rounds);
            const critiquePrompt = `${prompt}\n\nReview the previous arguments:\n${conversationXml}\n\nProvide your updated argument and score in the format [Score: X/10]. Do not repeat your own previous arguments.`;

            const nextRoundPromises = agentList.map(async agent => {
              const aState = debate.agents[agent];
              // Only agents that completed get to critique
              if (aState.completed && !aState.timedOut && aState.tabId) {
                aState.completed = false; // Reset for next round
                aState.status = 'thinking';
                notifyPopup('agent_update', { agent, status: 'thinking' });
                await sendToTab(aState.tabId, 'inject_prompt', {
                  prompt: critiquePrompt,
                  selectors: selectors[agent] || {}
                });
              }
            });
            await Promise.allSettled(nextRoundPromises);
          }
        }

        debate.roundClosing = false;
      }

      // Check if all agents done or max rounds reached
      const allDone = agentList.every(a => debate.agents[a].completed || debate.agents[a].timedOut);
      const maxRounds = debate.rounds.length >= 3;

      if (allDone || maxRounds) {
        clearInterval(poll);

        // Synthesize final consensus
        const finalConsensus = synthesizeConsensus(debate);
        debate.finalConsensus = finalConsensus;

        // Send to bridge
        bridge.send({
          action: 'debate_complete',
          final_consensus: finalConsensus,
          rounds: debate.rounds
        });

        // Send to Telegram
        if (telegramToken && telegramChat) {
          sendTelegram(telegramToken, telegramChat, finalConsensus);
        }

        notifyPopup('debate_complete', {
          agents: Object.fromEntries(
            agentList.map(a => [a, { status: debate.agents[a].status, score: debate.agents[a].score }])
          ),
          rounds: debate.rounds
        });

        currentDebate = null;
        resolve(debate);
      }
    }, POLL_INTERVAL_MS);
  });
}

/* ── Popup notification helper ── */
function notifyPopup(type, data) {
  browserAPI.runtime.sendMessage({ type, ...data }).catch(() => {});
}

/* ── Message listener ── */
browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'start_debate':
      runDebate(
        msg.prompt,
        msg.system_prompt,
        msg.tone,
        msg.telegram_token,
        msg.telegram_chat
      ).then(result => {
        sendResponse(result);
      }).catch(() => {
        sendResponse(null);
      });
      return true; // keep channel open for async

    case 'abort_debate':
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      if (currentDebate) {
        currentDebate = null;
      }
      notifyPopup('debate_error', {});
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false });
      break;
  }
});

/* ── Initialization ── */
loadSelectors().then(() => {
  console.log('[HiveMind] Background script initialized');
  
  // Register bridge listener for incoming API requests
  bridge.on('start_debate', msg => {
    runDebate(
      msg.prompt,
      msg.system_prompt,
      msg.tone || 'neutral',
      msg.telegram_token,
      msg.telegram_chat
    ).then(result => {
      if (result) {
        bridge.send({
          action: 'debate_complete',
          request_id: msg.request_id,
          final_consensus: result.finalConsensus || result.final_consensus || '',
          rounds: result.rounds
        });
      } else {
        bridge.send({
          action: 'debate_complete',
          request_id: msg.request_id,
          final_consensus: 'Debate aborted or failed.',
          rounds: []
        });
      }
    }).catch(err => {
      bridge.send({
        action: 'debate_complete',
        request_id: msg.request_id,
        final_consensus: `Debate error: ${err.message}`,
        rounds: []
      });
    });
  });

  bridge.connect();
});
