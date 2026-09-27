#!/usr/bin/env python3
"""AI Consensus Engine — Local OpenAI-Compatible API Bridge.

Runs an HTTP/WebSocket server that:
  - Exposes /v1/chat/completions (OpenAI-compatible) on localhost:3000,
    including Server-Sent-Events streaming (`"stream": true`).
  - Exposes /v1/models so clients can enumerate the engine.
  - Forwards prompts to the Chrome Extension via WebSocket (ws://127.0.0.1:8765)
    and streams live debate events (round completions) as chat deltas while
    the panel deliberates.
  - Returns the final synthesized consensus as a standard completion.

Configuration via environment variables:
    HIVEMIND_HTTP_HOST / HIVEMIND_HTTP_PORT   (default 127.0.0.1:3000)
    HIVEMIND_WS_HOST   / HIVEMIND_WS_PORT     (default 127.0.0.1:8765)
    HIVEMIND_DEBATE_TIMEOUT                   (default 240s; a full 3-round
                                              debate runs 3 x 45s round windows
                                              plus a hard ceiling, blind-judge
                                              time, and inject overhead)

Usage:
    pip install fastapi uvicorn websockets
    python tools/bridge.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any

import uvicorn
import websockets
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("hivemind-bridge")

HTTP_HOST = os.environ.get("HIVEMIND_HTTP_HOST", "127.0.0.1")
HTTP_PORT = int(os.environ.get("HIVEMIND_HTTP_PORT", "3000"))
WS_HOST = os.environ.get("HIVEMIND_WS_HOST", "127.0.0.1")
WS_PORT = int(os.environ.get("HIVEMIND_WS_PORT", "8765"))
DEBATE_TIMEOUT = float(os.environ.get("HIVEMIND_DEBATE_TIMEOUT", "240"))
# Optional shared secret: when set, WS clients must connect as
# ws://host:port/?token=<value>. Anything on the machine can otherwise
# commandeer the panel (drive the user's logged-in chat tabs).
BRIDGE_TOKEN = os.environ.get("HIVEMIND_TOKEN", "")

MODEL_ID = "hivemind-consensus"

app = FastAPI(title="HiveMind Bridge", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"http://{HTTP_HOST}:{HTTP_PORT}",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# WebSocket connection from the Chrome Extension (server side of the socket)
extension_ws: Any | None = None
ws_lock = asyncio.Lock()

# request_id -> Future resolving with the extension's final message
pending: dict[str, asyncio.Future] = {}
# request_id -> asyncio.Queue receiving live debate_event messages (streaming)
event_queues: dict[str, asyncio.Queue] = {}


class ChatCompletionRequest(BaseModel):
    model: str = MODEL_ID
    messages: list[dict[str, str]] = []
    temperature: float = 0.7
    max_tokens: int | None = None
    stream: bool = False
    # HiveMind extensions (ignored by standard OpenAI clients)
    tone: str = "neutral"
    smart_stop: bool = True
    blind_judge: bool = True
    devils_advocate: bool = False


def _completion_payload(content: str, model: str, finish_reason: str = "stop",
                        extra: dict | None = None) -> dict:
    payload = {
        "id": f"chatcmpl-hivemind-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": finish_reason,
            }
        ],
        "usage": {"prompt_tokens": -1, "completion_tokens": -1, "total_tokens": -1},
    }
    if extra:
        payload.update(extra)  # hivemind_winner / hivemind_stopped_reason
    return payload


def _sse_chunk(delta_content: str | None, model: str, finish_reason: str | None = None) -> str:
    delta = {"content": delta_content} if delta_content is not None else {}
    chunk = {
        "id": "chatcmpl-hivemind-stream",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    return f"data: {json.dumps(chunk)}\n\n"


async def ws_handler(ws, _path: str | None = None):
    """Handle the WebSocket connection from the Chrome Extension.

    Accepts both legacy handler(ws) (websockets <= 12) and modern
    handler(connection) (>= 13) invocation styles via the optional arg.
    When HIVEMIND_TOKEN is set, only connections presenting
    ?token=<secret> are accepted.
    """
    global extension_ws
    if BRIDGE_TOKEN:
        presented = getattr(ws, "request", None)
        qs = presented.path.split("?", 1)[1] if presented and "?" in presented.path else ""
        params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        if params.get("token") != BRIDGE_TOKEN:
            log.warning("Rejected WS connection with bad or missing token")
            await ws.close(code=4401, reason="bad token")
            return
    log.info("Chrome Extension connected via WebSocket")
    async with ws_lock:
        extension_ws = ws
    try:
        async for message in ws:
            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                log.warning("Ignoring malformed WS message: %.100s", message)
                continue

            action = data.get("action")
            req_id = data.get("request_id")

            if req_id:
                fut = pending.get(req_id)
                if fut is not None and not fut.done():
                    # Final result resolves the future…
                    pending.pop(req_id, None)
                    fut.set_result(data)
                    # …and closes any event stream waiting on this request.
                    q = event_queues.pop(req_id, None)
                    if q is not None:
                        await q.put(None)
                    continue

            if action == "debate_event":
                # The extension may omit request_id on progress events (only
                # one debate runs at a time), so fan out to every open stream.
                targeted = event_queues.get(req_id) if req_id else None
                targets = [targeted] if targeted else list(event_queues.values())
                for q in targets:
                    await q.put(data)
    except Exception as exc:
        log.error("WS connection error: %s", exc)
    finally:
        async with ws_lock:
            if extension_ws == ws:
                extension_ws = None
        # Fail anything still waiting so HTTP callers don't block to timeout.
        for req_id, fut in list(pending.items()):
            if not fut.done():
                fut.set_exception(ConnectionError("Extension disconnected"))
            pending.pop(req_id, None)
        for req_id, q in list(event_queues.items()):
            event_queues.pop(req_id, None)
            q.put_nowait(None)
        log.info("Chrome Extension disconnected")


async def send_to_extension(payload: dict, events: asyncio.Queue | None = None) -> dict:
    """Send a debate request to the extension; await the final consensus."""
    request_id = str(uuid.uuid4())
    payload["request_id"] = request_id
    future: asyncio.Future = asyncio.get_running_loop().create_future()
    pending[request_id] = future
    if events is not None:
        event_queues[request_id] = events

    async with ws_lock:
        if extension_ws is None:
            pending.pop(request_id, None)
            event_queues.pop(request_id, None)
            raise ConnectionError(
                "Extension WebSocket not connected — open Chrome with the HiveMind extension enabled"
            )
        await extension_ws.send(json.dumps(payload))

    try:
        return await asyncio.wait_for(future, timeout=DEBATE_TIMEOUT)
    except asyncio.TimeoutError:
        pending.pop(request_id, None)
        event_queues.pop(request_id, None)
        raise TimeoutError(f"Extension did not respond within {DEBATE_TIMEOUT:.0f}s")
    except asyncio.CancelledError:
        # Not an Exception subclass (3.8+): without this branch a cancelled
        # stream request leaks its pending/event_queues entries until the
        # next extension disconnect.
        pending.pop(request_id, None)
        event_queues.pop(request_id, None)
        raise
    except Exception:
        pending.pop(request_id, None)
        event_queues.pop(request_id, None)
        raise


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatCompletionRequest):
    """OpenAI-compatible endpoint (JSON + SSE streaming)."""
    prompt = ""
    system_prompt = ""
    for msg in req.messages:
        role = msg.get("role")
        content = msg.get("content", "")
        if role == "system":
            system_prompt += content + "\n"
        elif role == "user":
            prompt = content

    if not prompt:
        return _completion_payload("No user message provided.", req.model)

    debate_req = {
        "action": "start_debate",
        "prompt": prompt,
        "system_prompt": system_prompt.strip(),
        "tone": req.tone,
        "smart_stop": req.smart_stop,
        "blind_judge": req.blind_judge,
        "devils_advocate": req.devils_advocate,
    }

    if not req.stream:
        try:
            result = await send_to_extension(dict(debate_req))
            final_text = result.get("final_consensus", "No consensus reached.")
            extra = {
                "hivemind_winner": result.get("winner"),
                "hivemind_stopped_reason": result.get("stopped_reason"),
            }
        except (ConnectionError, TimeoutError) as e:
            log.error("Bridge error: %s", e)
            final_text = f"[HiveMind Bridge Error] {e}"
            extra = None
        return _completion_payload(final_text, req.model, extra=extra)

    # ── Streaming mode: live round events, then the consensus ──
    queue: asyncio.Queue = asyncio.Queue()

    async def generator():
        sender = None
        try:
            yield _sse_chunk("", req.model)  # role-establishing first chunk
            sender = asyncio.create_task(send_to_extension({**debate_req}, events=queue))
            # If the sender dies (no extension, timeout, disconnect), its
            # exception would otherwise sit unseen in the task while this
            # generator blocks on queue.get() forever. A done-callback drops
            # the end-of-stream sentinel no matter how the task ends.
            sender.add_done_callback(lambda _t: queue.put_nowait(None))
            while True:
                evt = await queue.get()
                if evt is None:
                    break
                kind = evt.get("kind")
                if kind == "round_complete":
                    round_no = evt.get("round", "?")
                    scores = ", ".join(
                        f"{a} {d.get('score', 0)}/10"
                        for a, d in (evt.get("responses") or {}).items()
                    )
                    yield _sse_chunk(f"\n\n**— Round {round_no} complete ({scores}) —**\n\n", req.model)
            result = await sender  # re-raises sender errors into the handler below
            yield _sse_chunk(result.get("final_consensus", ""), req.model)
            yield _sse_chunk(None, req.model, finish_reason="stop")
            yield "data: [DONE]\n\n"
        except (ConnectionError, TimeoutError) as e:
            yield _sse_chunk(f"[HiveMind Bridge Error] {e}", req.model)
            yield _sse_chunk(None, req.model, finish_reason="stop")
            yield "data: [DONE]\n\n"
        finally:
            # Client walked away mid-debate: stop the orphaned sender task so
            # it doesn't keep running an unconsumed debate to completion.
            if sender is not None and not sender.done():
                sender.cancel()

    return StreamingResponse(generator(), media_type="text/event-stream")


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [{
            "id": MODEL_ID,
            "object": "model",
            "created": 0,
            "owned_by": "hivemind",
        }],
    }


@app.get("/health")
async def health():
    return {"status": "ok", "extension_connected": extension_ws is not None}


async def _main() -> None:
    config = uvicorn.Config(app, host=HTTP_HOST, port=HTTP_PORT, log_level="info")
    server = uvicorn.Server(config)
    stop = asyncio.Event()

    import signal

    def _signal_handler():
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _signal_handler)
        except NotImplementedError:
            pass  # Windows: KeyboardInterrupt handles SIGINT

    async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
        log.info("WebSocket server started on ws://%s:%s", WS_HOST, WS_PORT)
        log.info("OpenAI-compatible API on http://%s:%s/v1", HTTP_HOST, HTTP_PORT)
        server_task = asyncio.create_task(server.serve())
        await stop.wait()
        server.should_exit = True
        try:
            await asyncio.wait_for(server_task, timeout=5)
        except asyncio.TimeoutError:
            server_task.cancel()


def start() -> None:
    """Entry point for `python tools/bridge.py`."""
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        log.info("Shut down.")


if __name__ == "__main__":
    start()
