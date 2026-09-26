/* ── Dynamic site bridge ──
 * Injected by chrome.scripting for lazily-enabled / user-added sites.
 * Manifest-declared sites use the per-site config scripts instead; this one
 * resolves its own config by asking the service worker, falling back to a
 * permissive generic config so a brand-new site still has a chance.
 *
 * Loaded AFTER agent_core.js. Classic script, not a module.
 */
(function () {
  'use strict';

  let siteConfigPromise = null;
  let fallbackConfig = null;

  // Generic config used until (or instead of) a site-specific block arrives.
  const GENERIC = {
    input: [
      "div[contenteditable='true'][role='textbox']",
      "div[contenteditable='true']",
      "textarea"
    ],
    submit: [
      "button[aria-label='Send message']",
      "button[aria-label='Send']",
      "button[type='submit']",
      "form button"
    ],
    output: [
      "div[data-message-author-role='assistant']",
      "div[role='article']",
      "div[class*='markdown']",
      "div[class*='prose']"
    ],
    wait_selector: [
      "button[aria-label='Stop']",
      "button[aria-label='Stop generating']",
      "button[aria-label='Stop streaming']"
    ],
    wait_selector_visible: true,
    error_patterns: ["something went wrong", "an error occurred", "try again"],
    rate_limit_patterns: ["rate limit", "too many requests"]
  };

  function siteHint() {
    // Hostname prefix is only a *hint* — registry ids don't always match
    // (chat.deepseek.com → "chat", x.com → "x"). The service worker
    // resolves the real site by matching this page's origin.
    const host = location.hostname.replace(/^www\./, '');
    return host.split('.')[0];
  }

  function loadConfig() {
    if (siteConfigPromise) return siteConfigPromise;
    fallbackConfig = Object.assign({}, GENERIC);
    siteConfigPromise = new Promise(resolve => {
      let settled = false;
      const done = cfg => { if (!settled) { settled = true; resolve(cfg || fallbackConfig); } };
      try {
        chrome.runtime.sendMessage({
          action: 'get_site_selectors',
          site: siteHint(),
          origin: location.origin
        }, res => {
          if (chrome.runtime.lastError) return done(fallbackConfig);
          done(res && res.selectors ? res.selectors : fallbackConfig);
        });
      } catch { done(fallbackConfig); }
      // Never block a debate on config fetch — 1.5s cap, then generic.
      setTimeout(() => done(fallbackConfig), 1500);
    });
    return siteConfigPromise;
  }

  // The core engine is synchronous, so resolve config before the first
  // message can arrive, and keep a memoized resolved block.
  let resolved = null;
  function config() {
    if (resolved) return resolved;
    resolved = Object.assign({}, GENERIC);
    loadConfig().then(cfg => { resolved = Object.assign({}, GENERIC, cfg || {}); });
    return resolved;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.action) {
      case 'inject_prompt':
      case 'poll_response':
      case 'diagnose':
      case 'cancel': {
        loadConfig().then(cfg => {
          window.HiveAgentCore.handleMessage(msg, cfg, sendResponse);
        });
        return true; // async: we respond after the config resolves
      }
      default:
        return false;
    }
  });
})();
