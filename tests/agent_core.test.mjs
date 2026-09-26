/* ── agent_core regression suite ──
 * Runs src/lib/agent_core.js (an IIFE expecting browser globals) inside a
 * hand-built DOM sandbox. This engine owns freshness detection — the #1
 * historical bug source — so its lifecycle gets real coverage here.
 *
 * Run: node --test tests/agent_core.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'agent_core.js'),
  'utf8'
);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── Sandbox construction ── */

function makeElement({ tag = 'DIV', selector = '', text = '', rect = { width: 10, height: 10 } } = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    selector,
    _text: text,
    value: '',
    clicked: 0,
    focused: false,
    focus() { this.focused = true; },
    getBoundingClientRect() { return this.rect || rect; },
    matches(s) { return s === selector; },
    querySelector() { return null; },
    click() {
      if (this.throwOnClick) throw new Error('click failed');
      this.clicked++;
    }
  };
  Object.defineProperty(el, 'innerText', {
    get() { return typeof this._text === 'function' ? this._text() : this._text; },
    set(v) { this._text = v; }
  });
  // Resolve dynamic (_text-as-function) elements here too: engine reads
  // textContent as a fallback when innerText is empty/falsy.
  Object.defineProperty(el, 'textContent', {
    get() { return typeof this._text === 'function' ? this._text() : this._text; },
    set(v) { this._text = v; }
  });
  return el;
}

/**
 * Build a fresh engine with a selector→element registry.
 * registry: { "css.selector": element | [elements] }
 */
