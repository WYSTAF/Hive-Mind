/* ── Cross-browser API ── */
const browserAPI = typeof chrome !== 'undefined' ? chrome : browser;

import { computeStats } from '../src/lib/stats.js';

/* ── State ── */
const state = {
  agents: {},
  rounds: [],
  running: false,
  elapsed: 0,
  timerInterval: null,
  theme: 'light',
  consensus: '',
  transcriptAgent: null,
  apiConfig: null,
  roster: []
};

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
const statusText = $('status-text');
const chart = $('stacked-chart');
const agentRow = $('agent-row');
const consensusSection = $('consensus-section');
const consensusContent = $('consensus-content');
const transcriptDetails = $('transcript-details');
const transcriptContent = $('transcript-content');
const liveFeedDetails = $('livefeed-details');
const liveFeed = $('live-feed');

/* ── Live feed ── */
const feedTails = {};

function updateLiveFeed(agent, tail) {
  if (!tail) return;
  const changed = feedTails[agent] !== tail;
  feedTails[agent] = tail;
  liveFeedDetails.hidden = false;
  let row = liveFeed.querySelector(`[data-feed="${CSS.escape(agent)}"]`);
  if (!row) {
    row = document.createElement('div');
    row.className = 'feed-row';
    row.dataset.feed = agent;
    const who = document.createElement('span');
    who.className = 'feed-agent';
    who.textContent = agent;
    const rawTail = document.createElement('span');
    rawTail.className = 'feed-tail';
    row.append(who, rawTail);
    liveFeed.appendChild(row);
  }
  // textContent only — model output never becomes HTML here.
  const tailEl = row.querySelector('.feed-tail');
  tailEl.textContent = tail;
  // Typing cursor rides at the end of whichever agent spoke last.
  liveFeed.querySelectorAll('.feed-tail.typing').forEach(t => {
    if (t !== tailEl) t.classList.remove('typing');
  });
  tailEl.classList.add('typing');
  // Soft honey flash so the eye catches which agent just typed.
  if (changed) {
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  }
}

function clearLiveFeed() {
  Object.keys(feedTails).forEach(k => delete feedTails[k]);
  liveFeed.innerHTML = '';
  liveFeedDetails.hidden = true;
}

/* ── Theme ── */
const mediaDark = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme) {
  const resolved = theme === 'adaptive' ? (mediaDark.matches ? 'dark' : 'light') : theme;
  document.documentElement.setAttribute('data-theme', resolved);
  state.theme = theme;
  browserAPI.storage.local.set({ theme });
  // Chart text colors are sampled from CSS vars at render time.
  renderChart(state.rounds);
}

themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));
mediaDark.addEventListener('change', () => {
  if (state.theme === 'adaptive') applyTheme('adaptive');
});

/* ── Settings persistence ── */
function saveSettings() {
  browserAPI.storage.local.set({
    settings: {
      tone: toneSlider.value,
      tgToken: tgToken.value.trim(),
      tgChat: tgChat.value.trim(),
      smartStop: $('opt-smart-stop').checked,
      blindJudge: $('opt-blind-judge').checked,
      devilsAdvocate: $('opt-devils-advocate').checked
    }
  }).catch(() => {});
}

function restoreSettings() {
  browserAPI.storage.local.get(['settings', 'theme'], res => {
    if (res.theme) {
      themeSelect.value = res.theme;
      applyTheme(res.theme);
    }
    const s = res.settings || {};
    if (s.tone) toneSlider.value = s.tone;
    if (s.tgToken) tgToken.value = s.tgToken;
    if (s.tgChat) tgChat.value = s.tgChat;
    if (typeof s.smartStop === 'boolean') $('opt-smart-stop').checked = s.smartStop;
    if (typeof s.blindJudge === 'boolean') $('opt-blind-judge').checked = s.blindJudge;
    if (typeof s.devilsAdvocate === 'boolean') $('opt-devils-advocate').checked = s.devilsAdvocate;
  });
}
[toneSlider, tgToken, tgChat, $('opt-smart-stop'), $('opt-blind-judge'), $('opt-devils-advocate')]
  .forEach(el => el.addEventListener('change', saveSettings));

/* ── Minimal markdown → HTML for the consensus panel ──
 * Escapes ALL text first, then re-enables a tiny whitelist. No raw HTML from
 * model output ever reaches innerHTML.
 */
function renderMarkdown(text) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let html = esc(text || '');
  html = html
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Blockquote + paragraph/list grouping, line by line.
  const lines = html.split('\n');
  const out = [];
  let para = [];
  let listItems = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; }
  };
  const flushList = () => {
    if (listItems.length) { out.push(`<ul>${listItems.map(li => `<li>${li}</li>`).join('')}</ul>`); listItems = []; }
  };
  for (const line of lines) {
    if (/^- /.test(line)) { flushPara(); listItems.push(line.slice(2)); }
    else {
      flushList();
      if (/^<h[23]>/.test(line)) { flushPara(); out.push(line); }
      else if (/^&gt; /.test(line)) { flushPara(); out.push(`<blockquote>${line.slice(5)}</blockquote>`); }
      else if (line.trim() === '') { flushPara(); }
      else { para.push(line); }
    }
  }
  flushList();
  flushPara();
  return out.join('\n');
}

