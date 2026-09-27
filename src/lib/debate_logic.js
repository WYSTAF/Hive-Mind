/* ── Pure debate logic: scoring, XML wrapping, consensus synthesis, barrier ──
 * No DOM or extension APIs — unit-testable with plain node.
 */

const MAX_AGENT_TEXT_CHARS = 4000; // bounds the cross-critique prompt size

export function parseScore(text) {
  if (!text) return 0;
  // Use the LAST match of each pattern: models routinely restate their
  // previous-round score ("previously [Score: 7/10]") before their updated
  // verdict, and devil's-advocate answers end with the majority-survival
  // score. First-match parsing grades agents on stale numbers.
  let m;
  const lastMatch = re => {
    let out = null;
    let mm;
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    while ((mm = r.exec(text)) !== null) out = mm;
    return out;
  };

  // [Score: X/10] / [Score: X] / Score: X/10 — decimals allowed. A leading
  // minus is captured so negative claims read as invalid, not as positive.
  m = lastMatch(/\[?\s*Score\s*:\s*(-?\d+(?:\.\d+)?)\s*\/?\s*(\d+(?:\.\d+)?)?\s*\]?/i);
  if (m) {
    const val = parseFloat(m[1]);
    const max = m[2] ? parseFloat(m[2]) : 10;
    if (!Number.isFinite(val) || val < 0 || max <= 0) return 0;
    // A numerator above its own denominator ("20/10", "100/10") is a model
    // claiming perfection, not a credible score. Discard it — clamping would
    // hand it a perfect 10 and let it win the debate outright.
    if (val > max) return 0;
    // Alternative maxima (7/20) are legitimate and rescale onto the 10-point
    // scale; an absurd denominator (x/1000) is not a rating at all.
    if (max <= 100) return clampScore(Math.round((val / max) * 10));
    return 0;
  }
  // "X out of 10" / "X/10" — denominator must be exactly 10 to count.
  m = lastMatch(/(?:^|[^\d])(\d{1,2}(?:\.\d+)?)\s*(?:out\s*of|\/)\s*(\d{1,2})(?![\d\/])/i);
  if (m && m[2] === '10') return clampScore(Math.round(parseFloat(m[1])));
  // "rated X" / "score X"
  m = lastMatch(/(?:rated|score|rating)[:\s]*(\d+(?:\.\d+)?)/i);
  if (m) return clampScore(Math.round(parseFloat(m[1])));
  return 0;
}

function clampScore(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 10);
}

// Human-readable agent status, for the synthesis report.
const STATUS_PHRASES = {
  'tab-closed': 'tab was closed',
  'missing-tab': 'no tab open',
  timeout: 'timed out',
  'rate-limited': 'rate limited',
  'quota-hold': 'held by API budget',
  unreachable: 'tab unreachable',
  disabled: 'turned off mid-debate',
  error: 'errored',
  thinking: 'still thinking'
};

