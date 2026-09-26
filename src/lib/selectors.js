/* ── Selectors validation ──
 * Validates the selectors.json schema (v1 strings and v2 arrays + failure
 * patterns). Used by the background worker to decide between bundled and
 * remotely fetched selector sets.
 */

const AGENTS = ['chatgpt', 'claude', 'gemini'];
const REQUIRED_KEYS = ['input', 'submit', 'output', 'wait_selector'];

function isValidSelectorEntry(value) {
  // v2: array of fallbacks, or v1: single string — both accepted.
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(v => typeof v === 'string' && v.trim().length > 0);
  }
  return false;
}

function areValidPatterns(value) {
  if (value === undefined) return true; // optional key
  if (!Array.isArray(value)) return false;
  if (value.some(v => typeof v !== 'string')) return false;
  // Every pattern must compile as a regex — a broken pattern would throw at
  // match time inside the content script, so reject it here instead.
  for (const p of value) {
    try { new RegExp(p, 'i'); } catch { return false; }
  }
  return true;
}

export function isValidSelectors(data) {
  if (!data || typeof data !== 'object') return false;
  for (const agent of AGENTS) {
    const block = data[agent];
    if (!block || typeof block !== 'object') return false;
    for (const key of REQUIRED_KEYS) {
      if (!isValidSelectorEntry(block[key])) return false;
    }
    if (!areValidPatterns(block.error_patterns)) return false;
    if (!areValidPatterns(block.rate_limit_patterns)) return false;
  }
  return true;
}