/* ── Chart rendering ── */
function renderChart(rounds) {
  const W = 760, H = 220, MARGIN = { top: 10, bottom: 30, left: 40, right: 20 };
  const CW = (W - MARGIN.left - MARGIN.right) / Math.max(rounds.length || 1, 1);
  const MAX_SCORE = 10;
  const CHART_H = H - MARGIN.top - MARGIN.bottom;
  const colors = ['#FF8C00', '#FF69B4', '#9370DB'];

  const cs = getComputedStyle(document.documentElement);
  const textColor = cs.getPropertyValue('--text').trim() || '#1a1a2e';
  const textSecondaryColor = cs.getPropertyValue('--text-secondary').trim() || '#6b7280';
  // Colors come from the live roster, so newly-added sites get consistent
  // identity in the chart without touching this file.
  const AGENT_COLORS = Object.fromEntries(
    (state.roster || []).map(a => [a.id, a.color]).filter(([, c]) => c)
  );

  let html = '';

  for (let i = 0; i <= 5; i++) {
    const y = MARGIN.top + (CHART_H - (CHART_H * i / 5));
    html += `<line class="chart-grid" x1="${MARGIN.left}" y1="${y}" x2="${W - MARGIN.right}" y2="${y}"/>`;
    html += `<text class="chart-label" x="${MARGIN.left - 6}" y="${y + 3}" text-anchor="end">${i * 2}</text>`;
  }
  html += `<text class="chart-label" x="12" y="${MARGIN.top + CHART_H / 2}" text-anchor="middle" transform="rotate(-90,12,${MARGIN.top + CHART_H / 2})">Score</text>`;

  rounds.forEach((round, ri) => {
    const agents = Object.keys(round.responses || {});
    const groupW = CW * 0.8;
    const gap = CW * 0.1;
    const x0 = MARGIN.left + ri * CW + gap;
    const barW = groupW / Math.max(agents.length, 1);

    html += `<text class="round-label" x="${x0 + groupW / 2}" y="${H - 4}">R${ri + 1}</text>`;

    agents.forEach((agent, ai) => {
      const resp = round.responses[agent];
      const score = Math.min(Math.max(resp.score || 0, 0), MAX_SCORE);
      const bh = (score / MAX_SCORE) * CHART_H;
      const bx = x0 + ai * barW;
      const by = MARGIN.top + CHART_H - bh;
      // Color per agent (consistent identity across rounds); fallback to
      // round color when an unknown agent appears.
      const fill = AGENT_COLORS[agent] || colors[ri % colors.length];
      const SHORT = { chatgpt: 'GPT', claude: 'CLD', gemini: 'GEM', openrouter: 'OR', cloudflare: 'CF', nvidia: 'NV' };
      const short = SHORT[agent] || agent.slice(0, 3).toUpperCase();
      // Stagger index for grow-in animation (data order across all rounds)
      const idx = ri * Math.max(agents.length, 1) + ai;

      const tip = `${agentDisplayName(agent)} · round ${ri + 1} · ${score}/10`;
      html += `<rect class="bar" style="--i:${idx}" data-tip="${escapeHtml(tip)}" x="${bx}" y="${by}" width="${Math.max(barW - 2, 2)}" height="${Math.max(bh, 1)}" fill="${fill}" rx="2" opacity="0.9"></rect>`;
      if (bh > 14) {
        html += `<text class="bar-score" style="--i:${idx}" x="${bx + (barW - 2) / 2}" y="${by - 4}" font-size="9" fill="${textColor}" text-anchor="middle">${score}</text>`;
      }
      html += `<text class="chart-label" x="${bx + (barW - 2) / 2}" y="${MARGIN.top + CHART_H + 12}" font-size="7" fill="${textSecondaryColor}" text-anchor="middle">${short}</text>`;
    });
  });

  if (!rounds.length) {
    // Empty state: hex outline motif + invitation, in the mono voice.
    html += `<g class="chart-empty">
      <polygon points="380,74 410,91 410,125 380,142 350,125 350,91" fill="none" stroke="${textSecondaryColor}" stroke-width="1.2" opacity=".55"/>
      <circle cx="391" cy="97" r="3.5" fill="${textSecondaryColor}" opacity=".7"/>
      <text x="${W / 2}" y="${H / 2 + 38}" text-anchor="middle" fill="${textSecondaryColor}" font-size="12">No debates yet — write a prompt and launch</text>
    </g>`;
  }

  chart.innerHTML = html;
  buildLegend(rounds);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Chart interactivity: hover tooltip + agent legend ── */
const chartTooltip = $('chart-tooltip');
const chartLegend = $('chart-legend');

function buildLegend(rounds) {
  const names = new Set();
  rounds.forEach(r => Object.keys(r.responses || {}).forEach(a => names.add(a)));
  if (!names.size) { chartLegend.hidden = true; return; }
  const colorOf = id =>
    ((state.roster || []).find(a => a.id === id) || {}).color || '#9370db';
  chartLegend.innerHTML = Array.from(names).map(a =>
    `<span class="legend-chip"><i style="background:${colorOf(a)}"></i>${escapeHtml(agentDisplayName(a))}</span>`
  ).join('');
  chartLegend.hidden = false;
}

chart.addEventListener('mousemove', e => {
  const bar = e.target.closest('rect.bar');
  if (!bar) { chartTooltip.hidden = true; return; }
  chartTooltip.textContent = bar.dataset.tip || '';
  chartTooltip.hidden = false;
  // Position within #chart-section (tooltip is its sibling).
  const host = chart.parentElement;
  const hr = host.getBoundingClientRect();
  const br = bar.getBoundingClientRect();
  chartTooltip.style.left = `${Math.min(Math.max(br.left - hr.left + br.width / 2, 60), hr.width - 60)}px`;
  chartTooltip.style.top = `${Math.max(br.top - hr.top - 30, 0)}px`;
});
chart.addEventListener('mouseleave', () => { chartTooltip.hidden = true; });

/* ── Brand status dot ── */
function setBrandDot(stateName) {
  const dot = $('brand-dot');
  dot.className = `dot ${stateName}`;
  const TITLES = {
    idle: 'Idle — start a debate', running: 'Debate in progress',
    done: 'Consensus reached', error: 'Debate stopped'
  };
  dot.title = TITLES[stateName] || '';
}

/* ── Bridge connectivity chip ── */
function setBridgeChip(connected) {
  let chip = $('bridge-chip');
  if (!chip) {
    chip = document.createElement('span');
    chip.id = 'bridge-chip';
    chip.className = 'bridge-chip';
    $('brand-row').appendChild(chip);
  }
  chip.textContent = connected ? 'BRIDGE' : '';
  chip.classList.toggle('on', !!connected);
}

/* ── Agent rail (rendered from the background roster) ── */
const AVATAR_FONT = { 1: 13, 2: 11, 3: 9, 4: 8, 5: 7 }; // px size by initials length

// Explicit initial overrides where the automatic rule collides
// (Claude/Cloudflare would both render "CL").
const INITIAL_OVERRIDES = { Claude: 'CD', Cloudflare: 'CFR', Gemini: 'GM' };

/** Initials that read well: "ChatGPT"→CG, "Nvidia NIM"→NN, "Claude"→CD. */
function initialsFor(label) {
  const clean = String(label || '?').replace(/[^A-Za-z0-9 ]+/g, ' ').trim();
  if (INITIAL_OVERRIDES[clean]) return INITIAL_OVERRIDES[clean];
  const words = clean.split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) {
    // CamelCase brands: ChatGPT → CG (two capitals, not "Ch").
    const caps = words[0].match(/[A-Z]/g) || [];
    if (caps.length >= 2) return (caps[0] + caps[1]).toUpperCase();
    return words[0].slice(0, 2).toUpperCase();
  }
  return words.slice(0, 3).map(w => w[0].toUpperCase()).join('');
}

