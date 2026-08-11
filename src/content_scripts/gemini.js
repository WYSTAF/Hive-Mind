/* ── Gemini Content Script ── */

let lastResponse = '';
let isGenerating = false;
let observer = null;

function getElement(sel) {
  return document.querySelector(sel);
}

function getAllElements(sel) {
  return Array.from(document.querySelectorAll(sel));
}

function setInput(text, sel) {
  const el = getElement(sel);
  if (!el) return false;
  el.focus();
  document.execCommand('insertText', false, text);
  return true;
}

function clickSubmit(sel) {
  const btn = getElement(sel);
  if (btn) {
    btn.click();
    return true;
  }
  return false;
}

function getLatestResponse(sel) {
  const els = getAllElements(sel);
  if (!els.length) return '';
  return els[els.length - 1].innerText || '';
}

function isStillGenerating(waitSel) {
  return !!getElement(waitSel);
}

function setupObserver(targetSel, outputSel, waitSel) {
  if (observer) observer.disconnect();
  const target = getElement(targetSel) || document.body;
  observer = new MutationObserver(() => {
    const text = getLatestResponse(outputSel);
    if (text && text !== lastResponse) {
      lastResponse = text;
    }
    isGenerating = isStillGenerating(waitSel);
  });
  observer.observe(target, { childList: true, subtree: true });
}

/* ── Message listener ── */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case 'inject_prompt': {
      const s = msg.selectors || {};
      const inputSel = s.input || "div[role='textbox']";
      const submitSel = s.submit || "button[aria-label='Send message']";
      const outputSel = s.output || "div.message-content";
      const waitSel = s.wait_selector || "mat-progress-bar";
      const observerTarget = s.observer_target || "div[class*='response-container']";

      const ok = setInput(msg.prompt, inputSel);
      if (!ok) {
        sendResponse({ status: 'error', text: 'Input field not found' });
        return true;
      }

      setTimeout(() => {
        clickSubmit(submitSel);
        isGenerating = true;
        lastResponse = '';
        setupObserver(observerTarget, outputSel, waitSel);
      }, 300);

      sendResponse({ status: 'thinking' });
      return true;
    }

    case 'poll_response': {
      const s = msg.selectors || {};
      const outputSel = s.output || "div.message-content";
      const waitSel = s.wait_selector || "mat-progress-bar";

      const text = getLatestResponse(outputSel);
      const generating = isStillGenerating(waitSel);

      if (!generating && text) {
        sendResponse({ status: 'done', text });
      } else if (generating) {
        sendResponse({ status: 'thinking', text: lastResponse });
      } else {
        sendResponse({ status: 'thinking' });
      }
      return true;
    }

    default:
      sendResponse({ status: 'unknown' });
      return true;
  }
});
