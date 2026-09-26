#!/usr/bin/env python3
"""Fake extension: connects to the bridge's WS server and answers one debate.

Verifies the full bridge round-trip without Chrome:
  HTTP client -> bridge -> WS -> (this script) -> debate_complete -> HTTP client

Run while tools/bridge.py is up:
  python tools/fake_extension_test.py
"""
import asyncio
import json
import sys
import urllib.request

import websockets

WS_URL = "ws://127.0.0.1:8765"
API_URL = "http://127.0.0.1:3000/v1/chat/completions"


async def main():
    async with websockets.connect(WS_URL) as ws:
        print("[fake-ext] connected")

        # Fire the streaming HTTP request while the socket stays open.
        body = json.dumps({
            "model": "hivemind-consensus",
            "stream": True,
            "messages": [{"role": "user", "content": "round-trip"}],
        }).encode()
        http_req = urllib.request.Request(API_URL, data=body,
                                          headers={"Content-Type": "application/json"})
        loop = asyncio.get_running_loop()
        http_task = loop.run_in_executor(None, urllib.request.urlopen, http_req)

        raw = await asyncio.wait_for(ws.recv(), timeout=10)
        msg = json.loads(raw)
        assert msg["action"] == "start_debate", f"unexpected action: {msg}"
        print(f"[fake-ext] got start_debate (request_id={msg.get('request_id')}), prompt={msg['prompt']!r}")

        # Live round event (streaming clients should surface this)…
        await ws.send(json.dumps({
            "action": "debate_event",
            "kind": "round_complete",
            "round": 1,
            "responses": {"chatgpt": {"text": "pro", "score": 8}},
        }))
        await asyncio.sleep(0.2)  # let the event propagate before completion
        # …then the final answer.
        await ws.send(json.dumps({
            "action": "debate_complete",
            "request_id": msg.get("request_id"),
            "final_consensus": "FAKE CONSENSUS OK",
            "rounds": [],
        }))
        print("[fake-ext] sent round event + completion")

        resp = await asyncio.wait_for(http_task, timeout=15)
        chunks = []
        for line in resp.read().decode().splitlines():
            if line.startswith("data: ") and line != "data: [DONE]":
                d = json.loads(line[6:])
                c = d["choices"][0]["delta"].get("content")
                if c:
                    chunks.append(c)
        text = "".join(chunks)

    assert "Round 1 complete" in text, f"round event missing from stream: {text!r}"
    assert "FAKE CONSENSUS OK" in text, f"consensus missing from stream: {text!r}"
    print(f"[fake-ext] STREAM ROUND-TRIP OK: {text!r}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