function avatarSvg(label, color) {
  const initials = initialsFor(label);
  const fontSize = AVATAR_FONT[initials.length] || 7;
  return `<svg class="agent-logo" viewBox="0 0 48 48" width="40" height="40" aria-hidden="true">
    <circle cx="24" cy="24" r="20" fill="${color}"/>
    <text x="24" y="24" font-size="${fontSize}" fill="white" text-anchor="middle"
      dominant-baseline="central" font-weight="bold" font-family="system-ui,-apple-system,sans-serif">${initials}</text>
  </svg>`;
}

function renderAgentRoster(roster) {
  state.roster = roster || [];
  agentRow.innerHTML = '';
  for (const a of state.roster) {
    const card = document.createElement('div');
    card.className = 'agent-card';
    card.dataset.agent = a.id;
    card.title = `${a.label} (${a.kind === 'api' ? 'API agent' : 'browser tab'})`;
    card.innerHTML = `<div class="agent-ring">${avatarSvg(a.label, a.color || '#9370db')}</div>` +
      `<span class="agent-label">${escapeHtml(a.label)}</span>`;
    agentRow.appendChild(card);
  }
  // Re-apply any live statuses we already know about.
  Object.entries(state.agents).forEach(([id, s]) => updateAgentStatus(id, s.status, s.score));
}

async function refreshRoster() {
  try {
    const res = await sendMessage({ action: 'get_agent_roster' });
    if (res && res.roster) renderAgentRoster(res.roster);
  } catch { /* worker cold-start — the next push repopulates */ }
}

/* ── Agent card status ── */
const STATUS_LABELS = {
  thinking: '', done: '', 'rate-limited': 'limited', timeout: 'timeout',
  'missing-tab': 'no tab', error: 'error', idle: 'idle', 'quota-hold': 'quota',
  'tab-closed': 'tab closed'
};
const DISPLAY_NAMES = {
  chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini',
  openrouter: 'OpenRouter', cloudflare: 'Cloudflare', nvidia: 'Nvidia NIM'
};
// Roster labels win (covers Grok/DeepSeek/user sites and custom agents);
// custom agents fall back to the API config before the roster loads.
const agentDisplayName = a => {
  const fromRoster = ((state.roster || []).find(r => r.id === a) || {}).label;
  if (fromRoster) return fromRoster;
  if (DISPLAY_NAMES[a]) return DISPLAY_NAMES[a];
  if (typeof a === 'string' && a.startsWith('custom:')) {
    const def = (state.apiConfig?.customAgents || []).find(d => d.id === a.slice(7));
    if (def && def.name) return def.name;
    return 'Custom agent';
  }
  // A loaded history entry remembers the label from debate time — this keeps
  // removed/renamed sites readable in past debates.
  const historic = (state.agents[a] || {}).label;
  if (historic) return historic;
  return a.charAt(0).toUpperCase() + a.slice(1);
};

function updateAgentStatus(agent, status, score) {
  state.agents[agent] = { status, score, label: agentDisplayName(agent) };
  const card = agentRow.querySelector(`[data-agent="${agent}"]`);
  if (!card) return;
  card.className = 'agent-card';
  if (status) card.classList.add(`status-${status}`);
  // Completion bloom: brief pop when an agent lands its answer.
  if (status === 'done') {
    card.classList.add('just-done');
    setTimeout(() => card.classList.remove('just-done'), 500);
  }
  const label = card.querySelector('.agent-label');
  const name = agentDisplayName(agent);
  // API agents never have a "tab" — their idle state is a quiet 'idle' chip.
  const kind = ((state.roster || []).find(r => r.id === agent) || {}).kind;
  const effective = (kind === 'api' && status === 'missing-tab') ? 'idle' : status;
  const suffix = STATUS_LABELS[effective] !== undefined && STATUS_LABELS[effective] !== ''
    ? ` · ${STATUS_LABELS[effective]}`
    : '';
  label.textContent = score !== undefined && score !== null && status === 'done'
    ? `${name} ${score}/10`
    : `${name}${suffix}`;
}

function resetAgentCards() {
  agentRow.querySelectorAll('.agent-card[data-agent]').forEach(c => {
    c.className = 'agent-card';
    const label = c.querySelector('.agent-label');
    label.textContent = agentDisplayName(c.dataset.agent);
  });
}

