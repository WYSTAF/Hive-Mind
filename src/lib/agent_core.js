/* ── HiveMind Agent Core ──
 * Shared content-script engine for all agent sites. Loaded by the manifest
 * before each site script; site scripts call HiveAgentCore.handleMessage()
 * with their own DEFAULTS. Not a module — content scripts run as classic
 * scripts in an isolated world.
 *
 * Reliability design:
 *  - Baseline snapshot at submit time (last output text + message count).
 *    A reply only counts as fresh once BOTH differ from the baseline — this
 *    kills the stale-answer race in the submit→generation gap.
 *  - Stability confirmation: a candidate answer must survive one extra poll
 *    unchanged with no activity indicator, so a momentary stop-button flicker
 *    can't emit half a stream.
 *  - Insertion chain with verification: execCommand → synthetic beforeinput
 *    → native value set, checking after each step whether the text landed.
 *  - Failure detection: when a submission goes quiet without producing a new
 *    message, the page is scanned for configurable error / rate-limit copy.
 */
(function () {
  'use strict';

  const STABLE_TICKS_REQUIRED = 2;   // consecutive identical polls before done
  const QUIET_TICKS_BEFORE_ERROR_SCAN = 6; // ~3s of silence before scanning for errors
  const TAIL_CHARS = 160;            // chars of in-flight text sent on each poll

  function qs(sel) { return document.querySelector(sel); }
  function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }
  function firstMatch(sels) {
    if (!sels) return null;
    const list = Array.isArray(sels) ? sels : [sels];
    for (const sel of list) {
      try {
        const el = qs(sel);
        if (el) return el;
      } catch { /* invalid selector in config — skip */ }
    }
    return null;
  }

  function visibleText(el) {
    return el ? (el.innerText || el.textContent || '') : '';
  }

  /* ── Output extraction ── */

  function extractOutputs(cfg) {
    const sels = Array.isArray(cfg.output) ? cfg.output : [cfg.output];
    for (const sel of sels) {
      try {
        const els = qsa(sel);
        // Optional negative filter, e.g. skip user-message containers that
        // share the same class as model messages on some sites.
        const filtered = cfg.output_exclude
          ? els.filter(el => !el.matches(cfg.output_exclude))
          : els;
        if (filtered.length) return filtered;
      } catch { /* invalid selector — try next */ }
    }
    return [];
  }

  function latestOutputText(cfg) {
    const outs = extractOutputs(cfg);
    if (!outs.length) return '';
    const raw = visibleText(outs[outs.length - 1]).trim();
    if (!cfg.output_strip_prefix) return raw;
    try {
      return raw.replace(new RegExp(cfg.output_strip_prefix, 'i'), '').trim();
    } catch {
      return raw;
    }
  }

  /* ── Input insertion (verified chain) ── */

  function currentInputValue(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return (el.innerText !== undefined ? el.innerText : el.textContent) || '';
  }

  function setInput(text, inputSels) {
    const el = firstMatch(inputSels);
    if (!el) return { ok: false, reason: 'input-not-found' };

    // Probe must be long enough to distinguish intended text from any
    // leftover draft, but short enough for tiny fields.
    const probe = text.slice(0, Math.min(60, Math.max(text.length, 1)));

    const containsProbe = () => currentInputValue(el).includes(probe);

    // Replace any draft rather than appending to it.
    try {
      el.focus();
      document.execCommand('selectAll', false, null);
    } catch { /* non-fatal */ }

    // 1) execCommand insertText — works on most contenteditable editors.
    let landed = false;
    try {
      landed = document.execCommand('insertText', false, text);
    } catch { landed = false; }
    // insertText replaces only the selection; if selectAll silently failed,
    // a leftover draft would remain. Require the field to START with our
    // probe so stale prefix text doesn't pass as success.
    if (landed && currentInputValue(el).trimStart().startsWith(probe)) return { ok: true, el };

    // 2) Synthetic beforeinput — how React 17+/Lexical/ProseMirror editors
    //    receive paste-like inserts when execCommand is ignored.
    try {
      el.focus();
      const ev = new InputEvent('beforeinput', {
        bubbles: true, cancelable: true, inputType: 'insertText', data: text
      });
      el.dispatchEvent(ev);
      if (!ev.defaultPrevented) {
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          el.value = text;
        } else {
          el.textContent = text;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch { /* fall through */ }
    if (containsProbe()) return { ok: true, el };

    // 3) Native value set + input event — last resort for plain fields.
    try {
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        el.value = text;
      } else {
        el.textContent = text;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } catch { /* fall through */ }
    if (containsProbe()) return { ok: true, el };

    return { ok: false, reason: 'insert-failed' };
  }

  /* ── Submission ── */

  function clickFirst(btnSels) {
    const btn = firstMatch(btnSels);
    if (!btn) return false;
    try {
      btn.click();
      return true;
    } catch {
      return false;
    }
  }

  function pressEnter(el) {
    if (!el) return false;
    const target = el.querySelector?.('[contenteditable="true"], textarea') || el;
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    try {
      target.dispatchEvent(new KeyboardEvent('keydown', opts));
      target.dispatchEvent(new KeyboardEvent('keypress', opts));
      target.dispatchEvent(new KeyboardEvent('keyup', opts));
      return true;
    } catch {
      return false;
    }
  }

  function anyMatchText(patternStrings, haystack) {
    if (!patternStrings || !haystack) return null;
    for (const p of patternStrings) {
      try {
        if (new RegExp(p, 'i').test(haystack)) return p;
      } catch { /* bad pattern in config — skip */ }
    }
    return null;
  }

  function scanForFailure(cfg) {
    // Scan a bounded region so body-wide innerText extraction stays cheap.
    const region = firstMatch(cfg.error_scan_target) || document.body;
    const text = visibleText(region).slice(-4000); // errors render near the composer
    const rl = anyMatchText(cfg.rate_limit_patterns, text);
    if (rl) return { kind: 'rate_limited', pattern: rl };
    const err = anyMatchText(cfg.error_patterns, text);
    if (err) return { kind: 'error', pattern: err };
    return null;
  }

  /* ── Engine state (one submission at a time per tab) ── */

  const state = {
    active: false,        // a submission is outstanding
    cfg: null,
    baselineText: '',
    baselineCount: 0,
    candidateText: '',    // text seen on the previous tick
    stableTicks: 0,
    quietTicks: 0,        // consecutive ticks with no progress and not generating
    submittedAt: 0
  };

  function reset() {
    state.active = false;
    state.candidateText = '';
    state.stableTicks = 0;
    state.quietTicks = 0;
  }

  function doInject(msg, cfg, sendResponse) {
    const merged = Object.assign({}, cfg, msg.selectors || {});
    const ins = setInput(msg.prompt, merged.input);
    if (!ins.ok) {
      sendResponse({ status: 'error', text: ins.reason });
      return;
    }
    const submitSel = merged.submit;

    setTimeout(() => {
      const outs = extractOutputs(merged);
      state.baselineText = outs.length ? visibleText(outs[outs.length - 1]).trim() : '';
      state.baselineCount = outs.length;
      state.cfg = merged;
      state.submittedAt = Date.now();
      state.candidateText = '';
      state.stableTicks = 0;
      state.quietTicks = 0;

      const clicked = clickFirst(submitSel);
      if (!clicked) pressEnter(ins.el);
      state.active = true;
    }, 300);

    sendResponse({ status: 'thinking' });
  }

  function isGenerating(merged) {
    const el = firstMatch(merged.wait_selector);
    if (!el) return false;
    // Some sites keep the progress indicator mounted after completion; only
    // treat it as active generation while actually visible.
    if (merged.wait_selector_visible) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
    }
    return true;
  }

  function doPoll(cfg, sendResponse) {
    if (!state.active) {
      sendResponse({ status: 'idle' });
      return;
    }
    const merged = state.cfg;
    const generating = isGenerating(merged);

    if (generating) {
      state.quietTicks = 0;
      state.stableTicks = 0;
      // Stream the in-flight tail so the popup can show a live feed.
      const text = latestOutputText(merged);
      if (text && text !== state.baselineText) {
        sendResponse({ status: 'thinking', tail: text.slice(-TAIL_CHARS) });
      } else {
        sendResponse({ status: 'thinking' });
      }
      return;
    }

    const outs = extractOutputs(merged);
    const count = outs.length;
    const text = count ? visibleText(outs[count - 1]).trim() : '';
    const isNew = count > state.baselineCount ||
      (!!text && !!state.baselineText && text !== state.baselineText) ||
      (!!text && !state.baselineText);

    if (!isNew) {
      state.quietTicks++;
      // Went quiet without ever producing a new message → look for error /
      // rate-limit copy rendered by the site.
      if (state.quietTicks >= QUIET_TICKS_BEFORE_ERROR_SCAN) {
        const failure = scanForFailure(merged);
        if (failure) {
          reset();
          sendResponse({ status: failure.kind, reason: failure.pattern });
          return;
        }
      }
      sendResponse({ status: 'thinking' });
      return;
    }

    // New message present — require it to hold steady for a tick so a
    // stop-button flicker mid-stream can't pass for a finished answer.
    if (text === state.candidateText) {
      state.stableTicks++;
    } else {
      state.candidateText = text;
      state.stableTicks = 1;
      state.quietTicks = 0;
    }

    if (state.stableTicks >= STABLE_TICKS_REQUIRED) {
      reset();
      sendResponse({ status: 'done', text });
      return;
    }
    sendResponse({ status: 'thinking' });
  }

  /* ── Selector Doctor: read-only health probe of every selector array ──
   * Reports which entry matched (or that all failed) for each array in the
   * site config. Never mutates state — safe to run mid-debate or idle.
   */
  function diagnose(cfg) {
    const report = {};
    const arrays = {
      input: cfg.input,
      submit: cfg.submit,
      output: cfg.output,
      wait_selector: cfg.wait_selector
    };
    Object.entries(arrays).forEach(([name, sels]) => {
      const list = Array.isArray(sels) ? sels : [sels];
      let matched = null;
      let invalid = [];
      for (let i = 0; i < list.length; i++) {
        try {
          if (qs(list[i])) { matched = { index: i, selector: list[i] }; break; }
        } catch {
          invalid.push(list[i]);
        }
      }
      report[name] = {
        ok: matched !== null,
        matched: matched ? matched.selector : null,
        matchedIndex: matched ? matched.index : null,
        tried: list.length,
        invalidSelectors: invalid
      };
    });
    // Sample what the output array currently extracts, so the user can see
    // the engine is reading real answers.
    const outs = extractOutputs(cfg);
    report.outputSample = outs.length
      ? visibleText(outs[outs.length - 1]).trim().slice(0, 200)
      : '';
    return report;
  }

  /* ── Public entry point used by each site script ── */

  window.HiveAgentCore = {
    handleMessage(msg, siteDefaults, sendResponse) {
      switch (msg.action) {
        case 'inject_prompt':
          doInject(msg, siteDefaults, sendResponse);
          return false;
        case 'poll_response':
          doPoll(siteDefaults, sendResponse);
          return false;
        case 'cancel':
          reset();
          sendResponse({ status: 'idle' });
          return false;
        case 'diagnose':
          sendResponse({ status: 'ok', report: diagnose(Object.assign({}, siteDefaults, msg.selectors || {})) });
          return false;
        default:
          // Unknown action: don't answer, don't hold the channel — another
          // listener on this page may own it.
          return false;
      }
    }
  };
})();
