#!/usr/bin/env python3
"""Tiny no-cache static file server for popup preview work.

Usage: python tools/dev_server.py [port] [directory]
Sends `Cache-Control: no-store` so browser-pane reloads always pick up edits.
"""
import http.server
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8901
DIR = sys.argv[2] if len(sys.argv) > 2 else "popup"


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter logs
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    handler = lambda *a, **kw: NoCacheHandler(*a, directory=DIR, **kw)
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as srv:
        print(f"Serving {DIR!r} at http://127.0.0.1:{PORT} (no-store)")
        srv.serve_forever()