/* ── Timer + round-progress dots (display only — timeouts live in background) ── */
function startTimer(fromElapsed = 0) {
  stopTimer();
  state.elapsed = fromElapsed;
  renderTimer();
  state.timerInterval = setInterval(() => {
    state.elapsed++;
    renderTimer();
  }, 1000);
}

function renderTimer() {
  const s = state.elapsed % 60;
  const m = Math.floor(state.elapsed / 60);
  timerDisplay.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// R1 ○ ○ ● — closed rounds fill left to right as they complete.
function updateRoundDots(closed, total = MAX_ROUND_DOTS) {
  let holder = document.getElementById('round-dots');
  if (!holder) {
    holder = document.createElement('span');
    holder.id = 'round-dots';
    statusText.after(holder);
  }
  holder.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const d = document.createElement('i');
    d.className = i < closed ? 'rdot filled' : 'rdot';
    d.title = `Round ${i + 1}${i < closed ? ' complete' : ''}`;
    holder.appendChild(d);
  }
  holder.hidden = closed === 0 && !state.running;
}
const MAX_ROUND_DOTS = 3;

function stopTimer() {
  clearInterval(state.timerInterval);
}

/* ── Consensus panel ── */
function showConsensus(text, winner) {
  state.consensus = text || '';
  if (!state.consensus) return;
  consensusContent.innerHTML = renderMarkdown(state.consensus);
  // Winner banner — the debate's headline fact, first thing you read.
  if (winner) {
    const w = document.createElement('div');
    w.className = 'winner-banner';
    const label = document.createElement('span');
    label.textContent = `🏆 Winner: ${agentDisplayName(winner)}`;
    w.appendChild(label);
    consensusContent.prepend(w);
  }
  consensusSection.hidden = false;
  // Orchestrated landing: panel rises, honey rule draws under the header.
  consensusSection.classList.remove('reveal');
  void consensusSection.offsetWidth; // restart the animation on re-reveals
  consensusSection.classList.add('reveal');
  $('followup-row').hidden = false; // a finished debate is follow-up-able
}

/* ── Follow-up Q&A ── */
$('btn-followup').addEventListener('click', askFollowUp);
$('followup-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') askFollowUp();
});

async function askFollowUp() {
  const input = $('followup-input');
  const question = input.value.trim();
  if (!question || state.followUpPending) return;
  state.followUpPending = true;
  const btn = $('btn-followup');
  btn.disabled = true;
  statusText.textContent = 'Asking winner…';
  try {
    const res = await sendMessage({ action: 'follow_up', question });
    if (res && res.ok) {
      const entry = document.createElement('div');
      entry.className = 'followup-entry';
      const who = document.createElement('div');
      who.className = 'followup-agent';
      who.textContent = `↳ ${agentDisplayName(res.agent)}:`;
      const ans = document.createElement('div');
      ans.innerHTML = renderMarkdown(res.text);
      entry.append(who, ans);
      consensusContent.appendChild(entry);
      consensusSection.scrollTop = consensusSection.scrollHeight;
      input.value = '';
      statusText.textContent = '';
    } else {
      statusText.textContent = res?.error ? `Follow-up failed: ${res.error}` : 'Follow-up failed';
      setTimeout(() => { statusText.textContent = ''; }, 3500);
    }
  } catch (e) {
    statusText.textContent = `Follow-up error: ${e.message}`;
    setTimeout(() => { statusText.textContent = ''; }, 3500);
  } finally {
    state.followUpPending = false;
    btn.disabled = false;
  }
}

$('btn-copy-consensus').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.consensus);
    statusText.textContent = 'Copied ✓';
    setTimeout(() => { statusText.textContent = ''; }, 2000);
  } catch { /* clipboard denied */ }
});

$('btn-hide-consensus').addEventListener('click', () => {
  consensusSection.hidden = true;
});

$('btn-export').addEventListener('click', exportDebateMarkdown);

