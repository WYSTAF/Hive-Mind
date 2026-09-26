# AI Consensus Engine — HiveMind Debate

A browser extension that runs **structured multi-round debates between ChatGPT, Claude, Gemini — and free-tier API models (OpenRouter / Cloudflare Workers AI / NVIDIA NIM)** in your open tabs, then *actually finishes the job*: detects when the panel has converged and stops early (**Smart Stop**), has an independent model **blind-judge** anonymized closing arguments, streams every panelist's typing live, synthesizes a consensus with dissent detection, tracks per-agent **win rates** across debates, exports everything to Markdown or **fine-tune-ready JSONL**, and exposes the whole engine as a **local OpenAI-compatible API** with SSE streaming.

> ⚠️ **Read first:** The browser-automation half of this tool drives the web UIs of chatgpt.com, claude.ai, and gemini.google.com. That likely violates those services' Terms of Service, can get accounts rate-limited or suspended, and breaks whenever those sites ship DOM changes. Use it on accounts you're prepared to lose. The three **API agents are legitimate free-tier API calls** — enable them (popup → *API Agents*) for a panel that doesn't depend on fragile scraping at all.

## Architecture

```
┌────────────┐   tabs.sendMessage    ┌──────────────────────────┐
│  Popup UI  │◄─────────────────────►│  background.js (MV3 SW)  │
│ chart/cons.│                       │  orchestrator + history   │
└────────────┘                       └────────┬────────┬────────┘
                                              │        │
                            inject/poll ──────┘        └──── WS ws://127.0.0.1:8765
                              per agent tab                     │
┌─────────────────────────────────────────────┐        ┌───────▼────────┐
│ agent_core.js (shared engine, per site)      │        │  tools/bridge.py│
│  • verified input insertion chain            │        │ /v1/chat/completions
│  • baseline + stability done-detection       │        │  (JSON + SSE)  │
│  • error/rate-limit pattern detection        │        │ /v1/models     │
└─────────────────────────────────────────────┘        └────────────────┘
```

- **`src/lib/api_agents.js`** — first-class API panelists: OpenRouter, Cloudflare Workers AI, and NVIDIA NIM join the same round barrier as tab agents. Request building/response parsing is pure and unit-tested; keys live in `storage.local`, configured in the popup's *API Agents* drawer.
- **`src/lib/agent_core.js`** — shared content-script engine: insertion chain with verification (`execCommand` → synthetic `beforeinput` → native value), submit-click → Enter-key fallback, baseline+message-count freshness check, two-tick stability confirmation before declaring an answer done, configurable regex scanning for error/rate-limit copy, and in-flight text tails for the popup's live feed.
- **`src/background.js`** — debate orchestrator: parallel broadcast, 500 ms polling, per-agent round barrier, one 45 s window per round (max 3 rounds) under a hard debate ceiling, salvage-on-timeout, retry-on-inject-failure, timed-out agents re-enter next round, idempotent finalization, desktop notification on completion, badge progress, 20-debate history in `storage.local`.
- **`popup/`** — control panel: prompt/tone/system-prompt, live score chart (per-agent colors), **live typing feed**, consensus panel (sanitized mini-markdown), transcript viewer, Markdown export, **history browser**, **API Agents settings drawer**, theme, Telegram delivery, state restore on reopen.
- **`tools/bridge.py`** — FastAPI + `websockets` server. `/v1/chat/completions` accepts `"stream": true` and emits live round events as SSE deltas before the final consensus. Env-configurable ports/timeouts.
- **`selectors.json`** — v2 schema: selector **arrays** (tried in order), plus `error_patterns` / `rate_limit_patterns`. Remote URL merge is validated before use; bundled file always works offline.

## Install

