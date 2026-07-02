#!/usr/bin/env python3
"""Local static server for Dust2 Explorer."""

from __future__ import annotations

import http.server
import os
import socketserver
import sys

PORT = int(os.environ.get("PORT", "8080"))
ROOT = os.path.dirname(os.path.abspath(__file__))


class ExplorerHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".glb": "model/gltf-binary",
        ".gltf": "model/gltf+json",
        ".wasm": "application/wasm",
        ".js": "application/javascript",
        ".mp3": "audio/mpeg",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, format: str, *args) -> None:
        sys.stdout.write("%s - %s\n" % (self.address_string(), format % args))


class ReuseTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


def main() -> None:
    os.chdir(ROOT)
    with ReuseTCPServer(("", PORT), ExplorerHandler) as httpd:
        print(f"Dust2 Explorer running at http://localhost:{PORT}")
        print("Press Ctrl+C to stop")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")


if __name__ == "__main__":
    main()