function exportDebateMarkdown() {
  const lines = ['# HiveMind Debate Transcript', ''];
  // Use the captured prompt, not the (possibly edited) input box.
  lines.push(`**Prompt:** ${state.prompt || userPrompt.value.trim() || '(unknown)'}`);
  lines.push('');
  state.rounds.forEach(r => {
    lines.push(`## Round ${r.round}`);
    Object.entries(r.responses || {}).forEach(([agent, d]) => {
      lines.push(`### ${agent} (${d.score}/10)`);
      lines.push(d.text);
      lines.push('');
    });
  });
  if (state.consensus) {
    lines.push('---');
    lines.push(state.consensus);
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hivemind-debate-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ── Messaging helpers ── */
function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    try {
      browserAPI.runtime.sendMessage(msg, response => {
        if (browserAPI.runtime.lastError) reject(new Error(browserAPI.runtime.lastError.message));
        else resolve(response);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function setRunningUI(running) {
  state.running = running;
  btnStart.disabled = running;
  btnAbort.disabled = !running;
}

/* ── Start Debate ── */
async function startDebate() {
  const prompt = userPrompt.value.trim();
  if (!prompt) {
    userPrompt.focus();
    statusText.textContent = 'Enter a prompt first';
    setTimeout(() => { statusText.textContent = ''; }, 2500);
    return;
  }

  setRunningUI(true);
  state.rounds = [];
  state.consensus = '';
  state.prompt = prompt; // captured now — the box may be edited mid-debate
  consensusSection.hidden = true;
  transcriptDetails.hidden = true;
  resetAgentCards();
  renderChart([]);
  startTimer(0);
  statusText.textContent = 'Broadcasting…';

  ['chatgpt', 'claude', 'gemini'].forEach(a => updateAgentStatus(a, 'thinking'));

  try {
    const result = await sendMessage({
      action: 'start_debate',
      prompt,
      system_prompt: systemPrompt.value.trim(),
      tone: toneSlider.value,
      telegram_token: tgToken.value.trim(),
      telegram_chat: tgChat.value.trim(),
      smart_stop: $('opt-smart-stop').checked,
      blind_judge: $('opt-blind-judge').checked,
      devils_advocate: $('opt-devils-advocate').checked
    });
    if (!result || !result.ok) {
      statusText.textContent = result?.error ? `Failed: ${result.error}` : 'Debate ended';
    } else if (result.result && result.result.rounds) {
      state.rounds = result.result.rounds;
      renderChart(state.rounds);
    }
  } catch (err) {
    console.error('Debate error:', err);
    statusText.textContent = `Error: ${err.message}`;
  } finally {
    setRunningUI(false);
    stopTimer();
  }
}

/* ── Abort Debate ── */
async function abortDebate() {
  try {
    await sendMessage({ action: 'abort_debate' });
  } catch { /* worker may be restarting */ }
  setRunningUI(false);
  stopTimer();
  statusText.textContent = 'Aborted';
  agentRow.querySelectorAll('.agent-card.status-thinking').forEach(c => {
    c.className = 'agent-card status-timeout';
    const label = c.querySelector('.agent-label');
    const n = c.dataset.agent.charAt(0).toUpperCase() + c.dataset.agent.slice(1);
    label.textContent = `${n} · timeout`;
  });
}

btnStart.addEventListener('click', startDebate);
btnAbort.addEventListener('click', abortDebate);

// Ctrl+Enter launches from the prompt box.
userPrompt.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    startDebate();
  }
});

/* ── Push updates from background ── */
browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'debate_started':
      state.rounds = msg.rounds || [];
      renderChart(state.rounds);
      Object.entries(msg.agents || {}).forEach(([a, d]) => updateAgentStatus(a, d.status));
      clearLiveFeed();
      liveFeedDetails.hidden = false;
      startTimer(0);
      setBrandDot('running');
      updateRoundDots(0); // reset from any previous debate
      statusText.textContent = 'Agents thinking…';
      break;
    case 'agent_partial':
      updateLiveFeed(msg.agent, msg.tail);
      break;
    case 'agent_update':
      if (msg.agent === '__judge__') {
        statusText.textContent = 'Blind judge deliberating…';
        break;
      }
      updateAgentStatus(msg.agent, msg.status, msg.score);
      break;
    case 'chart_update':
      if (msg.rounds) {
        state.rounds = msg.rounds;
        renderChart(msg.rounds);
        buildTranscript(state.rounds);
        updateRoundDots(msg.rounds.length);
        statusText.textContent = `Round ${Math.min(msg.rounds.length + 1, 3)} in progress…`;
      }
      break;
    case 'debate_complete': {
      if (msg.rounds) {
        state.rounds = msg.rounds;
        renderChart(msg.rounds);
        buildTranscript(msg.rounds);
      }
      Object.entries(msg.agents || {}).forEach(([a, d]) =>
        updateAgentStatus(a, d.status, d.score)
      );
      showConsensus(msg.consensus || '', msg.winner);
      updateRoundDots((msg.rounds || []).length);
      clearLiveFeed();
      setRunningUI(false);
      stopTimer();
      setBrandDot('done');
      statusText.textContent = 'Complete ✓';
      break;
    }
    case 'debate_error':
      setRunningUI(false);
      stopTimer();
      setBrandDot('error');
      updateRoundDots(0);
      statusText.textContent = 'Stopped';
      break;
    case 'storage_warning':
      statusText.textContent = msg.message || 'Storage full — history trimmed';
      setTimeout(() => { statusText.textContent = ''; }, 5000);
      break;
  }
  sendResponse({ ok: true });
  return true;
});

/* ── Transcript viewer ── */
function buildTranscript(rounds) {
  if (!rounds.length) { transcriptDetails.hidden = true; return; }
  transcriptDetails.hidden = false;
  transcriptContent.innerHTML = rounds.map(r => `
    <div class="transcript-round">
      <h3>Round ${r.round}</h3>
      ${Object.entries(r.responses || {}).map(([agent, d]) => `
        <div class="transcript-entry">
          <div class="transcript-agent">${escapeHtml(agentDisplayName(agent))} <span class="transcript-score">${d.score}/10</span></div>
          <p>${renderMarkdown(d.text)}</p>
        </div>
      `).join('')}
    </div>
  `).join('');
}

/* ── Sites drawer: enable/disable built-ins, add custom sites ── */
async function refreshSitesList() {
  const list = $('sites-list');
  try {
    const res = await sendMessage({ action: 'list_sites' });
    if (!res || !res.sites) return;
    list.innerHTML = '';
    res.sites.forEach(s => {
      const row = document.createElement('label');
      row.className = 'site-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = s.enabled;
      cb.disabled = s.always; // always-on core sites
      const dot = document.createElement('i');
      dot.className = 'site-dot';
      dot.style.background = s.color || '#9370db';
      const name = document.createElement('span');
      name.className = 'site-name';
      name.textContent = s.label;
      const del = document.createElement('button');
      del.className = 'site-del';
      del.textContent = '✕';
      del.title = 'Remove this site';
      del.hidden = !s.custom;
      del.addEventListener('click', async e => {
        e.preventDefault();
        const r = await sendMessage({ action: 'remove_custom_site', site: s.id });
        if (r && r.ok) { await refreshSitesList(); await refreshRoster(); }
      });
      cb.addEventListener('change', async () => {
        const r = await sendMessage({ action: 'set_site_enabled', site: s.id, enabled: cb.checked });
        if (r && r.ok) await refreshRoster();
      });
      row.append(cb, dot, name, del);
      list.appendChild(row);
    });
  } catch { /* worker unavailable */ }
}

