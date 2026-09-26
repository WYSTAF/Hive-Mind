/* ── ChatGPT Content Script ──
 * Site config only — all behavior lives in ../lib/agent_core.js.
 * Selector arrays are fallbacks tried in order (see selectors.json).
 */
(function () {
  'use strict';

  const SITE = {
    input: [
      "div[id='prompt-textarea']",
      "form div[contenteditable='true']",
      "#prompt-textarea"
    ],
    submit: [
      "button[data-testid='send-button']",
      "button[aria-label='Send prompt']",
      "form button[type='submit']",
      "button[id='composer-submit-button']"
    ],
    output: [
      "div[data-message-author-role='assistant'] .markdown",
      "div[data-message-author-role='assistant']"
    ],
    wait_selector: [
      "button[data-testid='stop-button']",
      "button[aria-label='Stop streaming']"
    ],
    error_patterns: [
      "something went wrong",
      "unable to load conversation",
      "an error occurred",
      "you've reached our limit",
      "please try again"
    ],
    rate_limit_patterns: [
      "you've reached (?:our|the) limit",
      "rate limit",
      "too many requests",
      "usage limit",
      "try again in \\d+ hours?"
    ]
  };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) =>
    window.HiveAgentCore.handleMessage(msg, SITE, sendResponse)
  );
})();
