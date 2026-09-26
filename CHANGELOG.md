# Changelog

## Unreleased

### Added
- **Site registry** (`src/lib/sites.js`): every automatable AI site is now a
  data entry — adding or removing one no longer requires code or manifest
  edits. The popup's agent rail, chart colors, legend, and labels are all
  generated from the registry.
- **Grok, DeepSeek, Perplexity, Copilot, and Mistral** ship as preconfigured
  sites (opt-in via the new **Sites** drawer; their content scripts register
  at runtime through `chrome.scripting`).
- **Add-any-site onboarding**: paste a URL in the Sites drawer, approve the
  one-time host permission, and the site joins the panel immediately with a
  generic selector config.
- **Selector Doctor**: diagnostics drawer probes every agent tab's selector
  arrays (which fallback matched, which groups fail, invalid entries, live
  output sample) plus API-agent and bridge health — run it before debating.
- **Custom API agents**: any OpenAI-compatible endpoint (local Ollama,
  vLLM, LM Studio…) can join the panel. Configure name/base-URL/key/model
  in the API Agents drawer; agents appear as `custom:<id>` internally.
- **Prompt library**: save, reload, and delete named debate prompts
  (persisted in `storage.local`, capped at 30). Writes are serialized so
  rapid saves never clobber each other.

### Fixed
- **Score gaming**: a model writing `[Score: 20/10]` was clamped to a perfect
  10 and could win the debate outright. Inflated claims (numerator above its
  own denominator), negative claims, and absurd denominators are now discarded;
  legitimate alternative maxima (7/20) still rescale. Decimal scores round
  correctly instead of truncating.
- **Popup layout clipped the agent rail**: the chart's unbounded `flex:1` grew
  and pushed the consensus panel and agent row below the fold of the fixed
  800×600 popup. The chart is now bounded, `#app` scrolls, and the agent row
  is never pushed out of view.
- **Cross-critique prompts grew quadratically**: with 6 agents and verbose
  answers, round-3 prompts reached ~12k tokens of re-quoted transcript.
  `wrapConversation()` now quotes only the newest round in full and condenses
  older rounds to their opening claim (~45% smaller at 6 agents, and bounded
  as the panel grows).
- **Blind-judge prompt halved**: arguments are now excerpted (opening claim +
  conclusion) instead of quoted whole — 8k → 3.3k tokens per pass at an
  8-agent panel, and the judge runs twice per debate.
- **Single-agent debates claimed a consensus** that was never tested against
  anyone ("agreement is strong"). A lone respondent is now reported honestly
  as one answer with no cross-check.
- Custom API agents never joined debates: the client's config lookup for
  `custom:<id>` resolved to `undefined` because definitions live at the
  config root. Now resolved through a `'*'` root lookup, covered by a
  wiring-faithful regression test.
- Winner banners/feeds showed raw `custom:c1` ids instead of configured
  names; agent labels are now resolved from the roster/API config, and
  history persists each agent's label at debate time so removed or renamed
  sites still read correctly in past debates.
- `registerSiteScripts` registered every lazy site under one shared script id,
  so only the first lazy site ever received the engine. Now one entry per
  site, with add/update/stale-prune logic.
- The dynamic site bridge resolved its config from a hostname prefix, which
  mismatched real ids (`chat.deepseek.com` → "chat"); resolution is now by
  exact page origin, including alias hosts (Grok on x.com).
- Tabs whose content script hadn't loaded (site just enabled) failed silently;
  the engine is now injected on demand and the inject retried.
- `[hidden]` sections stayed visible wherever a `display:flex` rule applied;
  enforced globally.
- Preview stub `storage.local` now supports promise-style calls (matching
  the real API), fixing silent failures in popup handlers under preview.

## 2.0.0 — 2026-08-26

### Engine
- Shared `agent_core.js` engine replaces three copy-pasted content scripts:
  verified insertion chain (execCommand → beforeinput → native), baseline +
  message-count freshness detection with two-tick stability confirmation,
  configurable error/rate-limit pattern scanning, generation tails for the
  live feed.
- Selector schema v2: fallback **arrays** per site + regex failure patterns,
  validated (`isValidSelectors`); bundled file always works offline.

### Debate orchestration
- Per-round deadlines (45 s each) with survivor continuation; hard
  debate-level ceiling as backstop. Timed-out agents re-enter next round.
- Smart Stop: shingle/Jaccard convergence detection ends debates once the
  panel starts echoing itself; reason recorded in the synthesis.
- Devil's Advocate: final round hands the lowest scorer a contrarian brief.
- Blind judge: independent API model ranks anonymized arguments under two
  shuffles (position-bias robustness) and excludes panelist backbones when
  possible (self-preference bias).
- API agents (OpenRouter / Cloudflare Workers AI / NVIDIA NIM) are
  first-class panelists: same barrier, streaming into the live feed,
  re-entry after rate limits, per-agent round tokens against stale answers.
- Hourly API budget guard (sliding window, persisted across worker restarts)
  with `quota-hold` status.
- MV3 keep-alive alarm during debates — API-only debates no longer die when
  the worker idles out (WebSockets/timers do not keep it alive).
- Abort broadcasts `cancel` to live tab agents; idempotent single-exit
  `finalizeDebate` on every path; winner computed once and persisted.

### Popup
- Brand header with live status dot + bridge connectivity chip; live typing
  feed with terminal cursor and per-update flash; interactive chart with
  hover tooltips, legend, staggered spring bars; consensus panel with winner
  banner, sanitized mini-markdown, follow-up Q&A to the winning agent;
  round-progress dots; history browser with panel statistics and JSONL
  export; API-agents settings drawer; Telegram delivery; light/dark/adaptive
  themes; reduced-motion support.

### Bridge (tools/bridge.py)
- OpenAI-compatible `/v1/chat/completions` with SSE streaming (live round
  events as deltas), `/v1/models`, env-configurable ports/timeouts, optional
  `HIVEMIND_TOKEN` WS auth (rejects without token, close 4401), websockets
  ≤12/≥13 compat, orphaned-task cancellation on client disconnect.

### Quality
- 82 tests across four suites, including a DOM-shim regression suite for the
  content-script engine's freshness lifecycle.