$('btn-add-site').addEventListener('click', async () => {
  const url = $('add-site-url').value.trim();
  const name = $('add-site-name').value.trim();
  const status = $('add-site-status');
  if (!url) { status.textContent = 'Enter the site URL'; return; }
  status.textContent = 'Adding…';
  const res = await sendMessage({ action: 'add_custom_site', url, label: name });
  if (res && res.ok) {
    status.textContent = `Added ✓ — open a tab there and reload it`;
    $('add-site-url').value = '';
    $('add-site-name').value = '';
    await refreshSitesList();
    await refreshRoster();
  } else {
    status.textContent = res?.error ? `Failed: ${res.error}` : 'Failed';
  }
  setTimeout(() => { status.textContent = ''; }, 5000);
});

/* ── Selector Doctor UI ── */
$('btn-run-diagnostics').addEventListener('click', runDiagnosticsUi);

async function runDiagnosticsUi() {
  const btn = $('btn-run-diagnostics');
  const status = $('diag-status');
  const report = $('diagnostics-report');
  if (state.diagPending) return;
  state.diagPending = true;
  btn.disabled = true;
  status.textContent = 'Probing agents…';
  try {
    const r = await sendMessage({ action: 'run_diagnostics' });
    if (!r || r.error) {
      status.textContent = `Failed: ${r?.error || 'no response'}`;
      return;
    }
    status.textContent = `Done ${new Date(r.checkedAt).toLocaleTimeString()}` +
      (r.bridgeConnected ? ' · bridge ✓' : ' · bridge ✗');
    report.innerHTML = '';
    Object.entries(r.agents || {}).forEach(([name, info]) => {
      const card = document.createElement('div');
      card.className = 'diag-card';
      const head = document.createElement('div');
      head.className = 'diag-head';

      if (info.kind === 'api') {
        const label = info.label || agentDisplayName(name);
        head.textContent = `${label} — API ${info.enabled ? '✓ enabled' : '○ disabled'}${info.model ? ` (${info.model})` : ''}`;
        head.classList.add(info.enabled ? 'ok' : 'dim');
      } else if (!info.present) {
        head.textContent = `${agentDisplayName(name)} — no tab open`;
        head.classList.add('warn');
      } else if (!info.reachable) {
        head.textContent = `${agentDisplayName(name)} — tab open but content script unreachable (reload the tab)`;
        head.classList.add('bad');
      } else {
        const bad = Object.entries(info.report || {}).filter(([, v]) => v.ok === false);
        head.textContent = `${agentDisplayName(name)} — ${bad.length ? `${bad.length} selector group(s) failing` : 'all selectors ✓'}`;
        head.classList.add(bad.length ? 'warn' : 'ok');
        if (Array.isArray(info.otherTabs) && info.otherTabs.length) {
          const note = document.createElement('div');
          note.className = 'diag-line dim';
          note.textContent = `  ${info.otherTabs.length} other tab(s) open — using the most recent`;
          card.appendChild(note);
        }
        // Per-array detail
        Object.entries(info.report).forEach(([arr, v]) => {
          if (arr === 'outputSample') return;
          const line = document.createElement('div');
          line.className = 'diag-line' + (v.ok ? '' : ' bad');
          line.textContent = v.ok
            ? `  ${arr}: #${v.matchedIndex + 1} ${v.matched}`
            : `  ${arr}: NO MATCH across ${v.tried} selector(s)`;
          card.appendChild(line);
          (v.invalidSelectors || []).forEach(sel => {
            const inv = document.createElement('div');
            inv.className = 'diag-line bad';
            inv.textContent = `    invalid regex/selector: ${sel}`;
            card.appendChild(inv);
          });
        });
        if (info.report.outputSample) {
          const sample = document.createElement('div');
          sample.className = 'diag-line dim';
          sample.textContent = `  output reads: "${info.report.outputSample.slice(0, 80)}"`;
          card.appendChild(sample);
        }
      }
      card.prepend(head); // head always first, after all detail lines built
      report.appendChild(card);
    });
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
  } finally {
    state.diagPending = false;
    btn.disabled = false;
  }
}

/* ── Prompt library ── */
const PROMPTLIB_KEY = 'promptLibrary';
const promptlibSelect = $('promptlib-select');
// Serialize read-modify-write cycles: two rapid saves must not clobber
// each other's entries (last-writer-wins would drop one).
let promptLibQueue = Promise.resolve();

async function loadPromptLibrary() {
  try {
    const res = await browserAPI.storage.local.get(PROMPTLIB_KEY);
    return Array.isArray(res[PROMPTLIB_KEY]) ? res[PROMPTLIB_KEY] : [];
  } catch { return []; }
}

function mutatePromptLibrary(mutator) {
  promptLibQueue = promptLibQueue.then(async () => {
    const lib = await loadPromptLibrary();
    await browserAPI.storage.local.set({ [PROMPTLIB_KEY]: mutator(lib).slice(0, 30) });
  }).catch(() => {});
  return promptLibQueue;
}

function renderPromptLibrary(lib) {
  // Keep the placeholder option, replace everything after it.
  promptlibSelect.innerHTML = '<option value="">📚 Saved prompts…</option>' +
    lib.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
}

async function refreshPromptLibrary() {
  renderPromptLibrary(await loadPromptLibrary());
}

promptlibSelect.addEventListener('change', async () => {
  if (!promptlibSelect.value) return;
  const lib = await loadPromptLibrary();
  const entry = lib.find(p => p.id === promptlibSelect.value);
  if (entry) {
    userPrompt.value = entry.text;
    statusText.textContent = 'Loaded from library';
    setTimeout(() => { statusText.textContent = ''; }, 2000);
  }
  // Selection intentionally stays so 🗑 can target it.
});

