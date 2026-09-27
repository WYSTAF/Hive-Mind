/* ── HiveMind unit tests ──
 * Run: node --test tests/
 * Covers the pure logic modules (no browser APIs required).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseScore, wrapConversation, synthesizeConsensus, isRoundBarrierMet, truncateForPrompt, buildDevilsAdvocatePrompt } from '../src/lib/debate_logic.js';
import { isValidSelectors } from '../src/lib/selectors.js';

/* ═══ parseScore ═══ */
test('parseScore: [Score: 7/10]', () => {
  assert.equal(parseScore('Great point. [Score: 7/10]'), 7);
});

test('parseScore: Score: X without brackets', () => {
  assert.equal(parseScore('Score: 8'), 8);
});

test('parseScore: X out of 10', () => {
  assert.equal(parseScore('I rate this 6 out of 10.'), 6);
});

test('parseScore: bare X/10', () => {
  assert.equal(parseScore('Overall: 9/10 for this argument.'), 9);
});

test('parseScore: rescales non-10 maxima', () => {
  assert.equal(parseScore('[Score: 5/5]'), 10);
});

test('parseScore: inflated claims are discarded, not clamped to 10', () => {
  // A numerator above its own denominator is a model claiming perfection.
  // Clamping would hand it a perfect score and let it win the debate.
  assert.equal(parseScore('Score: 42/10'), 0);
  assert.equal(parseScore('Score: 20/10'), 0);
  assert.equal(parseScore('The score is 100/10 (I am confident).'), 0);
  assert.equal(parseScore('Score: -3/10'), 0);
});

test('parseScore: decimal scores round to the nearest integer', () => {
  assert.equal(parseScore('[Score: 8.5/10]'), 9);
  assert.equal(parseScore('[Score: 7.4/10]'), 7);
});

test('parseScore: alternative maxima still rescale', () => {
  assert.equal(parseScore('[Score: 5/5]'), 10);
  assert.equal(parseScore('[Score: 7/20]'), 4);
});

test('parseScore: returns 0 when absent', () => {
  assert.equal(parseScore('No rating here at all.'), 0);
  assert.equal(parseScore(''), 0);
});

test('parseScore: LAST score wins — restated old score must not mask update', () => {
  const t = 'My previous argument scored [Score: 7/10]. After review, I update to Score: 9/10.';
  assert.equal(parseScore(t), 9);
});

test('parseScore: devil-advocate majority-survival score (final mention) wins', () => {
  const t = 'Earlier I gave [Score: 8/10]. The majority position survived my attack: Score: 5/10.';
  assert.equal(parseScore(t), 5);
});

test('parseScore: single score still parses normally', () => {
  assert.equal(parseScore('Verdict: [Score: 6/10]'), 6);
});

test('parseScore: does not misread dates as scores', () => {
  // "10/10/2026" — denominator isn't 10-as-rating context; should not yield 10
  const score = parseScore('Meeting on 12/10/2026 discussed.');
  assert.ok(score >= 0 && score <= 10);
});

/* ═══ truncateForPrompt ═══ */
test('truncateForPrompt: short text untouched', () => {
  assert.equal(truncateForPrompt('hello', 100), 'hello');
});

test('truncateForPrompt: long text truncated with marker', () => {
  const t = truncateForPrompt('x'.repeat(5000), 100);
  assert.ok(t.length < 200);
  assert.ok(t.includes('truncated'));
});

/* ═══ wrapConversation ═══ */
test('wrapConversation: escapes XML specials', () => {
  const xml = wrapConversation([{ round: 1, responses: { a: { text: '<b>&"\'</b>', score: 5 } } }]);
  assert.ok(xml.includes('&lt;b&gt;&amp;&quot;&apos;'));
  assert.ok(!xml.includes('<b>'));
});

test('wrapConversation: bounds oversized agent texts', () => {
  const big = 'y'.repeat(20000);
  const xml = wrapConversation([{ round: 1, responses: { a: { text: big, score: 5 } } }]);
  assert.ok(xml.length < 25000);
});

test('wrapConversation: numbers rounds correctly', () => {
  const xml = wrapConversation([
    { round: 1, responses: { a: { text: 'one', score: 5 } } },
    { round: 2, responses: { a: { text: 'two', score: 6 } } }
  ]);
  assert.ok(xml.includes('number="1"'));
  assert.ok(xml.includes('number="2"'));
  // Agent text renders on its own line inside <agent>…</agent>
  assert.match(xml, />\s+two\s+</);
});

/* ═══ synthesizeConsensus ═══ */
function makeDebate(rounds, agents = {}) {
  return { rounds, agents };
}