1. Get the folder onto your machine (it's this directory).
2. Chrome/Edge/Brave: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
3. Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `manifest.json`.

## Run a debate

1. Open (and log into) tabs for **chatgpt.com**, **claude.ai**, and **gemini.google.com** — one each; the extension uses the first matching tab per site.
2. Click the HiveMind toolbar icon.
3. Type a prompt, pick a tone, optionally set a system prompt and Telegram credentials.
4. **🧠 Start Debate.** Watch rounds close on the chart; the consensus panel fills in at the end.

Agents without a tab are marked `no tab` and simply sit the debate out — you can run 2-agent or even 1-agent debates.

### Which sites join the panel

ChatGPT, Claude, and Gemini are always on. **Grok, DeepSeek, Perplexity, Copilot, and Mistral** ship preconfigured and can be switched on in the **Sites** drawer — enabling one registers its content script automatically (no extension reload needed, and no manifest edit).

You can also add any other AI chat site yourself: paste its URL in the Sites drawer, approve the one-time host permission, and it becomes a panelist immediately with a generic selector config. Run the **Selector Doctor** afterwards if it doesn't find the composer on that site — it tells you exactly which selector to add.

### Smart Stop & Blind Judge & Devil's Advocate

Toggles live next to Start:

- **Smart Stop** — after each round closes, word-trigram similarity checks whether panelists are just repeating their previous argument or echoing each other. If so, the debate ends early (you'll see why in the synthesis: *"Debate ended early: Smart Stop after round 2…"*), saving minutes and API/quota burn.
- **Blind Judge** — when a debate ends cleanly, an enabled API model (OpenRouter preferred) ranks **anonymized** closing arguments (A/B/C, shuffled) and returns a strict JSON verdict. This is the only score in the system that isn't a model grading its own homework — it drives the **Wins** column in History & Panel Stats.
- **Devil's Advocate** — on the final round, the *lowest-scoring* agent is handed a contrarian brief: attack the emerging majority's weakest assumptions instead of restating its own case. The synthesis notes when a position survived a stress test.

### Follow-up questions & API budget guard

After any completed debate, the consensus panel gains an **"Ask the winner"** box: one question, routed to the debate's best-performing agent (blind-judge winner first), answered with full debate context. API follow-ups count against a built-in **hourly budget guard** (20 requests/h sliding window) so a runaway loop can't torch a free tier; over-budget agents show a `quota-hold` amber ring and re-enter when the window slides.

### Selector Doctor, custom agents & prompt library

- **Selector Doctor** — one click probes every panelist before you debate: which fallback selector matched per site, which groups broke, invalid entries, a live sample of what the output selector currently reads, plus API-agent and bridge health. When a site redesigns, this tells you exactly which array entry to fix.
- **Custom API agents** — any OpenAI-compatible endpoint works as a panelist: local Ollama (`http://127.0.0.1:11434/v1`), vLLM, LM Studio, or a paid API. Add it in the *API Agents* drawer; it debates like any other agent.
- **Prompt library** — 💾 saves the current prompt to a persistent library (30 max); reload or delete from the 📚 dropdown.

### Panel statistics & JSONL export

The *History* drawer shows per-agent stats across all stored debates: appearances, win rate (blind judge when available, else highest self-score), average score, and failures. **Export JSONL** converts every stored debate into OpenAI fine-tune format (`{"messages":[{system},{user},{assistant}]}` per line) — your debate corpus becomes training data in one click.

### Adding free-tier API agents

Open the popup → **API Agents** drawer:

| Provider | Needs | Suggested free model |
|---|---|---|
| OpenRouter | API key from [openrouter.ai/keys](https://openrouter.ai/keys) | `meta-llama/llama-3.3-70b-instruct:free` |
| Cloudflare Workers AI | Account ID + API token ([dash.cloudflare.com](https://dash.cloudflare.com) → Workers AI) | `@cf/meta/llama-3.1-8b-instruct` |
| NVIDIA NIM | API key from [build.nvidia.com](https://build.nvidia.com) (free tier available) | `meta/llama-3.1-8b-instruct` |

Tick *enable*, paste credentials, **Save** — the panelist joins the next debate automatically and shows up on the chart in its own color. API models respond faster than web tabs, so expect them to anchor early rounds; rate-limited API agents sit a round out and re-enter later, same as timed-out tab agents.

### Telegram delivery

1. Create a bot via [@BotFather](https://t.me/BotFather), copy the token.
2. Message your bot once, then find your chat ID via `https://api.telegram.org/bot<TOKEN>/getUpdates`.
3. Paste both into the popup. The final synthesis is sent when the debate completes.

### Bridge (OpenAI-compatible endpoint)

```bash
pip install fastapi uvicorn websockets
python tools/bridge.py
```

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"hivemind-consensus","messages":[{"role":"user","content":"Is nuclear power worth the risk?"}]}'
```

Streaming:

```bash
curl -N http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"hivemind-consensus","stream":true,"messages":[{"role":"user","content":"Debate this: tabs vs spaces"}]}'
```

Point any OpenAI-SDK client at `base_url=http://127.0.0.1:3000/v1` with any dummy API key. Env vars: `HIVEMIND_HTTP_PORT`, `HIVEMIND_WS_PORT`, `HIVEMIND_DEBATE_TIMEOUT` (default 160 s — three 45 s rounds plus overhead).

**Securing the bridge:** by default any local process can drive the panel through port 8765 (it operates your logged-in chat tabs, so treat that seriously). Set `HIVEMIND_TOKEN=…` when starting the bridge and put `"token": "…"` in the `bridge` block of `selectors.json` — connections without the token are rejected. The bridge also accepts HiveMind extensions on `/v1/chat/completions`: `tone`, `smart_stop`, `blind_judge`, `devils_advocate`.

## Development

```bash
node --test tests/agent_core.test.mjs tests/debate_logic.test.mjs tests/api_agents.test.mjs tests/features.test.mjs tests/sites.test.mjs   # 119 tests across 5 suites
node --check <file>                        # syntax-check any script
```

When a site redesigns, update its block in `selectors.json`: prefer adding a **new selector to the front of the relevant array** rather than replacing old ones (old entries keep working as fallbacks). Patterns must compile as JavaScript regexes — the validator rejects anything else.

Icons are generated by `python tools/gen_icons.py` (Pillow) if you want to re-theme them.

## Known limits

- MV3 service workers can be killed mid-debate by the browser after ~30 s idle; debates here are active (polls every 500 ms) which normally keeps the worker alive, but long site-side stalls can still end a debate early via the round timeout.
- Only one debate at a time; starting another while one runs is rejected.
- API-agent keys are stored in `storage.local` on this machine (never synced, never sent anywhere except the provider you configured). They're readable by anyone with access to your browser profile — treat it like a `.env` file.
- Selector automation is inherently fragile against live sites; the failure-detection patterns reduce silent hangs but can't prevent ToS enforcement by the providers. API agents are the robust path.