$('btn-save-prompt').addEventListener('click', async () => {
  const text = userPrompt.value.trim();
  if (!text) { statusText.textContent = 'Nothing to save'; setTimeout(() => { statusText.textContent = ''; }, 2000); return; }
  const name = text.length > 42 ? `${text.slice(0, 42)}…` : text;
  // No button-disable here: the mutation queue serializes writes, so rapid
  // clicks are safe (and disabling would silently drop clicks).
  await mutatePromptLibrary(lib =>
    [{ id: `p${Date.now()}${Math.floor(Math.random() * 1e4)}`, name, text }, ...lib]);
  await refreshPromptLibrary();
  statusText.textContent = 'Saved to library ✓';
  setTimeout(() => { statusText.textContent = ''; }, 2000);
});

$('btn-del-prompt').addEventListener('click', async () => {
  if (!promptlibSelect.value) { statusText.textContent = 'Pick a saved prompt first'; setTimeout(() => { statusText.textContent = ''; }, 2000); return; }
  const doomed = promptlibSelect.value;
  await mutatePromptLibrary(lib => lib.filter(p => p.id !== doomed));
  await refreshPromptLibrary();
});

refreshPromptLibrary();

/* ── API agents settings ── */
const PROVIDER_META = {
  openrouter: { color: '#6366f1' },
  cloudflare: { color: '#f38020' },
  nvidia: { color: '#76b900' }
};

function readApiConfigFromUi() {
  const config = {};
  document.querySelectorAll('.api-agent-row').forEach(row => {
    const p = row.dataset.provider;
    const enabled = row.querySelector('.api-enabled').checked;
    const key = row.querySelector('.api-key').value.trim();
    const model = row.querySelector('.api-model').value.trim();
    const accountEl = row.querySelector('.api-account');
    config[p] = { enabled, key, model };
    if (accountEl) config[p].accountId = accountEl.value.trim();
  });
  // Custom agents: rows carry data-id; blank name/URL drops the entry.
  const customs = [];
  document.querySelectorAll('.custom-agent-row').forEach(row => {
    const id = row.dataset.id;
    const name = row.querySelector('.ca-name').value.trim();
    const baseUrl = row.querySelector('.ca-url').value.trim();
    const key = row.querySelector('.ca-key').value.trim();
    const model = row.querySelector('.ca-model').value.trim();
    const enabled = row.querySelector('.ca-enabled').checked;
    if (!name || !baseUrl || !model) return; // incomplete → dropped
    customs.push({ id: id || `c${Date.now()}${Math.floor(Math.random() * 1e4)}`, name, baseUrl, key, model, enabled });
  });
  config.customAgents = customs;
  return config;
}

function fillApiConfigUi(config) {
  document.querySelectorAll('.api-agent-row').forEach(row => {
    const p = row.dataset.provider;
    const c = (config && config[p]) || {};
    row.querySelector('.api-enabled').checked = !!c.enabled;
    if (c.key) row.querySelector('.api-key').value = c.key;
    if (c.model) row.querySelector('.api-model').value = c.model;
    const accountEl = row.querySelector('.api-account');
    if (accountEl && c.accountId) accountEl.value = c.accountId;
  });
  renderCustomAgents((config && Array.isArray(config.customAgents)) ? config.customAgents : []);
}

/* ── Custom agent rows ── */
function renderCustomAgents(agents) {
  const list = $('custom-agents-list');
  list.innerHTML = '';
  agents.forEach(def => list.appendChild(buildCustomRow(def)));
}

function buildCustomRow(def = {}) {
  const row = document.createElement('div');
  row.className = 'custom-agent-row';
  row.dataset.id = def.id || '';

  const mk = (cls, placeholder, value, type = 'text') => {
    const el = document.createElement('input');
    el.className = cls;
    el.type = type;
    el.placeholder = placeholder;
    if (value) el.value = value;
    return el;
  };

  const top = document.createElement('div');
  top.className = 'ca-top';
  const toggle = document.createElement('label');
  toggle.className = 'api-toggle';
  const cb = document.createElement('input');
  cb.className = 'ca-enabled';
  cb.type = 'checkbox';
  cb.checked = !!def.enabled;
  toggle.append(cb, Object.assign(document.createElement('strong'), { textContent: def.name || 'New custom agent' }));
  const del = document.createElement('button');
  del.className = 'ca-del';
  del.textContent = '✕';
  del.title = 'Remove this agent';
  del.addEventListener('click', () => row.remove());
  top.append(toggle, del);

  const nameIn = mk('ca-name', 'Display name', def.name);
  const urlIn = mk('ca-url', 'Base URL e.g. https://host/v1', def.baseUrl);
  const keyIn = mk('ca-key', 'API key', def.key, 'password');
  const modelIn = mk('ca-model', 'Model id e.g. qwen2.5-72b', def.model);

  row.append(top, nameIn, urlIn, keyIn, modelIn);
  // Live-update the strong label as the user types a name.
  nameIn.addEventListener('input', () => {
    toggle.lastChild.textContent = nameIn.value.trim() || 'New custom agent';
  });
  return row;
}

$('btn-add-custom').addEventListener('click', () => {
  $('custom-agents-list').appendChild(buildCustomRow({ enabled: true }));
});

$('btn-save-api').addEventListener('click', async () => {
  try {
    await sendMessage({ action: 'save_api_config', config: readApiConfigFromUi() });
    $('api-status').textContent = 'Saved ✓';
  } catch (e) {
    $('api-status').textContent = `Failed: ${e.message}`;
  }
  setTimeout(() => { $('api-status').textContent = ''; }, 2500);
});

/* ── History browser + panel stats + JSONL export ── */
// computeStats is imported from ../src/lib/stats.js at the top of this module.