test('synthesizeConsensus: empty debate', () => {
  const s = synthesizeConsensus(makeDebate([], { chatgpt: { status: 'timeout' } }));
  assert.ok(s.includes('No responses received'));
  assert.ok(s.includes('chatgpt (timed out)'), 'statuses read as plain language');
});

test('synthesizeConsensus: ranks highest last-round response', () => {
  const s = synthesizeConsensus(makeDebate([
    { round: 1, responses: { chatgpt: { text: 'CGPT final', score: 9 }, claude: { text: 'CLD final', score: 4 } } }
  ]));
  assert.ok(s.includes('Highest-Rated Final Contribution (chatgpt: 9/10)'));
  assert.ok(s.includes('CGPT final'));
});

test('synthesizeConsensus: flags material dissent on wide spread', () => {
  const s = synthesizeConsensus(makeDebate([
    { round: 2, responses: { a: { text: 'x', score: 9 }, b: { text: 'y', score: 2 } } }
  ]));
  assert.ok(s.toLowerCase().includes('dissent'));
});

test('synthesizeConsensus: notes strong improvement across rounds', () => {
  const s = synthesizeConsensus(makeDebate([
    { round: 1, responses: { a: { text: 'r1a', score: 3 }, b: { text: 'r1b', score: 7 } } },
    { round: 2, responses: { a: { text: 'r2a', score: 9 }, b: { text: 'r2b', score: 7 } } }
  ]));
  assert.ok(s.includes('+6 points'));
});

/* ═══ isRoundBarrierMet ═══ */
test('isRoundBarrierMet: requires every active name settled', () => {
  const states = {
    chatgpt: { completed: true, timedOut: false },
    claude: { completed: false, timedOut: false },
    gemini: { completed: false, timedOut: true }
  };
  assert.equal(isRoundBarrierMet(states, ['chatgpt']), true);
  assert.equal(isRoundBarrierMet(states, ['chatgpt', 'claude']), false);
  assert.equal(isRoundBarrierMet(states, ['gemini']), true);
});

/* ═══ isValidSelectors ═══ */
const VALID_V2 = {
  chatgpt: {
    input: ['#a', '.b'],
    submit: ['button.x'],
    output: ['.m'],
    wait_selector: ['.w'],
    error_patterns: ['err'],
    rate_limit_patterns: ['limit']
  },
  claude: { input: 'i', submit: 's', output: 'o', wait_selector: 'w' },
  gemini: { input: ['i'], submit: ['s'], output: ['o'], wait_selector: ['w'] }
};

test('isValidSelectors: accepts v2 arrays + v1 strings mixed', () => {
  assert.equal(isValidSelectors(VALID_V2), true);
});

test('isValidSelectors: rejects empty selector arrays', () => {
  const bad = JSON.parse(JSON.stringify(VALID_V2));
  bad.chatgpt.input = [];
  assert.equal(isValidSelectors(bad), false);
});

test('isValidSelectors: rejects non-string array entries', () => {
  const bad = JSON.parse(JSON.stringify(VALID_V2));
  bad.gemini.submit = ['ok', 42];
  assert.equal(isValidSelectors(bad), false);
});

test('isValidSelectors: rejects uncompilable regex patterns', () => {
  const bad = JSON.parse(JSON.stringify(VALID_V2));
  bad.chatgpt.error_patterns = ['([unclosed'];
  assert.equal(isValidSelectors(bad), false);
});

test('isValidSelectors: missing agent block rejected', () => {
  const bad = JSON.parse(JSON.stringify(VALID_V2));
  delete bad.claude;
  assert.equal(isValidSelectors(bad), false);
});

test('isValidSelectors: optional patterns may be omitted', () => {
  const minimal = {
    chatgpt: { input: 'i', submit: 's', output: 'o', wait_selector: 'w' },
    claude: { input: 'i', submit: 's', output: 'o', wait_selector: 'w' },
    gemini: { input: 'i', submit: 's', output: 'o', wait_selector: 'w' }
  };
  assert.equal(isValidSelectors(minimal), true);
});

/* ═══ progressive critique transcript ═══ */
test('wrapConversation: only the newest round is quoted in full', () => {
  const rounds = [
    { round: 1, responses: { a: { text: 'old ' + 'A'.repeat(2000), score: 5 } } },
    { round: 2, responses: { a: { text: 'new ' + 'B'.repeat(2000), score: 8 } } }
  ];
  const xml = wrapConversation(rounds);
  assert.ok(xml.includes('earlier round, condensed'), 'older round should be condensed');
  // The old round's distinctive character must appear only a short summary's
  // worth of times, never the full 2000.
  const aCount = (xml.match(/A+/g) || []).reduce((n, m) => n + m.length, 0);
  assert.ok(aCount < 400, `old round should be condensed, saw ${aCount} A's`);
  assert.ok(xml.includes('B'.repeat(1000)), 'newest round should be verbatim');
});

