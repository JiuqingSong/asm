"""AsmPerfect 86 on the family server (port 8075): serves the built web app (dist/).

Routes besides the app's static files:
  /healthz              "ok"
  /api/v1/version       {version, commit, builtUtc}
  /api/v1/app           404: there is no Windows program to download (the family front page
                        then shows only the "open" button)
  /api/v1/backup        an empty backup (the app keeps no data on the server; everything a user
  /api/v1/backup/status writes stays in their browser), for the family backup service
Precompressed .gz files next to the assets are sent to browsers that accept gzip.
Standard library only.
"""

import io
import json
import mimetypes
import os
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("PORT", "8075"))
ROOT = Path(os.environ.get("APP_ROOT", "/app/dist")).resolve()
VERSION_FILE = Path(os.environ.get("VERSION_FILE", "/app/version.json"))

TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".woff2": "font/woff2",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

last_backup = None


def version():
    try:
        return json.loads(VERSION_FILE.read_text("utf-8"))
    except (OSError, ValueError):
        return {"version": "dev", "commit": "", "builtUtc": None}


class Handler(BaseHTTPRequestHandler):
    server_version = "AsmPerfect86"
    head_only = False

    def do_HEAD(self):
        self.head_only = True
        self.do_GET()

    def do_GET(self):
        global last_backup
        route = self.path.split("?")[0]
        if route == "/healthz":
            self._send(200, "text/plain; charset=utf-8", b"ok")
        elif route == "/api/v1/version":
            self._json(version())
        elif route == "/api/v1/app":
            self._send(404, "application/json", b'{"error":"no download: open the page instead"}')
        elif route == "/api/v1/backup":
            buffer = io.BytesIO()
            with zipfile.ZipFile(buffer, "w") as archive:
                archive.writestr("README.txt", "AsmPerfect 86 keeps no data on the server; it is rebuilt from the repo.\n")
            last_backup = datetime.now(timezone.utc)
            self._send(200, "application/zip", buffer.getvalue())
        elif route == "/api/v1/backup/status":
            when = last_backup.isoformat().replace("+00:00", "Z") if last_backup else None
            self._json({"lastBackupUtc": when, "due": False})
        else:
            self._static(route)

    def do_POST(self):
        if self.path.split("?")[0] == "/api/v1/backup":  # a restore: there is nothing to put back
            remaining = int(self.headers.get("Content-Length", "0") or "0")
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 1024 * 1024))
                if not chunk:
                    break
                remaining -= len(chunk)
            self._json({"restored": "nothing (no data kept)"})
        else:
            self._send(404, "text/plain; charset=utf-8", b"Not found")

    def _static(self, route):
        rel = "index.html" if route in ("", "/") else route.lstrip("/")
        path = (ROOT / rel).resolve()
        if ROOT not in path.parents and path != ROOT or not path.is_file():
            self._send(404, "text/plain; charset=utf-8", b"Not found")
            return
        ctype = TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        # Hashed assets never change; index.html must be checked every time so a new release shows up.
        cache = "public, max-age=31536000, immutable" if "/assets/" in route else "no-cache"
        gz = path.with_name(path.name + ".gz")
        use_gz = gz.is_file() and "gzip" in self.headers.get("Accept-Encoding", "")
        body = (gz if use_gz else path).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        if use_gz:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        if not self.head_only:
            self.wfile.write(body)

    def _json(self, value):
        self._send(200, "application/json; charset=utf-8", json.dumps(value, ensure_ascii=False).encode("utf-8"))

    def _send(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not self.head_only:
            self.wfile.write(body)

    def log_message(self, format, *args):  # quieter: only errors
        if args and str(args[1]).startswith(("4", "5")) and "/favicon" not in str(args[0]):
            super().log_message(format, *args)


if __name__ == "__main__":
    print(f"AsmPerfect 86 on port {PORT}, serving {ROOT} ({version().get('version')})", flush=True)
    ThreadingHTTPServer(("", PORT), Handler).serve_forever()
