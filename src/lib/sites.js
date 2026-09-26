/* ── Site registry ──
 * Every automatable AI web app is a data entry here, not a code change.
 * Adding a site = adding an entry (+ a match-pattern in its `origins`).
 *
 * Fields:
 *   id            stable key used in URLs/state/storage
 *   label         display name
 *   color         chart/card color
 *   origins       match patterns for dynamic content-script registration
 *   urlTests      substrings identifying this app's chat URLs
 *   input/submit/output/wait_selector  selector fallbacks (v2 schema)
 *   error_patterns / rate_limit_patterns  regex copy to detect failures
 *   visibility    'always' (instantiate on install) | 'lazy' (only after
 *                 the user enables it — for less-common sites so we don't
 *                 request script access everywhere by default)
 */

export const BUILTIN_SITES = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    color: '#10a37f',
    visibility: 'always',
    origins: ['https://chatgpt.com/*'],
    urlTests: ['chatgpt.com'],
    input: ["div[id='prompt-textarea']", "form div[contenteditable='true']", "#prompt-textarea"],
    submit: ["button[data-testid='send-button']", "button[aria-label='Send prompt']", "form button[type='submit']", "button[id='composer-submit-button']"],
    output: ["div[data-message-author-role='assistant'] .markdown", "div[data-message-author-role='assistant']"],
    wait_selector: ["button[data-testid='stop-button']", "button[aria-label='Stop streaming']"],
    error_patterns: ["something went wrong", "unable to load conversation", "an error occurred", "please try again"],
    rate_limit_patterns: ["you've reached (?:our|the) limit", "rate limit", "too many requests", "usage limit", "try again in \\d+ hours?"]
  },
  {
    id: 'claude',
    label: 'Claude',
    color: '#d97706',
    visibility: 'always',
    origins: ['https://claude.ai/*', 'https://*.claude.ai/*'],
    urlTests: ['claude.ai'],
    input: ["div[contenteditable='true'].ProseMirror", "div[contenteditable='true']"],
    submit: ["button[aria-label='Send Message']", "button[aria-label='Send message']", "button[data-testid='send-button']", "button[type='submit']"],
    output: ["div.font-claude-message", "div[data-testid='assistant-message']", "div[data-is-streaming] .font-claude-message"],
    wait_selector: ["div.is-generating", "button[aria-label='Stop Response']", "button[aria-label='Interrupt']"],
    error_patterns: ["unexpected error", "something went wrong", "internal server error", "message flagged", "try again"],
    rate_limit_patterns: ["message limit reached", "usage limit", "rate limit", "try again soon", "conversation too long"]
  },
  {
    id: 'gemini',
    label: 'Gemini',
    color: '#4285f4',
    visibility: 'always',
    origins: ['https://gemini.google.com/*'],
    urlTests: ['gemini.google.com'],
    input: ["div.ql-editor[role='textbox']", "rich-textarea div[contenteditable='true']", "div[role='textbox']"],
    submit: ["button[aria-label='Send message']", "button.send-button", "button[mattooltip*='send' i]", "button.submit"],
    output: ["model-response .markdown", "message-content .markdown", "div.message-content", "model-response"],
    wait_selector: ["mat-progress-bar"],
    wait_selector_visible: true,
    error_patterns: ["an error occurred", "something went wrong", "couldn't generate", "not available for this account"],
    rate_limit_patterns: ["reached the limit", "quota exceeded", "rate limit", "try again later"]
  },
  {
    id: 'grok',
    label: 'Grok',
    color: '#8b5cf6',
    visibility: 'lazy',
    origins: ['https://grok.com/*', 'https://x.com/*', 'https://twitter.com/*'],
    urlTests: ['grok.com', 'grok.x.ai'],
    input: ["div[contenteditable='true'][role='textbox']", "textarea[data-testid='grok-input']", "div.ProseMirror[contenteditable='true']"],
    submit: ["button[aria-label='Send']", "button[data-testid='send-button']", "form button[type='submit']"],
    output: ["div[data-testid='grok-message'] .prose", "div[data-message-author-role='assistant']", "div.prose"],
    wait_selector: ["button[aria-label='Stop generating']", "button[data-testid='stop-generating']"],
    error_patterns: ["something went wrong", "an error occurred", "try again later"],
    rate_limit_patterns: ["rate limit", "too many requests", "try again later"]
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    color: '#4d6bfe',
    visibility: 'lazy',
    origins: ['https://chat.deepseek.com/*'],
    urlTests: ['chat.deepseek.com', 'deepseek.com'],
    input: ["textarea#dummy-input", "div[contenteditable='true']"],
    submit: ["button[aria-label='Send']", "div[aria-label='Send']", "button.send-btn"],
    output: ["div.markdown-body", "div.ds-markdown--block", "div[class*='message--'] .markdown"],
    wait_selector: ["div[aria-label='Stop generating']", "span.loader"],
    error_patterns: ["an error occurred", "something went wrong", "server busy"],
    rate_limit_patterns: ["rate limit", "too many requests", "request failed"]
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    color: '#20808d',
    visibility: 'lazy',
    origins: ['https://www.perplexity.ai/*'],
    urlTests: ['perplexity.ai'],
    input: ["div[contenteditable='true'][data-placeholder]", "textarea[placeholder*='ask' i]"],
    submit: ["button[aria-label='Submit']", "button[data-testid='submit-button']"],
    output: ["div[id^='markdown'] .prose", "div.prose"],
    wait_selector: ["button[aria-label='Stop generating']", "span[data-testid='stop-button']"],
    error_patterns: ["something went wrong", "an error occurred"],
    rate_limit_patterns: ["rate limit", "too many requests"]
  },
  {
    id: 'copilot',
    label: 'Copilot',
    color: '#0b6bcb',
    visibility: 'lazy',
    origins: ['https://copilot.microsoft.com/*'],
    urlTests: ['copilot.microsoft.com'],
    input: ["#userInput", "textarea#userInput", "div[contenteditable='true']"],
    submit: ["button[data-testid='submit-button']", "#submit", "button[aria-label='Send']"],
    output: ["div[data-message-author-role='assistant']", "div.chat-turn-content"],
    wait_selector: ["button[data-testid='stop-generating-button']", "span[data-testid='thinking-indicator']"],
    error_patterns: ["something went wrong", "an error occurred"],
    rate_limit_patterns: ["rate limit", "too many requests"]
  },
  {
    id: 'mistral',
    label: 'Mistral',
    color: '#fa520f',
    visibility: 'lazy',
    origins: ['https://chat.mistral.ai/*'],
    urlTests: ['chat.mistral.ai'],
    input: ["textarea[data-testid='input-field']", "div[contenteditable='true']"],
    submit: ["button[data-testid='send-button']", "button[aria-label='Send message']"],
    output: ["div[data-message-author-role='assistant']", "div.prose"],
    wait_selector: ["button[data-testid='stop-button']", "span.animate-spin"],
    error_patterns: ["something went wrong", "an error occurred"],
    rate_limit_patterns: ["rate limit", "too many requests"]
  }
];

