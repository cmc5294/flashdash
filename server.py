#!/usr/bin/env python3
"""Flashdash backend — stdlib only (http.server + sqlite3 + csv + urllib)."""

import csv
import io
import json
import os
import sqlite3
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

PORT = int(os.environ.get("PORT", 3000))
TEACHER_PASSWORD = os.environ.get("TEACHER_PASSWORD", "teacher123")
UNSPLASH_KEY = os.environ.get("UNSPLASH_ACCESS_KEY", "")
SPEECHIFY_KEY = os.environ.get("SPEECHIFY_API_KEY", "")
SPEECHIFY_VOICE = os.environ.get("SPEECHIFY_VOICE_ID", "george")  # override in env if desired
DB_PATH = Path(__file__).parent / "flashdash.db"
PUBLIC = Path(__file__).parent / "public"

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS decks (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                class_code  TEXT NOT NULL,
                created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );
            CREATE TABLE IF NOT EXISTS words (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                deck_id     INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                spanish     TEXT NOT NULL,
                english     TEXT NOT NULL,
                image_url   TEXT
            );
            CREATE TABLE IF NOT EXISTS image_cache (
                term        TEXT PRIMARY KEY,
                url         TEXT NOT NULL,
                cached_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );
            CREATE TABLE IF NOT EXISTS scores (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                class_code  TEXT NOT NULL,
                deck_id     INTEGER NOT NULL,
                score       INTEGER NOT NULL,
                accuracy    REAL NOT NULL,
                max_streak  INTEGER NOT NULL,
                played_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );
            CREATE TABLE IF NOT EXISTS attempts (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                score_id    INTEGER NOT NULL REFERENCES scores(id) ON DELETE CASCADE,
                name        TEXT NOT NULL,
                class_code  TEXT NOT NULL,
                spanish     TEXT NOT NULL,
                english     TEXT NOT NULL,
                chosen      TEXT,
                correct     INTEGER NOT NULL,
                seconds     REAL NOT NULL,
                played_at   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
            );
        """)


# ---------------------------------------------------------------------------
# Unsplash helper
# ---------------------------------------------------------------------------

def fetch_unsplash(term):
    if not UNSPLASH_KEY:
        return None
    url = (
        "https://api.unsplash.com/search/photos"
        f"?query={urllib.parse.quote(term)}&orientation=landscape&per_page=1"
    )
    req = urllib.request.Request(url, headers={"Authorization": f"Client-ID {UNSPLASH_KEY}"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read())
        results = data.get("results", [])
        if results:
            return results[0]["urls"]["regular"]
    except Exception as e:
        print(f"[Unsplash] {e}")
    return None


# ---------------------------------------------------------------------------
# Multipart parser (minimal — for CSV upload)
# ---------------------------------------------------------------------------

def parse_multipart(body, content_type):
    boundary = None
    for part in content_type.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            boundary = part[len("boundary="):].strip('"')
    if not boundary:
        return {}
    delimiter = ("--" + boundary).encode()
    fields = {}
    parts = body.split(delimiter)
    for chunk in parts[1:]:
        if chunk.strip() == b"--":
            break
        if b"\r\n\r\n" in chunk:
            header_part, _, value = chunk.partition(b"\r\n\r\n")
        else:
            continue
        value = value.rstrip(b"\r\n")
        headers = {}
        for line in header_part.split(b"\r\n"):
            if b":" in line:
                k, _, v = line.partition(b":")
                headers[k.strip().lower().decode()] = v.strip().decode()
        cd = headers.get("content-disposition", "")
        name = None
        for seg in cd.split(";"):
            seg = seg.strip()
            if seg.startswith("name="):
                name = seg[5:].strip('"')
        if name:
            fields[name] = value
    return fields


# ---------------------------------------------------------------------------
# Request handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{self.address_string()}] {fmt % args}")

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_csv(self, text, filename):
        body = text.encode("utf-8-sig")
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    def read_json(self):
        return json.loads(self.read_body() or b"{}")

    def teacher_auth(self):
        return self.headers.get("x-teacher-password") == TEACHER_PASSWORD

    def qs(self):
        parsed = urllib.parse.urlparse(self.path)
        return urllib.parse.parse_qs(parsed.query)

    def path_only(self):
        return urllib.parse.urlparse(self.path).path

    def serve_static(self, path):
        if path == "/":
            path = "/index.html"
        file_path = PUBLIC / path.lstrip("/")
        if not file_path.exists() or not file_path.is_file():
            self.send_response(404)
            self.end_headers()
            return
        ext = file_path.suffix.lower()
        mime = MIME.get(ext, "application/octet-stream")
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ---- GET ---------------------------------------------------------------

    def do_GET(self):
        p = self.path_only()
        if p == "/deck":
            self.api_get_deck()
        elif p == "/image":
            self.api_get_image()
        elif p == "/tts":
            self.api_get_tts()
        elif p == "/leaderboard":
            self.api_get_leaderboard()
        elif p == "/teacher/scores":
            self.api_teacher_scores()
        elif p == "/teacher/export":
            self.api_teacher_export()
        else:
            self.serve_static(p)

    def api_get_deck(self):
        qs = self.qs()
        code = (qs.get("class", [""])[0]).strip().upper()
        if not code:
            return self.send_json({"error": "class required"}, 400)
        with get_db() as db:
            deck = db.execute(
                "SELECT * FROM decks WHERE class_code=? ORDER BY id DESC LIMIT 1", (code,)
            ).fetchone()
            if not deck:
                return self.send_json({"error": "No deck found for this class code"}, 404)
            words = db.execute(
                "SELECT spanish, english, image_url FROM words WHERE deck_id=?", (deck["id"],)
            ).fetchall()
        self.send_json({
            "deckId": deck["id"],
            "classCode": code,
            "words": [dict(w) for w in words],
        })

    def api_get_image(self):
        qs = self.qs()
        term = (qs.get("term", [""])[0]).strip().lower()
        if not term:
            return self.send_json({"error": "term required"}, 400)
        with get_db() as db:
            cached = db.execute("SELECT url FROM image_cache WHERE term=?", (term,)).fetchone()
            if cached:
                return self.send_json({"url": cached["url"]})
        url = fetch_unsplash(term)
        if url:
            with get_db() as db:
                db.execute("INSERT OR REPLACE INTO image_cache (term, url) VALUES (?,?)", (term, url))
        self.send_json({"url": url})

    def api_get_tts(self):
        import base64
        qs = self.qs()
        text = (qs.get("text", [""])[0]).strip()
        if not text:
            return self.send_json({"error": "text required"}, 400)
        if not SPEECHIFY_KEY:
            return self.send_json({"error": "no_key"}, 503)

        payload = json.dumps({
            "input": text,
            "voice_id": SPEECHIFY_VOICE,
            "audio_format": "mp3",
            "model": "simba-multilingual",
        }).encode()

        req = urllib.request.Request(
            "https://api.speechify.ai/v1/audio/speech",
            data=payload,
            headers={
                "Authorization": f"Bearer {SPEECHIFY_KEY}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=8) as r:
                data = json.loads(r.read())
            audio = base64.b64decode(data["audio_data"])
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.end_headers()
            self.wfile.write(audio)
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")
            print(f"[Speechify] HTTP {e.code}: {body}")
            self.send_json({"error": f"Speechify error {e.code}"}, 502)
        except Exception as e:
            print(f"[Speechify] {e}")
            self.send_json({"error": "TTS unavailable"}, 502)

    def api_get_leaderboard(self):
        qs = self.qs()
        code = (qs.get("class", [""])[0]).strip().upper()
        if not code:
            return self.send_json({"error": "class required"}, 400)
        with get_db() as db:
            rows = db.execute("""
                SELECT name, MAX(score) as score, accuracy, max_streak
                FROM scores WHERE class_code=?
                GROUP BY name ORDER BY score DESC LIMIT 50
            """, (code,)).fetchall()
        self.send_json({"entries": [dict(r) for r in rows]})

    def api_teacher_scores(self):
        if not self.teacher_auth():
            return self.send_json({"error": "Unauthorized"}, 401)
        qs = self.qs()
        code = (qs.get("class", [""])[0]).strip().upper()
        if not code:
            return self.send_json({"error": "class required"}, 400)
        with get_db() as db:
            rounds = db.execute("""
                SELECT id, name, score, accuracy, max_streak,
                       datetime(played_at,'unixepoch','localtime') as played_at
                FROM scores WHERE class_code=? ORDER BY played_at DESC
            """, (code,)).fetchall()
            # per-card stats: wrong answer counts per word
            wrong = db.execute("""
                SELECT spanish, english, COUNT(*) as wrong_count
                FROM attempts
                WHERE class_code=? AND correct=0
                GROUP BY spanish, english
                ORDER BY wrong_count DESC
            """, (code,)).fetchall()
        self.send_json({
            "rounds": [dict(r) for r in rounds],
            "mostMissed": [dict(w) for w in wrong],
        })

    def api_teacher_export(self):
        if not self.teacher_auth():
            return self.send_json({"error": "Unauthorized"}, 401)
        qs = self.qs()
        code = (qs.get("class", [""])[0]).strip().upper()
        export_type = (qs.get("type", ["rounds"])[0])
        if not code:
            return self.send_json({"error": "class required"}, 400)

        buf = io.StringIO()
        writer = csv.writer(buf)

        if export_type == "attempts":
            writer.writerow(["Student", "Spanish", "English", "Their Answer", "Correct?", "Seconds", "Played At"])
            with get_db() as db:
                rows = db.execute("""
                    SELECT name, spanish, english, chosen, correct, seconds,
                           datetime(played_at,'unixepoch','localtime') as played_at
                    FROM attempts WHERE class_code=?
                    ORDER BY played_at DESC, name
                """, (code,)).fetchall()
            for r in rows:
                writer.writerow([
                    r["name"], r["spanish"], r["english"],
                    r["chosen"] or "(time out)",
                    "Yes" if r["correct"] else "No",
                    f"{r['seconds']:.1f}",
                    r["played_at"],
                ])
        else:
            writer.writerow(["Student", "Score", "Accuracy %", "Best Streak", "Played At"])
            with get_db() as db:
                rows = db.execute("""
                    SELECT name, score, accuracy, max_streak,
                           datetime(played_at,'unixepoch','localtime') as played_at
                    FROM scores WHERE class_code=?
                    ORDER BY played_at DESC
                """, (code,)).fetchall()
            for r in rows:
                writer.writerow([
                    r["name"], r["score"],
                    f"{round(r['accuracy']*100)}%",
                    r["max_streak"], r["played_at"],
                ])

        filename = f"flashdash_{code}_{export_type}.csv"
        self.send_csv(buf.getvalue(), filename)

    # ---- POST --------------------------------------------------------------

    def do_POST(self):
        p = self.path_only()
        if p == "/score":
            self.api_post_score()
        elif p == "/attempt":
            self.api_post_attempt()
        elif p == "/deck":
            self.api_post_deck()
        elif p == "/leaderboard/reset":
            self.api_post_reset()
        elif p == "/teacher/auth":
            self.api_teacher_auth()
        else:
            self.send_json({"error": "not found"}, 404)

    def api_post_score(self):
        body = self.read_json()
        name = str(body.get("name", "")).strip()
        code = str(body.get("classCode", "")).strip().upper()
        deck_id = body.get("deckId")
        score = body.get("score", 0)
        accuracy = body.get("accuracy", 0)
        max_streak = body.get("maxStreak", 0)
        if not name or not code or deck_id is None:
            return self.send_json({"error": "Missing fields"}, 400)
        with get_db() as db:
            cur = db.execute(
                "INSERT INTO scores (name,class_code,deck_id,score,accuracy,max_streak) VALUES (?,?,?,?,?,?)",
                (name, code, deck_id, score, accuracy, max_streak),
            )
            score_id = cur.lastrowid
        self.send_json({"ok": True, "scoreId": score_id})

    def api_post_attempt(self):
        body = self.read_json()
        score_id = body.get("scoreId")
        name = str(body.get("name", "")).strip()
        code = str(body.get("classCode", "")).strip().upper()
        spanish = str(body.get("spanish", "")).strip()
        english = str(body.get("english", "")).strip()
        chosen = body.get("chosen")
        correct = 1 if body.get("correct") else 0
        seconds = float(body.get("seconds", 0))
        if not (score_id and name and code and spanish and english):
            return self.send_json({"error": "Missing fields"}, 400)
        with get_db() as db:
            db.execute(
                "INSERT INTO attempts (score_id,name,class_code,spanish,english,chosen,correct,seconds) VALUES (?,?,?,?,?,?,?,?)",
                (score_id, name, code, spanish, english, chosen, correct, seconds),
            )
        self.send_json({"ok": True})

    def api_post_deck(self):
        if not self.teacher_auth():
            return self.send_json({"error": "Unauthorized"}, 401)
        ct = self.headers.get("Content-Type", "")
        body = self.read_body()
        fields = parse_multipart(body, ct)
        code = fields.get("classCode", b"").decode().strip().upper()
        csv_bytes = fields.get("csv", b"")
        if not code:
            return self.send_json({"error": "classCode required"}, 400)
        if not csv_bytes:
            return self.send_json({"error": "csv file required"}, 400)

        try:
            text = csv_bytes.decode("utf-8-sig")
            reader = csv.DictReader(io.StringIO(text))
            valid, errors = [], []
            for i, row in enumerate(reader):
                spanish = (row.get("spanish") or "").strip()
                english = (row.get("english") or "").strip()
                image_url = (row.get("image_url") or "").strip() or None
                if not spanish or not english:
                    errors.append(f"Row {i+2}: missing spanish or english")
                    continue
                valid.append((spanish, english, image_url))
        except Exception as e:
            return self.send_json({"error": f"CSV parse error: {e}"}, 400)

        if len(valid) < 4:
            return self.send_json({"error": "Need at least 4 valid words", "errors": errors}, 400)

        with get_db() as db:
            cur = db.execute("INSERT INTO decks (class_code) VALUES (?)", (code,))
            deck_id = cur.lastrowid
            db.executemany(
                "INSERT INTO words (deck_id, spanish, english, image_url) VALUES (?,?,?,?)",
                [(deck_id, s, e, u) for s, e, u in valid],
            )
        self.send_json({"ok": True, "words": len(valid), "errors": errors})

    def api_post_reset(self):
        if not self.teacher_auth():
            return self.send_json({"error": "Unauthorized"}, 401)
        body = self.read_json()
        code = str(body.get("classCode", "")).strip().upper()
        if not code:
            return self.send_json({"error": "classCode required"}, 400)
        with get_db() as db:
            db.execute("DELETE FROM scores WHERE class_code=?", (code,))
        self.send_json({"ok": True})

    def api_teacher_auth(self):
        body = self.read_json()
        ok = body.get("password") == TEACHER_PASSWORD
        self.send_json({"ok": ok})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    init_db()
    server = HTTPServer(("", PORT), Handler)
    print(f"✅ Flashdash running at http://localhost:{PORT}")
    print(f"   Teacher password: {TEACHER_PASSWORD}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
