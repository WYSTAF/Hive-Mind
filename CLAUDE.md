# CLAUDE.md

Guidance for working on the HiveMind Debate extension.

## What this is

MV3 browser extension (Chrome + Firefox) that orchestrates multi-round debates between ChatGPT, Claude, and Gemini web tabs, plus a Python bridge exposing it as an OpenAI-compatible API. No build step, no dependencies for the extension itself; Python deps only for `tools/bridge.py`.

## Commands

```bash
node --test tests/agent_core.test.mjs tests/debate_logic.test.mjs tests/api_agents.test.mjs tests/features.test.mjs tests/sites.test.mjs   # 119 tests
node --check <js file>                     # syntax check
python -c "import ast; ast.parse(open('tools/bridge.py', encoding='utf-8').read())"  # bridge syntax
```

Load unpacked from this folder in `chrome://extensions` to test manually. After editing content scripts, **reload both the extension and the agent tabs** — stale content scripts are the #1 source of "mystery" failures.

## Layout

- `manifest.json` — MV3; module service worker; declares the three always-on sites' content scripts (each loads `src/lib/agent_core.js` **before** its site config). Lazy/user sites are registered at runtime via `chrome.scripting` — see `registerSiteScripts()`.
- `src/lib/sites.js` — **site registry**: every automatable AI site is a data entry (id, label, color, origins, urlTests, selector fallbacks, failure patterns, visibility). Adding a supported site should be a data change, not a code change. `siteForUrl` maps tabs → sites; `siteForOrigin` resolves the exact page origin (used by the dynamic bridge); `selectorsForSite` builds the content-engine config block.
- `src/lib/site_bridge.js` — message listener for dynamically-registered sites. Asks the worker for its config by **origin** (hostname prefix is only a hint — `chat.deepseek.com` ≠ id `deepseek`), with a 1.5 s cap and a generic fallback config.
- `src/lib/agent_core.js` — shared content-script engine (IIFE, not a module — content scripts are classic scripts). Exposes `window.HiveAgentCore.handleMessage(msg, SITE, sendResponse)`. Site scripts are pure config objects.
- `src/background.js` — orchestrator. ES module (`import` works here, unlike content scripts).
- `src/lib/api_agents.js` — pure provider logic (request building, response extraction, SSE stream parsing) + a thin `ApiAgentClient` fetch adapter with `ask()` / `askStream()`. API agents are first-class panelists: they join the same round barrier, can be rate-limited, re-enter later rounds, and stream into the live feed.
- `src/lib/debate_logic.js`, `src/lib/selectors.js` — pure logic, unit-tested, no DOM/extension APIs.
- `src/lib/convergence.js`, `src/lib/judging.js`, `src/lib/stats.js` — Smart Stop detector (shingle/Jaccard), blind-judge anonymization/verdict parsing, panel statistics. All pure + tested (`tests/features.test.mjs`).
- `popup/` — UI. `renderMarkdown()` is deliberately a tiny whitelist renderer — model text is escaped before any HTML-ish transform. Keep it that way.
- `selectors.json` — v2 schema: per-agent selector arrays with fallbacks, optional `error_patterns`/`rate_limit_patterns` (must compile as JS regex). `bridge` key holds WS URL config.
- `tools/bridge.py` — FastAPI + websockets. Handler signature `_path=None` param keeps compat across websockets ≤12 / ≥13.

## Conventions & invariants

