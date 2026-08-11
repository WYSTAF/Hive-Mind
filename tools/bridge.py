#!/usr/bin/env python3
"""AI Consensus Engine — Local OpenAI-Compatible API Bridge.

Runs an HTTP/WebSocket server that:
  - Exposes /v1/chat/completions (OpenAI-compatible) on localhost:3000
  - Forwards prompts to the Chrome Extension via WebSocket (ws://127.0.0.1:8765)
  - Returns the final synthesized consensus as a standard OpenAI chat completion response.

Usage:
    pip install fastapi uvicorn websockets
    python tools/bridge.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Any

import uvicorn
import websockets
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("hivemind-bridge")

app = FastAPI(title="HiveMind Bridge", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:3000",
        "http://localhost:3000",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# WebSocket client connection to the Chrome Extension
extension_ws: websockets.WebSocketClientProtocol | None = None
ws_lock = asyncio.Lock()

# Pending requests: mapping of request_id -> asyncio.Future
pending: dict[str, asyncio.Future] = {}


class ChatCompletionRequest(BaseModel):
    model: str = "hivemind-consensus"
    messages: list[dict[str, str]] = []
    temperature: float = 0.7
    max_tokens: int | None = None
    stream: bool = False


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: list[dict[str, Any]]
    usage: dict[str, int]


async def ws_handler(ws):
    """Handle incoming WebSocket connections from the Chrome Extension."""
    global extension_ws
    log.info("Chrome Extension connected via WebSocket")
    extension_ws = ws
    try:
        async for message in ws:
            try:
                data = json.loads(message)
                req_id = data.get("request_id")
                if req_id and req_id in pending:
                    future = pending.pop(req_id)
                    future.set_result(data)
            except json.JSONDecodeError:
                log.warning("Ignoring malformed WS message: %s", message[:100])
    except Exception as exc:
        log.error("WS connection error: %s", exc)
    finally:
        if extension_ws == ws:
            extension_ws = None
        log.info("Chrome Extension disconnected")


async def send_to_extension(payload: dict) -> dict:
    """Send a message to the extension and wait for the response."""
    request_id = str(uuid.uuid4())
    payload["request_id"] = request_id
    future: asyncio.Future = asyncio.get_event_loop().create_future()
    pending[request_id] = future

    async with ws_lock:
        if extension_ws is None:
            raise ConnectionError("Extension WebSocket not connected")
        await extension_ws.send(json.dumps(payload))

    try:
        result = await asyncio.wait_for(future, timeout=60.0)
        return result
    except asyncio.TimeoutError:
        pending.pop(request_id, None)
        raise TimeoutError("Extension did not respond within 60s")


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatCompletionRequest):
    """OpenAI-compatible chat completions endpoint."""
    # Extract the last user message as the prompt
    prompt = ""
    system_prompt = ""
    for msg in req.messages:
        if msg["role"] == "system":
            system_prompt += msg["content"] + "\n"
        elif msg["role"] == "user":
            prompt = msg["content"]

    if not prompt:
        return ChatCompletionResponse(
            id="chatcmpl-hivemind-error",
            created=int(time.time()),
            model=req.model,
            choices=[{
                "index": 0,
                "message": {"role": "assistant", "content": "No user message provided."},
                "finish_reason": "stop",
            }],
            usage={"prompt_tokens": -1, "completion_tokens": -1, "total_tokens": -1},
        ).model_dump()

    try:
        result = await send_to_extension({
            "action": "start_debate",
            "prompt": prompt,
            "system_prompt": system_prompt.strip(),
            "tone": "neutral",
        })

        final_text = result.get("final_consensus", "No consensus reached.")
    except (ConnectionError, TimeoutError) as e:
        log.error("Bridge error: %s", e)
        final_text = f"[HiveMind Bridge Error] {e}"

    return ChatCompletionResponse(
        id=f"chatcmpl-hivemind-{uuid.uuid4().hex[:8]}",
        created=int(time.time()),
        model=req.model,
        choices=[{
            "index": 0,
            "message": {"role": "assistant", "content": final_text},
            "finish_reason": "stop",
        }],
        usage={"prompt_tokens": -1, "completion_tokens": -1, "total_tokens": -1},
    ).model_dump()


@app.get("/health")
async def health():
    return {"status": "ok", "extension_connected": extension_ws is not None}


def start():
    """Entry point for `python tools/bridge.py`."""
    config = uvicorn.Config(app, host="127.0.0.1", port=3000, log_level="info")
    server = uvicorn.Server(config)

    async def main():
        # Start WebSocket server on port 8765
        async with websockets.serve(ws_handler, "127.0.0.1", 8765):
            log.info("WebSocket server started on ws://127.0.0.1:8765")
            await server.serve()

    asyncio.run(main())


if __name__ == "__main__":
    start()
