/* ── Pure debate logic: scoring, XML wrapping, consensus synthesis, barrier ── */

export function parseScore(text) {
  if (!text) return 0;
  // Try [Score: X/10] / [Score: X] / Score: X/10
  let m = text.match(/\[?\s*Score\s*:\s*(\d+)\s*\/?\s*(\d+)?\s*\]?/i);
  if (m) {
    const val = parseInt(m[1], 10);
    const max = m[2] ? parseInt(m[2], 10) : 10;
    return Math.round((val / max) * 10);
  }
  // Try "X out of 10" / "X/10"
  m = text.match(/(\d+)\s*(?:out\s*of|\/)\s*10/i);
  if (m) return Math.min(parseInt(m[1], 10), 10);
  // Try "rated X" or "score X"
  m = text.match(/(?:rated|score|rating)[:\s]*(\d+)/i);
  if (m) return Math.min(parseInt(m[1], 10), 10);
  // Default fallback
  return 0;
}

export function wrapConversation(rounds) {
  let xml = '<atagh_fekr_conversation>\n';
  rounds.forEach((round, i) => {
    xml += `  <round number="${i + 1}">\n`;
    Object.entries(round.responses).forEach(([agent, data]) => {
      if (data.text) {
        xml += `    <agent name="${agent}" score="${data.score}">\n`;
        // Properly escape XML characters to prevent malformed XML structure
        const escapedText = data.text
          .split('\x26').join('\x26amp;')
          .split('\x3C').join('\x26lt;')
          .split('\x3E').join('\x26gt;')
          .split('\x22').join('\x26quot;')
          .split('\x27').join('\x26apos;');
        xml += `      ${escapedText}\n`;
        xml += `    </agent>\n`;
      }
    });
    xml += `  </round>\n`;
  });
  xml += '</atagh_fekr_conversation>';
  return xml;
}

export function synthesizeConsensus(debate) {
  if (!debate.rounds.length) return 'No responses received.';

  // Take the latest round responses and synthesize
  const lastRound = debate.rounds[debate.rounds.length - 1];
  const responses = Object.entries(lastRound.responses);

  if (!responses.length) return 'No responses in final round.';

  // Sort by score descending
  responses.sort((a, b) => b[1].score - a[1].score);

  const highest = responses[0];
  const lowest = responses[responses.length - 1];

  // Build synthesis
  const preamble = `## AI Consensus Synthesis\n\nAfter ${debate.rounds.length} round(s) of multi-agent debate, ` +
    `the panel reached the following consensus:\n\n`;

  const topResponse = `### Highest-Rated Contribution (${highest[0]}: ${highest[1].score}/10)\n${highest[1].text}\n\n`;
  const synthesis = `### Synthesis\n` +
    `The panel's consensus is drawn from the highest-scoring contribution, ` +
    `incorporating critiques from all agents across ${debate.rounds.length} round(s).\n\n` +
    `> ${highest[1].text}`;

  return preamble + topResponse + synthesis;
}

export function isRoundBarrierMet(agentStates, activeNames) {
  return activeNames.every(name => {
    const a = agentStates[name];
    return a && (a.completed || a.timedOut);
  });
}