function renderStats(history) {
  const box = $('stats-summary');
  const s = computeStats(history);
  if (!s.totalDebates) { box.innerHTML = '<div class="stats-empty">No debates yet.</div>'; return; }
  const rows = Object.entries(s.perAgent)
    .sort((a, b) => (b[1].wins - a[1].wins) || ((b[1].avgSelfScore || 0) - (a[1].avgSelfScore || 0)))
    .map(([name, v]) => {
      const winPct = v.appearances ? Math.round((v.wins / v.appearances) * 100) : 0;
      return `<tr><td>${escapeHtml(agentDisplayName(name))}</td>` +
        `<td>${v.appearances}</td><td>${winPct}%</td>` +
        `<td>${v.avgSelfScore === null ? '—' : v.avgSelfScore}</td>` +
        `<td>${v.timeouts + v.rateLimits + v.errors}</td></tr>`;
    }).join('');
  box.innerHTML =
    `<table class="stats-table"><thead><tr>` +
    `<th>Agent</th><th>Debates</th><th>Wins</th><th>Avg score</th><th>Fails</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>` +
    `<div class="stats-note">${s.judgedDebates}/${s.totalDebates} debates blind-judged</div>`;
}

function exportHistoryJsonl(history) {
  const lines = (history || []).map(d => {
    // OpenAI fine-tune shape: one user turn, one assistant turn per debate.
    const messages = [
      ...(d.systemPrompt ? [{ role: 'system', content: d.systemPrompt }] : []),
      { role: 'user', content: d.prompt || '' },
      { role: 'assistant', content: d.finalConsensus || '' }
    ];
    return JSON.stringify({ messages });
  });
  const blob = new Blob([lines.join('\n') + '\n'], { type: 'application/jsonl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hivemind-history-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function renderHistory(history) {
  const list = $('history-list');
  list.innerHTML = '';
  if (!history || !history.length) {
    const none = document.createElement('div');
    none.className = 'history-empty';
    none.textContent = 'No debates yet.';
    list.appendChild(none);
    return;
  }
  history.forEach((h, i) => {
    const item = document.createElement('button');
    item.className = 'history-item';
    const when = new Date(h.finishedAt || Date.now()).toLocaleDateString();
    const excerpt = String(h.prompt || '').slice(0, 60);
    const winner = h.winner ? ` · 🏆 ${agentDisplayName(h.winner)}` : '';
    item.innerHTML = `<span class="hi-date">${escapeHtml(when)}</span> ${escapeHtml(excerpt)}${winner ? `<span class="hi-winner">${escapeHtml(winner)}</span>` : ''}`;
    item.title = `${h.prompt || ''}${h.stoppedReason ? `\n(${h.stoppedReason})` : ''}`;
    item.addEventListener('click', () => loadHistoryEntry(h));
    list.appendChild(item);
  });
}

function loadHistoryEntry(h) {
  userPrompt.value = h.prompt || '';
  state.rounds = h.rounds || [];
  state.consensus = h.finalConsensus || '';
  state.prompt = h.prompt || '';
  renderChart(state.rounds);
  buildTranscript(state.rounds);
  showConsensus(state.consensus, h.winner);
  Object.entries(h.agents || {}).forEach(([a, d]) => updateAgentStatus(a, d.status, d.score));
  statusText.textContent = 'Loaded from history';
  setTimeout(() => { statusText.textContent = ''; }, 2000);
}

$('btn-clear-history').addEventListener('click', async () => {
  try {
    await sendMessage({ action: 'clear_history' });
    renderHistory([]);
  } catch { /* worker unavailable */ }
});

$('btn-export-jsonl').addEventListener('click', async () => {
  try {
    const snap = await sendMessage({ action: 'get_state' });
    exportHistoryJsonl((snap && snap.history) || []);
  } catch { /* worker unavailable */ }
});

/* ── Restore running debate / last results on open ── */
(async function initPopup() {
  restoreSettings();
  try {
    const [snap, apiRes, rosterRes] = await Promise.all([
      sendMessage({ action: 'get_state' }),
      sendMessage({ action: 'get_api_config' }).catch(() => null),
      sendMessage({ action: 'get_agent_roster' }).catch(() => null)
    ]);
    if (apiRes && apiRes.config) {
      state.apiConfig = apiRes.config; // custom-agent display names resolve from here
      fillApiConfigUi(apiRes.config);
    }
    // Roster first: names/colors feed the chart, legend, and cards.
    if (rosterRes && rosterRes.roster) renderAgentRoster(rosterRes.roster);
    refreshSitesList(); // sites drawer (async, non-blocking)
    setBridgeChip(!!(snap && snap.bridgeConnected));
    if (snap) renderHistory(snap.history);
    if (snap) renderStats(snap.history);
    if (!snap) { renderChart(state.rounds); return; }
    if (snap.history && snap.history.length && !snap.running) {
      const last = snap.history[0];
      userPrompt.value = last.prompt;
      state.rounds = last.rounds || [];
      renderChart(state.rounds);
      buildTranscript(state.rounds);
      showConsensus(last.finalConsensus, last.winner);
      Object.entries(last.agents || {}).forEach(([a, d]) =>
        updateAgentStatus(a, d.status, d.score)
      );
    }
    if (snap.running) {
      setRunningUI(true);
      state.rounds = snap.rounds || [];
      renderChart(state.rounds);
      buildTranscript(state.rounds);
      liveFeedDetails.hidden = false;
      const startedAt = snap.startedAt || Date.now();
      startTimer(Math.floor((Date.now() - startedAt) / 1000));
      statusText.textContent = 'Debate in progress…';
      Object.entries(snap.agents || {}).forEach(([a, d]) =>
        updateAgentStatus(a, d.status, d.score)
      );
    }
  } catch { /* worker cold-start race — push messages will populate */ }
  renderChart(state.rounds);
})();
