/* ── Gemini Content Script ──
 * Site config only — all behavior lives in ../lib/agent_core.js.
 * Selector arrays are fallbacks tried in order (see selectors.json).
 */
(function () {
  'use strict';

  const SITE = {
    input: [
      "div.ql-editor[role='textbox']",
      "rich-textarea div[contenteditable='true']",
      "div[role='textbox']"
    ],
    submit: [
      "button[aria-label='Send message']",
      "button.send-button",
      "button[mattooltip*='Send' i]",
      "button.submit"
    ],
    output: [
      "model-response .markdown",
      "message-content .markdown",
      "div.message-content",
      "model-response"
    ],
    // Gemini keeps the progress bar mounted after completion; only treat it
    // as "generating" while it is actually visible.
    wait_selector_visible: true,
    wait_selector: ["mat-progress-bar"],
    error_patterns: [
      "an error occurred",
      "something went wrong",
      "couldn't generate",
      "not available for this account"
    ],
    rate_limit_patterns: [
      "reached the limit",
      "quota exceeded",
      "rate limit",
      "try again later"
    ]
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) =>
    window.HiveAgentCore.handleMessage(msg, SITE, sendResponse)
  );
})();
