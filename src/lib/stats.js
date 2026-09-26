/* ── Panel statistics ──
 * Aggregates debate history into per-agent reliability numbers. Pure logic,
 * unit-testable. History entries are the objects persisted by background.js:
 * { rounds:[{round, responses:{agent:{text,score}}}], agents:{name:{status,score}}, ... }
 */

/**
 * @param {Array} history persisted debates (oldest last is irrelevant; order-safe)
 * @returns {{
 *   totalDebates, judgedDebates,
 *   perAgent: { [agent]: {
 *     appearances, responses, timeouts, rateLimits, errors,
 *     avgSelfScore (null when no scores), wins, winRate (0..1 or null)
 *   }},
 *   mostWins: string|null
 * }}
 */
export function computeStats(history) {
  const perAgent = {};
  const ensure = name => {
    if (!perAgent[name]) {
      perAgent[name] = {
        appearances: 0, responses: 0, timeouts: 0, rateLimits: 0, errors: 0,
        scoreSum: 0, scoreCount: 0, wins: 0
      };
    }
    return perAgent[name];
  };

  let judged = 0;

  for (const d of (history || [])) {
    const participated = new Set();

    // Responses from round data (authoritative for text+score).
    const finalScores = {};
    for (const r of (d.rounds || [])) {
      Object.entries(r.responses || {}).forEach(([a, resp]) => {
        const st = ensure(a);
        participated.add(a);
        if (resp.text) {
          // Count a response once per debate, not once per round.
          if (!finalScores[a]) st.responses++;
          const sc = Number(resp.score) || 0;
          st.scoreSum += sc;
          st.scoreCount++;
          finalScores[a] = sc;
        }
      });
    }

    // Appearances + failure counts from the agent snapshot.
    Object.entries(d.agents || {}).forEach(([a, info]) => {
      const st = ensure(a);
      participated.add(a);
      switch (info.status) {
        case 'timeout': st.timeouts++; break;
        case 'rate-limited': st.rateLimits++; break;
        case 'error': st.errors++; break;
        default: break;
      }
    });

    participated.forEach(a => { ensure(a).appearances++; });

    // Win = highest blind-judge score when present, else highest final self-score.
    if (d.judge && Array.isArray(d.judge.verdict) && d.judge.verdict.length) {
      judged++;
      const best = d.judge.verdict[0];
      if (best && best.agent) ensure(best.agent).wins++;
    } else {
      const lastRound = (d.rounds || [])[((d.rounds || []).length || 1) - 1];
      if (lastRound) {
        let winner = null;
        let bestScore = -1;
        Object.entries(lastRound.responses || {}).forEach(([a, resp]) => {
          const sc = Number(resp.score) || 0;
          if (sc > bestScore) { bestScore = sc; winner = a; }
        });
        if (winner) ensure(winner).wins++;
      }
    }
  }

  let mostWins = null;
  Object.entries(perAgent).forEach(([a, s]) => {
    s.avgSelfScore = s.scoreCount ? Math.round((s.scoreSum / s.scoreCount) * 10) / 10 : null;
    s.winRate = s.appearances ? Math.round((s.wins / s.appearances) * 100) / 100 : null;
    delete s.scoreSum;   // internal accumulators — don't leak into UI data
    delete s.scoreCount;
    if (s.wins > ((mostWins && perAgent[mostWins].wins) || 0)) mostWins = a;
  });

  return {
    totalDebates: (history || []).length,
    judgedDebates: judged,
    perAgent,
    mostWins
  };
}
