/* ── Cross-browser API ── */
const browserAPI = typeof chrome !== 'undefined' ? chrome : browser;

/* ── State ── */
let state = {
  agents: {},
  rounds: [],
  running: false,
  elapsed: 0,
  timerInterval: null,
  theme: 'light'
};

let currentAbort = null; // AbortController for in-flight debate

/* ── DOM refs ── */
const $ = id => document.getElementById(id);
const userPrompt = $('user-prompt');
const systemPrompt = $('system-prompt');
const toneSlider = $('tone-slider');
const tgToken = $('tg-token');
const tgChat = $('tg-chat');
const themeSelect = $('theme-select');
const btnStart = $('btn-start');
const btnAbort = $('btn-abort');
const timerDisplay = $('timer-display');
const chart = $('stacked-chart');
const agentRow = $('agent-row');

/* ── Theme ── */
const mediaDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme) {
  if (theme === 'adaptive') {
    document.documentElement.setAttribute('data-theme', mediaDark.matches ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  state.theme = theme;
  browserAPI.storage.local.set({ theme });
}

themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
mediaDark.addEventListener('change', () => {
  if (state.theme === 'adaptive') applyTheme('adaptive');
});

// Restore saved theme
browserAPI.storage.local.get('theme', result => {
  const t = result.theme || 'light';
  themeSelect.value = t;
  applyTheme(t);
});

/* ── Chart rendering ── */
function renderChart(rounds) {
  const ns = 'http://www.w3.org/2000/svg';
  const W = 760, H = 220, MARGIN = { top: 10, bottom: 30, left: 40, right: 20 };
  const CW = (W - MARGIN.left - MARGIN.right) / Math.max(rounds.length || 1, 1);
  const MAX_SCORE = 10;
  const CHART_H = H - MARGIN.top - MARGIN.bottom;
  const colors = ['#FF8C00', '#FF69B4', '#9370DB']; // per round

  // Get computed CSS variable values for SVG text fills
  const computedStyle = getComputedStyle(document.documentElement);
  const textColor = computedStyle.getPropertyValue('--text').trim() || '#1a1a2e';
  const textSecondaryColor = computedStyle.getPropertyValue('--text-secondary').trim() || '#6b7280';

  let html = '';

  // Grid lines
  for (let i = 0; i <= 5; i++) {
    const y = MARGIN.top + (CHART_H - (CHART_H * i / 5));
    html += `<line class="chart-grid" x1="${MARGIN.left}" y1="${y}" x2="${W - MARGIN.right}" y2="${y}"/>`;
    html += `<text class="chart-label" x="${MARGIN.left - 6}" y="${y + 3}" text-anchor="end">${(i * 2)}</text>`;
  }

  // Y-axis label
  html += `<text class="chart-label" x="12" y="${MARGIN.top + CHART_H / 2}" text-anchor="middle" transform="rotate(-90,12,${MARGIN.top + CHART_H / 2})">Score</text>`;

  // Columns per round
  rounds.forEach((round, ri) => {
    const agents = Object.keys(round.responses || {});
    const numAgents = agents.length;
    const groupW = CW * 0.8;
    const gap = CW * 0.1;
    const x0 = MARGIN.left + ri * CW + gap;
    const barW = groupW / Math.max(numAgents, 1);

    html += `<text class="round-label" x="${x0 + groupW / 2}" y="${H - 4}">R${ri + 1}</text>`;

    agents.forEach((agent, ai) => {
      const resp = round.responses[agent];
      const score = Math.min(Math.max(resp.score || 0, 0), MAX_SCORE);
      const bh = (score / MAX_SCORE) * CHART_H;
      const bx = x0 + ai * barW;
      const by = MARGIN.top + CHART_H - bh;

      // Color from round index, fallback to purple
      const color = colors[ri % colors.length];
      html += `<rect x="${bx}" y="${by}" width="${Math.max(barW - 2, 2)}" height="${Math.max(bh, 1)}" fill="${color}" rx="2" opacity="0.9"/>`;
      html += `<text x="${bx + (barW - 2) / 2}" y="${by - 4}" font-size="9" fill="${textColor}" text-anchor="middle">${score}</text>`;
    });
  });

  // Empty state
  if (!rounds.length) {
    html += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="${textSecondaryColor}" font-size="13">Start a debate to see results</text>`;
  }

  chart.innerHTML = html;
}

/* ── Agent card status ── */
function updateAgentStatus(agent, status, score) {
  const card = agentRow.querySelector(`[data-agent="${agent}"]`);
  if (!card) return;
  card.className = 'agent-card';
  if (status) card.classList.add(`status-${status}`);
  const label = card.querySelector('.agent-label');
  if (score !== undefined) label.textContent = `${agent.charAt(0).toUpperCase() + agent.slice(1)} ${score}/10`;
}

function resetAgentCards() {
  agentRow.querySelectorAll('.agent-card').forEach(c => {
    c.className = 'agent-card';
    const label = c.querySelector('.agent-label');
    label.textContent = c.dataset.agent.charAt(0).toUpperCase() + c.dataset.agent.slice(1);
  });
}

/* ── Timer ── */
function startTimer() {
  state.elapsed = 0;
  clearInterval(state.timerInterval);
  state.timerInterval = setInterval(() => {
    state.elapsed++;
    const s = state.elapsed % 60;
    const m = Math.floor(state.elapsed / 60);
    timerDisplay.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} / 45s`;
    if (state.elapsed >= 45) {
      clearInterval(state.timerInterval);
      // Auto-abort debate when timer reaches 45s
      if (state.running && currentAbort) {
        abortDebate();
      }
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(state.timerInterval);
}

/* ── Messaging ── */
function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    try {
      browserAPI.runtime.sendMessage(msg, response => {
        if (browserAPI.runtime.lastError) {
          reject(new Error(browserAPI.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}

/* ── Start Debate ── */
async function startDebate() {
  const prompt = userPrompt.value.trim();
  if (!prompt) return;

  state.running = true;
  btnStart.disabled = true;
  btnAbort.disabled = false;
  state.rounds = [];
  resetAgentCards();
  renderChart(state.rounds);
  startTimer();

  // All agents start thinking
  ['chatgpt', 'claude', 'gemini'].forEach(a => updateAgentStatus(a, 'thinking'));

  currentAbort = new AbortController();

  try {
    const result = await sendMessage({
      action: 'start_debate',
      prompt,
      system_prompt: systemPrompt.value.trim(),
      tone: toneSlider.value,
      telegram_token: tgToken.value.trim(),
      telegram_chat: tgChat.value.trim()
      // Note: AbortController signal cannot be serialized via postMessage
      // Abort is handled via separate 'abort_debate' message
    });

    if (result && result.rounds) {
      state.rounds = result.rounds;
      renderChart(result.rounds);
    }

    // Update final agent statuses
    if (result && result.agents) {
      Object.entries(result.agents).forEach(([agent, data]) => {
        updateAgentStatus(agent, data.status, data.score);
      });
    }
  } catch (err) {
    console.error('Debate error:', err);
  } finally {
    state.running = false;
    btnStart.disabled = false;
    btnAbort.disabled = true;
    stopTimer();
    currentAbort = null;
  }
}

/* ── Abort Debate ── */
function abortDebate() {
  if (currentAbort) {
    currentAbort.abort();
    currentAbort = null;
  }
  sendMessage({ action: 'abort_debate' });
  state.running = false;
  btnStart.disabled = false;
  btnAbort.disabled = true;
  stopTimer();
  // Mark all thinking agents as timeout
  agentRow.querySelectorAll('.agent-card.status-thinking').forEach(c => {
    c.className = 'agent-card status-timeout';
  });
}

/* ── Event bindings ── */
btnStart.addEventListener('click', startDebate);
btnAbort.addEventListener('click', abortDebate);

/* ── State sync from background ── */
browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'agent_update':
      updateAgentStatus(msg.agent, msg.status, msg.score);
      sendResponse({ ok: true });
      break;
    case 'chart_update':
      if (msg.rounds) {
        state.rounds = msg.rounds;
        renderChart(msg.rounds);
      }
      sendResponse({ ok: true });
      break;
    case 'debate_complete':
      if (msg.rounds) {
        state.rounds = msg.rounds;
        renderChart(msg.rounds);
      }
      if (msg.agents) {
        Object.entries(msg.agents).forEach(([agent, data]) => {
          updateAgentStatus(agent, data.status, data.score);
        });
      }
      btnStart.disabled = false;
      btnAbort.disabled = true;
      state.running = false;
      stopTimer();
      sendResponse({ ok: true });
      break;
    case 'debate_error':
      btnStart.disabled = false;
      btnAbort.disabled = true;
      state.running = false;
      stopTimer();
      sendResponse({ ok: true });
      break;
  }
  return true;
});

/* ── Initial render ── */
renderChart([]);
