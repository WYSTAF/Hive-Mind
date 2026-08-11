/* ── Selectors validation ── */

export function isValidSelectors(data) {
  if (!data || typeof data !== 'object') return false;
  const agents = ['chatgpt', 'claude', 'gemini'];
  const required = ['input', 'submit', 'output', 'wait_selector', 'observer_target'];
  for (const agent of agents) {
    const block = data[agent];
    if (!block || typeof block !== 'object') return false;
    for (const key of required) {
      if (typeof block[key] !== 'string' || !block[key].trim()) return false;
    }
  }
  return true;
}