/* ── Claude Content Script ──
 * Site config only — all behavior lives in ../lib/agent_core.js.
 * Selector arrays are fallbacks tried in order (see selectors.json).
 */
(function () {
  'use strict';

  const SITE = {
    input: [
      "div[contenteditable='true'].ProseMirror",
      "div[contenteditable='true']"
    ],
    submit: [
      "button[aria-label='Send Message']",
      "button[aria-label='Send message']",
      "button[data-testid='send-button']",
      "button[type='submit']"
    ],
    output: [
      "div.font-claude-message",
      "div[data-testid='assistant-message']",
      "div[data-is-streaming] .font-claude-message"
    ],
    wait_selector: [
      "div.is-generating",
      "button[aria-label='Stop Response']",
      "button[aria-label='Interrupt']"
    ],
    error_patterns: [
      "unexpected error",
      "something went wrong",
      "internal server error",
      "message flagged",
      "try again"
    ],
    rate_limit_patterns: [
      "message limit reached",
      "usage limit",
      "rate limit",
      "try again soon",
      "conversation too long"
    ]
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) =>
    window.HiveAgentCore.handleMessage(msg, SITE, sendResponse)
  );
})();