export function truncateForPrompt(text, max = MAX_AGENT_TEXT_CHARS) {
  const t = String(text || '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  // Prefer cutting on a paragraph/sentence boundary over mid-word.
  const brk = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '));
  if (brk > max * 0.5) return cut.slice(0, brk + 1) + '\n…[truncated]';
  return cut + '…[truncated]';
}

function escapeXml(s) {
  return String(s)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&apos;');
}

/**
 * Build the cross-critique transcript handed to each agent.
 *
 * Prompt size scales as agents x rounds x answer length, which grows fast on
 * large panels (6 agents x verbose answers reached ~12k tokens by round 3).
 * To keep prompts affordable and inside small models' context windows, only
 * the most recent round is quoted in full; older rounds are compressed to
 * their score + opening claim, which is what later critique actually needs.
 */
export function wrapConversation(rounds, { maxAgentChars = MAX_AGENT_TEXT_CHARS, recentFullRounds = 1, olderChars = 280 } = {}) {
  if (!Array.isArray(rounds) || !rounds.length) return '<atagh_fekr_conversation>\n</atagh_fekr_conversation>';
  const newest = rounds.length - 1;
  // fullFrom = index of the oldest round that is still quoted in full.
  // recentFullRounds <= 0 means "condense everything".
  const fullFrom = recentFullRounds <= 0
    ? rounds.length
    : Math.max(0, newest - (recentFullRounds - 1));

  let xml = '<atagh_fekr_conversation>\n';
  rounds.forEach((round, i) => {
    xml += `  <round number="${i + 1}">\n`;
    Object.entries(round.responses || {}).forEach(([agent, data]) => {
      if (!data.text) return;
      xml += `    <agent name="${escapeXml(agent)}" score="${data.score}">\n`;
      if (i >= fullFrom) {
        xml += `      ${escapeXml(truncateForPrompt(data.text, maxAgentChars))}\n`;
      } else {
        // Older round: keep the opening claim so the arc stays legible.
        const summary = String(data.text).replace(/\s+/g, ' ').trim().slice(0, olderChars);
        xml += `      ${escapeXml(summary)}${data.text.length > olderChars ? '…[earlier round, condensed]' : ''}\n`;
      }
      xml += `    </agent>\n`;
    });
    xml += `  </round>\n`;
  });
  xml += '</atagh_fekr_conversation>';
  return xml;
}

/* ── Synthesis ──
 * Produces a self-contained summary: panel scores per round, trajectory,
 * final consensus built from the highest-rated last-round contribution,
 * and dissent notes when agents disagree materially in the final round.
 */
export function synthesizeConsensus(debate) {
  if (!debate.rounds.length) {
    const dead = Object.entries(debate.agents || {})
      .filter(([, a]) => a.status !== 'done')
      .map(([name, a]) => `${name} (${STATUS_PHRASES[a.status] || a.status})`);
    return dead.length
      ? `No responses received. Unavailable agents: ${dead.join(', ')}.`
      : 'No responses received.';
  }

  const lastRound = debate.rounds[debate.rounds.length - 1];
  const responses = Object.entries(lastRound.responses || {});
  if (!responses.length) return 'No responses in final round.';

  responses.sort((a, b) => b[1].score - a[1].score);
  const highest = responses[0];

  const lines = [];
  lines.push('## AI Consensus Synthesis');
  lines.push('');
  lines.push(`Panel: ${Object.keys(lastRound.responses).length} agent(s), ${debate.rounds.length} round(s) of critique.`);
  lines.push('');

  // Per-round scoreboard
  lines.push('### Scores by round');
  debate.rounds.forEach(r => {
    const row = Object.entries(r.responses || {})
      .sort((a, b) => b[1].score - a[1].score)
      .map(([agent, d]) => `${agent}: ${d.score}/10`)
      .join(' | ');
    lines.push(`- Round ${r.round}: ${row}`);
  });
  lines.push('');

  // Trajectory: which agent improved most between first and final round
  if (debate.rounds.length > 1) {
    const firstRound = debate.rounds[0].responses || {};
    let mover = null;
    Object.keys(lastRound.responses).forEach(agent => {
      if (!firstRound[agent]) return;
      const delta = lastRound.responses[agent].score - firstRound[agent].score;
      if (!mover || delta > mover.delta) mover = { agent, delta };
    });
    if (mover && mover.delta > 0) {
      lines.push(`Strongest improvement: **${mover.agent}** (+${mover.delta} points from round 1 to round ${debate.rounds.length}).`);
      lines.push('');
    }
  }

  // Dissent: meaningful spread in the final round
  const spread = highest[1].score - responses[responses.length - 1][1].score;
  const hasDissent = spread >= 3;

  lines.push(`### Highest-Rated Final Contribution (${highest[0]}: ${highest[1].score}/10)`);
  lines.push('');
  lines.push(truncateForPrompt(highest[1].text, 2500));
  lines.push('');

  // Blind-judge ranking (independent model, anonymized arguments) — the only
  // score in the report that isn't self-reported.
  if (debate.judge && Array.isArray(debate.judge.verdict) && debate.judge.verdict.length) {
    lines.push(`### Blind Judgement (by ${debate.judge.judge})`);
    lines.push('');
    debate.judge.verdict.forEach((v, i) => {
      lines.push(`${i + 1}. **${v.agent}** — ${v.score}/10${v.oneLine ? ` — ${v.oneLine}` : ''}`);
    });
    lines.push('');
  }

  if (debate.stoppedReason) {
    lines.push(`> Debate ended early: ${debate.stoppedReason}`);
    lines.push('');
  }

  if (debate.adversary) {
    lines.push(`> Final round included a devil's-advocate brief (held by **${debate.adversary}**) — treat the majority position as stress-tested.`);
    lines.push('');
  }

  lines.push('### Synthesis');
  lines.push('');

  const finalRespondents = responses.length;
  if (finalRespondents < 2) {
    // One voice is an answer, not a consensus — never claim agreement that
    // was never tested against another agent.
    lines.push(
      `This is ${highest[0]}'s answer alone — no other agent responded, so there is no ` +
      'consensus to report. Open more AI tabs (or enable an API agent) and run again for a ' +
      'cross-checked result.'
    );
  } else {
    lines.push(
      `The panel's consensus is anchored on ${highest[0]}'s final-round argument` +
      `, incorporating ${debate.rounds.length - 1} round(s) of cross-critique across the panel.` +
      (hasDissent
        ? ` Note: material dissent remains — final-round scores span ${spread} points, so treat minority positions as open questions rather than settled.`
        : ' Final-round agreement is strong (scores within a few points).')
    );
  }

  return lines.join('\n');
}

export function isRoundBarrierMet(agentStates, activeNames) {
  return activeNames.every(name => {
    const a = agentStates[name];
    return a && (a.completed || a.timedOut);
  });
}

/* ── Devil's Advocate selection ──
 * Picks which agent argues AGAINST the emerging consensus in the final
 * round. The lowest previous-round scorer is ideal: they lost round one,
 * so assigning them the contrarian brief turns a rubber-stamp round into a
 * genuine stress test of the majority position.
 */
export function pickAdversary(rounds, agentList) {
  if (!Array.isArray(rounds) || !rounds.length) return null;
  const last = rounds[rounds.length - 1];
  let worst = null;
  let worstScore = Infinity;
  for (const name of agentList || Object.keys(last.responses || {})) {
    const resp = (last.responses || {})[name];
    if (!resp || typeof resp.text !== 'string' || !resp.text.trim()) continue;
    const sc = Number(resp.score);
    if (!Number.isFinite(sc)) continue;
    if (sc < worstScore) {
      worstScore = sc;
      worst = name;
    }
  }
  // All-tied scores would leave `worst` as the first valid entrant — fine:
  // any panelist can play devil's advocate.
  return worst;
}

/** Build the contrarian prompt for the chosen adversary. */
export function buildDevilsAdvocatePrompt(basePrompt, conversationXml) {
  return `${basePrompt}\n\nReview the previous arguments:\n${conversationXml}\n\n` +
    'You are now playing DEVIL\'S ADVOCATE. Argue as strongly as you can AGAINST the emerging ' +
    'majority position: find its weakest assumptions, strongest counter-evidence, and failure modes. ' +
    'Do not merely restate your earlier argument — attack theirs. End with your updated score in the ' +
    'format [Score: X/10] scoring how well the MAJORITY position survived your attack.';
}
