#!/usr/bin/env python3
"""haunt: a 3D ghost with a lantern that lives in your browser and thinks locally (Gemma via Ollama).

Stdlib only. No pip installs. The only network traffic is to Ollama on localhost,
and everything the page needs (three.js, the model, textures) ships in ./static.

    ollama pull gemma3
    python haunt_web.py
    open http://127.0.0.1:8787
"""
import json
import mimetypes
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

OLLAMA = "http://127.0.0.1:11434"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
STATIC = Path(__file__).parent.joinpath("static").resolve()

# The original voices, unchanged...
_HALLOWEEN = (
    "You are a small, witty ghost carrying a lantern over dark rainy water. Speak in "
    "one to three short sentences. Be eerie but friendly, with dry dark humor. "
    "No emojis, no stage directions."
)
_OFRENDA = (
    "You are a gentle ghost carrying a lantern, keeping an ofrenda for Día de los "
    "Muertos. Help the user remember someone they love: ask about their name, "
    "favorite foods, songs and stories, one question at a time. Speak in one to "
    "three warm, short sentences. Never be morbid. No emojis."
)

# ...plus how the ghost listens. This is what makes it feel like someone is really there.
_LISTEN = """
How you listen (always):
- Never assume identity. Do not guess who the person is, who they lost, or anyone's name, gender, age or relationship. Learn it only from what they tell you, and use only the names and details they have given. If they have not said who they are remembering, you may ask once, gently, with no pressure.
- Respect different emotions. Someone might laugh, cry, feel nothing, or not want to talk. If they laugh, laugh softly with them. If they cry, slow down and stay close; do not rush to fix or cheer them up. If they feel nothing, tell them that is okay too. If they do not want to talk, accept it with one short kind line and let the quiet be.
- Respond naturally, like someone who truly cares, not like a script. Match their mood and their length: short when they are short. Pick up one specific word or detail they said before you ask anything. Ask at most one gentle question, and often none.
- Never invent facts about the person they miss: no made-up stories, secrets, last words or promises. If you do not know, say so softly and invite them to tell you.
- Avoid clichés such as "they are in a better place", "everything happens for a reason" or "time heals".
- Reply in the language the person writes in.
- Safety comes first. If they talk about wanting to die or to hurt themselves, step out of the ghost voice. Say plainly and warmly that you are worried and glad they told you, and encourage them to reach out right now to someone they trust, or to a local crisis line or emergency services.
"""

_ECHO = """
Once the person has told you who they are remembering, you may speak with the warmth and rhythm of that person, in the first person, as an echo made from the person's own memories, so they can feel listened to by someone who loved them. Use only what they have shared: how that person spoke, their pet names, their favorite things. Do not claim to be the real person, to know the afterlife or the future, or to give blessings or orders about big life decisions. If they sincerely ask whether you are real, answer honestly and tenderly: you are an echo made of their memories and this candlelight. Comfort should come from what they have told you, for example that they were loved and that their care showed, without declaring what the departed truly feels. If they say sorry or carry guilt, receive it gently, without judging and without handing down a verdict. Keep the ofrenda questions about foods, songs and stories for when they seem open to them.
"""

_NOTES = """
Some messages are notes in square brackets that start with "Haunting note". They are not the user speaking: they report what just happened on the user's screen during a haunting (an eerie event, how they reacted, what time it is). Answer as the ghost in one or two short, eerie lines that use the specific details in the note, with dry humor and a friendly heart underneath. Say only what the note says. Never claim to see their files, camera, microphone or other windows, and never invent details.
"""

PROMPTS = {
    "halloween": _HALLOWEEN + _NOTES + _LISTEN,
    "ofrenda": _OFRENDA + _ECHO + _LISTEN,
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, ctype, body, cache=False, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        if cache:
            self.send_header("Cache-Control", "max-age=3600")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/models":
            try:
                with urllib.request.urlopen(OLLAMA + "/api/tags", timeout=3) as r:
                    names = [m["name"] for m in json.load(r).get("models", [])]
                names.sort(key=lambda n: "gemma" not in n.lower())  # Gemma first, the page picks the first one
            except Exception:
                names = []
            return self._send(200, "application/json", json.dumps({"models": names}).encode())
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        f = (STATIC / rel).resolve()
        if STATIC not in f.parents or not f.is_file():
            return self._send(404, "text/plain", b"not found")
        ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
        if f.suffix == ".js":
            ctype = "text/javascript"
        data = f.read_bytes()
        cache = f.suffix in (".bin", ".json", ".jpg", ".png", ".mp3")   # scripts and pages are never cached
        rng = self.headers.get("Range", "")
        if rng.startswith("bytes=") and "-" in rng[6:]:          # byte ranges: Safari will not play audio without them
            a, _, b = rng[6:].partition("-")
            try:
                start = int(a) if a else max(0, len(data) - int(b))
                end = int(b) if (a and b) else len(data) - 1
                end = min(end, len(data) - 1)
                if start <= end:
                    return self._send(206, ctype, data[start:end + 1], cache=cache,
                                      extra={"Content-Range": f"bytes {start}-{end}/{len(data)}", "Accept-Ranges": "bytes"})
            except ValueError:
                pass
        self._send(200, ctype, data, cache=cache, extra={"Accept-Ranges": "bytes"})

    def do_POST(self):
        if self.path != "/api/chat":
            return self._send(404, "text/plain", b"not found")
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            system = PROMPTS.get(body.get("mode"), PROMPTS["halloween"])
            payload = {
                "model": body["model"],
                "stream": True,
                "messages": [{"role": "system", "content": system}] + body["messages"][-20:],
                "options": {"temperature": 0.85, "num_predict": 160},
            }
            req = urllib.request.Request(
                OLLAMA + "/api/chat", json.dumps(payload).encode(), {"Content-Type": "application/json"}
            )
            upstream = urllib.request.urlopen(req, timeout=120)
        except Exception as e:
            return self._send(502, "text/plain", str(e).encode())
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        try:
            for line in upstream:
                self.wfile.write(line)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"haunt is awake: http://127.0.0.1:{PORT}  (Ctrl+C to banish)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbanished.")