function makeEngine(registry, { execCommandInsertsInto = null, body = null } = {}) {
  const resolve = sel => {
    const entry = registry[sel];
    if (typeof entry === 'function') return entry();
    return entry ?? null;
  };
  // execCommand('insertText') writes only into elements that behave like a
  // focused editor — never into buttons/outputs (a real browser scopes it
  // to the selection). Default target: the registered '#input'. Pass the
  // string 'none' to simulate an editor that swallows inserts.
  const editableTargets = () => {
    if (execCommandInsertsInto === 'none') return [];
    const sel = execCommandInsertsInto ?? (registry['#input'] ? '#input' : null);
    if (sel) return [].concat(resolve(sel) || []).filter(Boolean);
    return Object.values(registry)
      .flat()
      .filter(el => el && ['TEXTAREA', 'INPUT'].includes(el.tagName));
  };
  // A real DOM throws SyntaxError on unparseable selectors; emulate that so
  // the engine's invalid-selector handling is actually exercised.
  const isBadSelector = sel =>
    sel.includes('##') || /(^|\s)\w+\[unclosed/.test(sel) || sel.endsWith('[');
  const doc = {
    querySelector: sel => {
      if (isBadSelector(sel)) throw new Error(`SyntaxError: '${sel}' is not a valid selector`);
      return resolve(sel);
    },
    querySelectorAll: sel => {
      if (isBadSelector(sel)) throw new Error(`SyntaxError: '${sel}' is not a valid selector`);
      const r = resolve(sel);
      return Array.isArray(r) ? [...r] : (r ? [r] : []);
    },
    execCommand(cmd, _ui, arg) {
      if (cmd === 'selectAll') return true;
      if (cmd === 'insertText') {
        for (const t of editableTargets()) {
          if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') t.value += arg;
          else t._text = (typeof t._text === 'string' ? t._text : '') + arg;
        }
        return true;
      }
      return false;
    },
    body: body ?? makeElement({ selector: 'body', text: '' })
  };

  const sandboxWindow = {};
  const globals = {
    window: sandboxWindow,
    document: doc,
    InputEvent: class { constructor(type, opts = {}) { this.type = type; Object.assign(this, opts); } },
    Event: class { constructor(type) { this.type = type; } },
    KeyboardEvent: class { constructor(type) { this.type = type; } },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout,
    clearTimeout,
    Date,
    console
  };
  // Evaluate the IIFE with our globals shadowing the Node ones.
  const keys = Object.keys(globals);
  const fn = new Function(...keys, `'use strict';\n${SOURCE};`);
  fn(...keys.map(k => globals[k]));
  return sandboxWindow.HiveAgentCore;
}

/** Invoke an action and capture sendResponse asynchronously. */
function call(engine, msg, SITE) {
  return new Promise(resolve => {
    const holdChannel = engine.handleMessage(msg, SITE, response => resolve(response));
    if (holdChannel === undefined && !resolve.called) {
      // respond happened synchronously inside handleMessage
    }
  });
}

const SITE = {
  input: ['#input'],
  submit: ['#submit'],
  output: ['.answer'],
  wait_selector: ['#stopbtn'],
  error_patterns: ['something went wrong'],
  rate_limit_patterns: ['you hit the limit']
};

/* ── Tests ── */

test('idle poll answers idle without any submission', async () => {
  const engine = makeEngine({});
  const res = await call(engine, { action: 'poll_response' }, SITE);
  assert.equal(res.status, 'idle');
});

test('unknown action: no response, channel not held', async () => {
  const engine = makeEngine({});
  let responded = false;
  const hold = engine.handleMessage({ action: 'mischief' }, SITE, () => { responded = true; });
  assert.equal(responded, false);
  assert.notEqual(hold, true); // must not claim the channel
});

test('inject: missing input reports error immediately', async () => {
  const engine = makeEngine({});
  const res = await call(engine, { action: 'inject_prompt', prompt: 'hi' }, SITE);
  assert.equal(res.status, 'error');
});

test('inject: full lifecycle reaches done only on fresh stable answer', async () => {
  const input = makeElement({ tag: 'DIV', selector: '#input' });
  const submit = makeElement({ tag: 'BUTTON', selector: '#submit' });
  let answerText = 'old answer';
  const answer = makeElement({ selector: '.answer', text: () => answerText });
  const stopBtn = makeElement({ tag: 'BUTTON', selector: '#stopbtn' });

  // Mutable registry: deleting '#stopbtn' simulates generation ending
  // (ChatGPT/Claude unmount their stop buttons).
  const registry = {
    '#input': input,
    '#submit': submit,
    '.answer': answer,
    '#stopbtn': stopBtn
  };
  const engine = makeEngine(registry);

  // Baseline exists BEFORE inject (old answer visible).
  const ack = await call(engine, { action: 'inject_prompt', prompt: 'new question' }, SITE);
  assert.equal(ack.status, 'thinking');

  await sleep(360); // inject's submit timer
  assert.equal(submit.clicked, 1);

  // While generating: stop button present → thinking (even though old answer text differs).
  let res = await call(engine, { action: 'poll_response' }, SITE);
  assert.equal(res.status, 'thinking');

  // Generation ends (stop button unmounts), but the NEW message hasn't
  // rendered yet — stale baseline must NOT count as fresh.
  delete registry['#stopbtn'];
  res = await call(engine, { action: 'poll_response' }, SITE);
  assert.equal(res.status, 'thinking');

  // New message arrives mid-stream — first sighting is only a candidate.
  answerText = 'fresh complete answer part 1';
  res = await call(engine, { action: 'poll_response' }, SITE);
  assert.equal(res.status, 'thinking');

  // Stream finished (text unchanged across polls) → done.
  res = await call(engine, { action: 'poll_response' }, SITE);
  assert.equal(res.status, 'done');
  assert.equal(res.text, 'fresh complete answer part 1');
});

test('poll streams generation tail once text departs baseline', async () => {
  const input = makeElement({ selector: '#input' });
  const submit = makeElement({ tag: 'BUTTON', selector: '#submit' });
  let answerText = '';
  const answer = makeElement({ selector: '.answer', text: () => answerText });
  const stopBtn = makeElement({ tag: 'BUTTON', selector: '#stopbtn' });
  const engine = makeEngine({
    '#input': input, '#submit': submit, '.answer': answer, '#stopbtn': stopBtn
  });

  await call(engine, { action: 'inject_prompt', prompt: 'q' }, SITE);
  await sleep(360);

  answerText = 'partial stream…';
  const res = await call(engine, { action: 'poll_response' }, SITE);
  assert.equal(res.status, 'thinking');
  assert.ok(res.tail && res.tail.includes('partial stream'));
});

test('quiet submission triggers rate-limit detection from page copy', async () => {
  const input = makeElement({ selector: '#input' });
  const submit = makeElement({ tag: 'BUTTON', selector: '#submit' });
  const answer = makeElement({ selector: '.answer', text: 'stale' });
  const bodyCopy = makeElement({ selector: 'body', text: '' });
  const engine = makeEngine(
    { '#input': input, '#submit': submit, '.answer': answer },
    { body: bodyCopy }
  );
  // No stop-button element registered → never generating.

  await call(engine, { action: 'inject_prompt', prompt: 'q' }, SITE);
  await sleep(360);

  // Nothing new renders; after QUIET_TICKS threshold the failure scan kicks in.
  bodyCopy._text = 'You hit the limit. Try again in 3 hours.';
  let res;
  for (let i = 0; i < 8; i++) {
    res = await call(engine, { action: 'poll_response' }, SITE);
    if (res.status === 'rate_limited') break;
  }
  assert.equal(res.status, 'rate_limited');

  // Engine reset: subsequent poll is idle again.
  res = await call(engine, { action: 'poll_response' }, SITE);
  assert.equal(res.status, 'idle');
});

test('quiet submission surfaces generic errors too', async () => {
  const input = makeElement({ selector: '#input' });
  const submit = makeElement({ tag: 'BUTTON', selector: '#submit' });
  const answer = makeElement({ selector: '.answer', text: 'stale' });
  const bodyCopy = makeElement({ selector: 'body', text: 'Something went wrong. Please try again.' });
  const engine = makeEngine(
    { '#input': input, '#submit': submit, '.answer': answer },
    { body: bodyCopy }
  );

  await call(engine, { action: 'inject_prompt', prompt: 'q' }, SITE);
  await sleep(360);
  let res;
  for (let i = 0; i < 8; i++) {
    res = await call(engine, { action: 'poll_response' }, SITE);
    if (res.status === 'error') break;
  }
  assert.equal(res.status, 'error');
});

test('cancel resets outstanding submission to idle', async () => {
  const input = makeElement({ selector: '#input' });
  const submit = makeElement({ tag: 'BUTTON', selector: '#submit' });
  const answer = makeElement({ selector: '.answer', text: 'old' });
  const stopBtn = makeElement({ tag: 'BUTTON', selector: '#stopbtn' });
  const engine = makeEngine({
    '#input': input, '#submit': submit, '.answer': answer, '#stopbtn': stopBtn
  });

  await call(engine, { action: 'inject_prompt', prompt: 'q' }, SITE);
  await sleep(360);
  const res = await call(engine, { action: 'cancel' }, SITE);
  assert.equal(res.status, 'idle');
  const after = await call(engine, { action: 'poll_response' }, SITE);
  assert.equal(after.status, 'idle');
});

test('insertion falls back to beforeinput/native when execCommand lies', async () => {
  // Editor swallows execCommand entirely; engine's verified chain must
  // recover via its beforeinput/native-set fallbacks and still submit.
  const submit = makeElement({ tag: 'BUTTON', selector: '#submit' });
  const input = makeElement({ selector: '#input' });
  const answer = makeElement({ selector: '.answer', text: 'old' });
  const stopBtn = makeElement({ tag: 'BUTTON', selector: '#stopbtn' });
  const engine = makeEngine(
    { '#input': input, '#submit': submit, '.answer': answer, '#stopbtn': stopBtn },
    { execCommandInsertsInto: 'none' }
  );
  const ack = await call(engine, { action: 'inject_prompt', prompt: 'recovered prompt text' }, SITE);
  assert.equal(ack.status, 'thinking');
  await sleep(360);
  assert.equal(submit.clicked, 1, 'fallback insertion should reach submission');
});

/* ── Selector Doctor ── */

test('diagnose: reports first matching fallback per array', async () => {
  const engine = makeEngine({
    '#primary-input': makeElement({ selector: '#primary-input' })
    // '.alt-input', '#submit-btn', etc. absent → later entries fail
  });
  const res = await call(engine, {
    action: 'diagnose',
    selectors: {
      input: ['.alt-input', '#primary-input'],
      submit: ['#submit-btn'],
      output: ['.nope'],
      wait_selector: ['#stopbtn']
    }
  }, SITE);
  assert.equal(res.status, 'ok');
  assert.deepEqual(res.report.input,
    { ok: true, matched: '#primary-input', matchedIndex: 1, tried: 2, invalidSelectors: [] });
  assert.equal(res.report.submit.ok, false);
  assert.equal(res.report.output.ok, false);
  assert.equal(res.report.wait_selector.ok, false);
  assert.equal(res.report.outputSample, '');
});

test('diagnose: flags invalid selectors without throwing', async () => {
  const engine = makeEngine({});
  const res = await call(engine, {
    action: 'diagnose',
    selectors: {
      input: ['##bad-syntax', 'div[unclosed', '#real'],
      submit: ['#s'],
      output: ['.o'],
      wait_selector: ['#w']
    }
  }, SITE);
  assert.equal(res.status, 'ok');
  assert.equal(res.report.input.invalidSelectors.length, 2);
  // Engine still probed the valid third entry (absent → not ok).
  assert.equal(res.report.input.ok, false);
});

test('diagnose: output sample reflects live page content', async () => {
  const engine = makeEngine({
    '.answer': makeElement({ selector: '.answer', text: 'The panel says hello.' }),
    '#in': makeElement({ selector: '#in' }),
    '#sub': makeElement({ tag: 'BUTTON', selector: '#sub' }),
    '#stop': makeElement({ tag: 'BUTTON', selector: '#stop' })
  });
  const res = await call(engine, {
    action: 'diagnose',
    selectors: { input: ['#in'], submit: ['#sub'], output: ['.answer'], wait_selector: ['#stop'] }
  }, SITE);
  assert.ok(res.report.outputSample.includes('panel says hello'));
});

test('diagnose: read-only — does not disturb an active submission', async () => {
  const input = makeElement({ selector: '#input' });
  const submit = makeElement({ tag: 'BUTTON', selector: '#submit' });
  let answerText = 'old';
  const answer = makeElement({ selector: '.answer', text: () => answerText });
  const stopBtn = makeElement({ tag: 'BUTTON', selector: '#stopbtn' });
  const registry = { '#input': input, '#submit': submit, '.answer': answer, '#stopbtn': stopBtn };
  const engine = makeEngine(registry);

  await call(engine, { action: 'inject_prompt', prompt: 'q' }, SITE);
  await sleep(360);

  const diag = await call(engine, { action: 'diagnose' }, SITE);
  assert.equal(diag.status, 'ok');

  // Submission state untouched: still generating (stop button present).
  const res = await call(engine, { action: 'poll_response' }, SITE);
  assert.equal(res.status, 'thinking');
});