/** Sites enabled by default (lazy sites opt in via the popup). */
export function isSiteEnabled(site, enabledSet) {
  if (site.visibility === 'always') return true;
  return enabledSet ? enabledSet.includes(site.id) : false;
}

/** User-added sites live in storage; merge with builtins (user wins on id). */
export function mergeSites(builtin, userSites) {
  if (!Array.isArray(userSites) || !userSites.length) return builtin.slice();
  const byId = new Map(builtin.map(s => [s.id, s]));
  for (const s of userSites) {
    if (!s || !s.id || !Array.isArray(s.origins) || !s.origins.length) continue;
    byId.set(s.id, s);
  }
  return Array.from(byId.values());
}

/** Which site does this tab URL belong to? Longest urlTests match wins. */
export function siteForUrl(url, sites) {
  if (!url) return null;
  let best = null;
  let bestLen = 0;
  for (const s of sites) {
    for (const test of (s.urlTests || [])) {
      if (url.includes(test) && test.length > bestLen) {
        best = s;
        bestLen = test.length;
      }
    }
  }
  return best;
}

/**
 * Resolve a site from a page's exact origin (used by the dynamic site
 * bridge). More precise than siteForUrl's substring scan: matches the host
 * exactly, and also honours alias hosts declared in a site's `origins`
 * (e.g. Grok served from x.com). Returns null when unknown.
 */
export function siteForOrigin(origin, sites) {
  if (!origin) return null;
  let host;
  try {
    host = new URL(origin).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  const hostOf = p => {
    try { return new URL(p).hostname.replace(/^www\./, ''); } catch { return null; }
  };
  return sites.find(s => {
    const tests = s.urlTests || [];
    if (tests.some(t => host === t || host.endsWith(`.${t}`))) return true;
    return (s.origins || []).some(o => hostOf(o) === host);
  }) || null;
}

/** Selector config block for a site (what content scripts receive). */
export function selectorsForSite(site) {
  return {
    input: site.input,
    submit: site.submit,
    output: site.output,
    wait_selector: site.wait_selector,
    wait_selector_visible: !!site.wait_selector_visible,
    error_patterns: site.error_patterns || [],
    rate_limit_patterns: site.rate_limit_patterns || []
  };
}
