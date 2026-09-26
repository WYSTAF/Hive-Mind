/* ── Convergence detection ──
 * Pure logic for deciding whether a debate panel has stopped producing new
 * ideas — the "Smart Stop" feature. Compares each agent's latest answer to
 * its own previous round (are they just repeating themselves?) and to the
 * rest of the panel (is everyone echoing everyone?).
 *
 * No DOM / extension APIs — unit-testable.
 */

/** Lowercase, collapse whitespace, strip punctuation → word list. */
export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Word-trigram shingles of the text. Fewer than 3 words → whole text as one
 * shingle so short answers still compare meaningfully.
 */
export function shingles(text) {
  const words = tokenize(text);
  if (words.length < 3) {
    return words.length ? new Set([words.join(' ')]) : new Set();
  }
  const out = new Set();
  for (let i = 0; i <= words.length - 3; i++) {
    out.add(words.slice(i, i + 3).join(' '));
  }
  return out;
}

export function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const s of setA) if (setB.has(s)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function lastRoundTexts(rounds) {
  if (!rounds.length) return {};
  const out = {};
  Object.entries(rounds[rounds.length - 1].responses || {}).forEach(([a, d]) => {
    if (d.text) out[a] = d.text;
  });
  return out;
}

function prevRoundTexts(rounds) {
  if (rounds.length < 2) return {};
  const out = {};
  Object.entries(rounds[rounds.length - 2].responses || {}).forEach(([a, d]) => {
    if (d.text) out[a] = d.text;
  });
  return out;
}

/**
 * Decide whether the panel has converged.
 * @returns {{converged: boolean, reason: string|null, metrics: object}}
 */
export function detectConvergence(rounds, opts = {}) {
  const minRounds = opts.minRounds ?? 2;      // never stop before round 2 closes
  const selfSimThreshold = opts.selfSimThreshold ?? 0.6;
  const panelSimThreshold = opts.panelSimThreshold ?? 0.55;
  const scoreTightness = opts.scoreTightness ?? 1.5;

  const metrics = { panelAvg: null, scoreSpread: null, selfSims: {}, panelSims: {} };

  if (!Array.isArray(rounds) || rounds.length < minRounds) {
    return { converged: false, reason: `fewer than ${minRounds} rounds completed`, metrics };
  }

  const latest = lastRoundTexts(rounds);
  const previous = prevRoundTexts(rounds);
  const names = Object.keys(latest);
  if (names.length < 2) {
    return { converged: false, reason: 'fewer than two respondents in latest round', metrics };
  }

  // Self-similarity: is each agent repeating its previous argument?
  let selfCount = 0;
  let selfTotal = 0;
  names.forEach(a => {
    if (previous[a]) {
      const sim = jaccard(shingles(previous[a]), shingles(latest[a]));
      metrics.selfSims[a] = Math.round(sim * 100) / 100;
      selfTotal++;
      if (sim >= selfSimThreshold) selfCount++;
    }
  });

  // Panel cross-similarity: mean pairwise Jaccard between agents.
  let pairSum = 0;
  let pairCount = 0;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const sim = jaccard(shingles(latest[names[i]]), shingles(latest[names[j]]));
      metrics.panelSims[`${names[i]}~${names[j]}`] = Math.round(sim * 100) / 100;
      pairSum += sim;
      pairCount++;
    }
  }
  const panelAvgSim = pairCount ? pairSum / pairCount : 0;
  metrics.panelAvgSim = Math.round(panelAvgSim * 100) / 100;

  // Score tightness in the final round.
  const scores = [];
  if (rounds.length) {
    Object.values(rounds[rounds.length - 1].responses || {}).forEach(d => scores.push(d.score || 0));
  }
  if (scores.length) {
    const avg = scores.reduce((x, y) => x + y, 0) / scores.length;
    metrics.panelAvg = Math.round(avg * 10) / 10;
    metrics.scoreSpread = Math.round(Math.max(...scores) - Math.min(...scores));
  }

  // Decision rules — any one suffices.
  if (selfTotal > 0 && selfCount === selfTotal && selfTotal >= 2) {
    return {
      converged: true,
      reason: `every panelist repeated ≥${Math.round(selfSimThreshold * 100)}% of its previous argument`,
      metrics
    };
  }
  if (panelAvgSim >= panelSimThreshold && metrics.scoreSpread !== null && metrics.scoreSpread <= scoreTightness + 1) {
    return {
      converged: true,
      reason: `panel echo level ${metrics.panelAvgSim} with score spread ${metrics.scoreSpread}`,
      metrics
    };
  }
  return { converged: false, reason: 'panel still divergent', metrics };
}