test('wrapConversation: single round is always full (no condensation)', () => {
  const xml = wrapConversation([{ round: 1, responses: { a: { text: 'only round', score: 5 } } }]);
  assert.ok(!xml.includes('condensed'));
  assert.ok(xml.includes('only round'));
});

test('wrapConversation: recentFullRounds=0 condenses everything', () => {
  const xml = wrapConversation(
    [{ round: 1, responses: { a: { text: 'a long statement '.repeat(100), score: 5 } } }],
    { recentFullRounds: 0 }
  );
  assert.ok(xml.includes('condensed'), 'even the only round is condensed when asked');
});

test('wrapConversation: empty input is still well-formed XML', () => {
  assert.equal(wrapConversation([]), '<atagh_fekr_conversation>\n</atagh_fekr_conversation>');
  assert.equal(wrapConversation(null), '<atagh_fekr_conversation>\n</atagh_fekr_conversation>');
});

test('wrapConversation: prompt size stays bounded as panel grows', () => {
  // 6 agents x 3 rounds of verbose answers — the realistic worst case.
  const rounds = [1, 2, 3].map(r => ({
    round: r,
    responses: Object.fromEntries(
      ['chatgpt', 'claude', 'gemini', 'grok', 'deepseek', 'openrouter']
        .map(a => [a, { text: 'argument '.repeat(500), score: 7 }])
    )
  }));
  const xml = wrapConversation(rounds);
  assert.ok(xml.length < 40000, `prompt must stay bounded, got ${xml.length} chars`);
});

/* ═══ single-agent honesty ═══ */
test('synthesizeConsensus: a lone agent is reported as no consensus', () => {
  const s = synthesizeConsensus(makeDebate(
    [{ round: 1, responses: { chatgpt: { text: 'only answer', score: 7 } } }],
    { chatgpt: { status: 'done', score: 7 } }
  ));
  assert.ok(/no consensus to report/.test(s), 'must not claim consensus from one voice');
  assert.ok(!/agreement is strong/.test(s), 'must not claim agreement that was never tested');
});

test('synthesizeConsensus: two agents do get a real consensus statement', () => {
  const s = synthesizeConsensus(makeDebate(
    [{ round: 1, responses: { chatgpt: { text: 'a', score: 8 }, claude: { text: 'b', score: 8 } } }],
    {}
  ));
  assert.ok(/panel's consensus is anchored/.test(s));
  assert.ok(!/no consensus to report/.test(s));
});

/* ═══ score integrity (gaming + edge cases) ═══ */
test('parseScore: a model cannot win a round by claiming a perfect score', () => {
  // Inflated claims are discarded, not clamped — clamping would award a 10
  // and hand the debate to the gamiest panelist.
  assert.equal(parseScore('[Score: 20/10]'), 0);
  assert.equal(parseScore('[Score: 11/10]'), 0);
  assert.equal(parseScore('Score: 42/10'), 0);
});

test('parseScore: negative claims are invalid, not positive', () => {
  assert.equal(parseScore('Score: -3/10'), 0);
});

test('parseScore: alternative maxima rescale, absurd ones are rejected', () => {
  assert.equal(parseScore('[Score: 7/20]'), 4);    // 3.5 rounds to 4
  assert.equal(parseScore('[Score: 50/100]'), 5);
  assert.equal(parseScore('[Score: 3/1000]'), 0);   // not a rating
});

test('parseScore: realistic model formats all parse', () => {
  assert.equal(parseScore('My argument is solid. [Score: 8/10]'), 8);
  assert.equal(parseScore('I rate my response 7 out of 10.'), 7);
  assert.equal(parseScore('Overall quality: 9/10'), 9);
  assert.equal(parseScore('[Score:8]'), 8);
});

/* ═══ devil's advocate scoping ═══ */
test('devil\'s advocate brief is a distinct prompt from the standard one', () => {
  const xml = wrapConversation([{ round: 1, responses: { a: { text: 'claim', score: 5 } } }]);
  const adv = buildDevilsAdvocatePrompt('Q?', xml);
  const standard = `Q?\n\nReview the previous arguments:\n${xml}\n\n` +
    'Provide your updated argument and score in the format [Score: X/10]. Do not repeat your own previous arguments.';
  // background.js sends the adversary prompt to the adversary ONLY; if these
  // were the same string the whole panel would attack the majority.
  assert.notEqual(adv, standard);
  assert.match(adv, /DEVIL'S ADVOCATE/);
  assert.ok(!/DEVIL'S ADVOCATE/.test(standard), 'standard prompt stays non-contrarian');
});