- **Freshness detection**: an answer is only "done" when message count increased OR text differs from the submit-time baseline AND held stable two consecutive polls. Never weaken this — it prevents the previous round's answer being read as fresh.
- **Critique transcript is progressive**: `wrapConversation()` quotes only the newest round verbatim and condenses older rounds to their opening claim. Keep it that way — full quoting of every round reached ~12k tokens at 6 agents and risks both cost and smaller models' context windows.
- **One exit path**: every debate end (normal, timeout, abort) funnels through `finalizeDebate()`, which is idempotent via `debate.finalized`. New exit paths must call it, not duplicate its body.
- **Per-round deadlines** (`ROUND_TIMEOUT_MS`): each round gets a fresh 45 s window at inject time. Don't reintroduce a single whole-debate deadline.
- **Message routing**: listeners must return `false`/nothing for unknown actions and never respond to messages they don't own — first-responder-wins means an over-eager listener silently steals another context's reply.
- **Poll loop**: ticks are guarded against async overlap (`ticking` latch). Any new await-heavy logic belongs inside `tick()`, not the raw interval callback.
- **Agent kinds**: every agent state carries `kind: 'tab' | 'api'`. Tab agents advance via poll responses; API agents via promises from `launchApiRound` (with per-agent `roundToken` invalidating stale round responses). Any new round-transition code must handle both kinds — look for the `s.kind === 'api' ? … : …` branches.
- **Blind judge placement**: `maybeRunBlindJudge()` runs only on clean completions (max-rounds / all-settled / smart-stop paths) *before* `finalizeDebate`, so the verdict lands in history, synthesis, bridge payload, and popup together. Never call it on timeout/abort paths.
- **API budget guard**: every API request path (`launchApiRound`, follow-ups) must go through `apiBudget.trySpend()` + `persistBudget()` — a false return means show `quota-hold` and skip without recording a failure. Budget is a sliding 1h window shared across providers and persisted across worker restarts.
- **MV3 keep-alive**: WebSockets/timers do NOT keep the worker alive (only extension events do). While a debate runs, an `alarms` heartbeat (`updateKeepAlive`) wakes it; without tab-agent traffic (API-only debates) this is what keeps the debate from being killed mid-flight.
- **Judge independence**: `maybeRunBlindJudge` prefers an enabled API provider that did NOT participate in the debate (self-preference bias); the judge runs each debate under two shuffles and averages (position-bias robustness).
- **Tick resume guards**: any code after an `await` inside the poll tick must re-check `signal.aborted || debate.finalized || currentDebate !== debate` before mutating debate state — abort can finalize mid-tick.
- **Guard clauses on async completion**: API promise callbacks check `currentDebate === debate && !debate.finalized` before mutating state — a late response after finalize/abort must be dropped.
- **Sites are data**: add a site in `src/lib/sites.js` (or via the popup's Sites drawer). Don't hardcode site ids in background/popup — they must read from the registry (`activeSites`, `buildAgentList()`, `get_agent_roster`).
- **Registered script ids must be unique per site** — `registerSiteScripts()` uses `hivemind-site-scripts-<id>`; a shared id would only ever deliver the engine to one site.
- Popup timer is display-only; timeouts belong to background.

## Testing notes

- Unit tests: `node --test tests/agent_core.test.mjs tests/debate_logic.test.mjs tests/api_agents.test.mjs tests/features.test.mjs tests/sites.test.mjs` (119 tests). `tests/agent_core.test.mjs` runs the content-script engine inside a DOM shim — extend it when changing freshness/stability logic. `tests/sites.test.mjs` validates the registry (every site's selectors, patterns, and origin patterns must be well-formed). Beyond that, content-script behavior needs manual testing on live sites — use the console: `[HiveMind]` log lines come from the SW; content-script errors show in the agent tab's inspector.
- To test the bridge without the extension: `python tools/bridge.py` then hit `/health` (expect `"extension_connected": false`) and `/v1/chat/completions` (expect a ConnectionError payload). For a full streaming round-trip without Chrome: run the bridge, then `python tools/fake_extension_test.py` (connects as a fake extension, answers one debate, asserts round events + consensus arrive in the SSE stream).
- To preview/tune the popup UI outside the extension: `python tools/dev_server.py 8901 popup`, open `http://localhost:8901/popup.html`. `popup/preview-stub.js` activates only when chrome APIs are absent — it fakes storage/messaging with sample data and exposes `chrome.__fire(msg)` to inject push events (debate_started / agent_partial / chart_update / debate_complete).
