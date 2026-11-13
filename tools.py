"""Tool surface for the Hermes Live Video relay.

One tool, five actions, so the prompt cost stays to a single schema:

  start       — launch the relay (if not already up) and return the URL to open
  stop        — stop a relay this plugin started
  url         — the address to open on the phone, plus health
  status      — is the relay healthy, is the unit up, are trackers running
  session     — structured view of the last N transcript lines (counts + rows)
  checks      — how the watch verifier behaved: triggers, verdicts, latencies

The relay is a Node service with its own lifecycle. `start`/`stop` manage a
process this plugin spawned itself (pid file in the state directory); a relay
installed as a systemd service is left to systemd, and `stop` says so rather
than killing someone's unit. Nothing here joins the relay's media path.

The Gemini key is read through Hermes' secret scope and handed to the child in
its environment; the plugin never writes it to disk and never reads another
application's credential file.

Every path is configurable through plugins.entries.live-video, and every handler
returns JSON rather than raising, so a missing log reads as a stated error and
not as an agent-visible traceback.
"""

import datetime as dt
import json
import os
import re
import secrets
import shutil
import signal
import socket
import statistics
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

TOOLSET = "live-video"

# Windows needs a different spawn and kill shape, not merely different paths:
# `start_new_session` and the POSIX signals do not exist there, `os.kill(pid, 0)`
# is not a liveness probe (on Windows it *terminates* the process), and killing
# node alone would leave the Python tracker orphaned. Kept as module-level flags
# so a test can exercise both branches on any host.
IS_WINDOWS = os.name == "nt"
CREATE_NEW_PROCESS_GROUP = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
DETACHED_PROCESS = getattr(subprocess, "DETACHED_PROCESS", 0x00000008)

# The plugin directory *is* the relay: plugin.yaml, server.js and public/ ship
# together in one reviewed tree, so a catalogue install runs the code the
# catalogue pinned rather than reaching for a checkout that may not exist.
PLUGIN_DIR = Path(__file__).resolve().parent

DEFAULT_CONFIG = {
    # Empty means "this plugin's own directory". Set relay_dir only to run the
    # plugin's tool surface against a separate checkout.
    "relay_dir": "",
    "port": 8098,
    # Loopback by default. A LAN bind is opt-in and is gated by a per-start
    # token, because anything routable to the port can otherwise open the page.
    "bind": "127.0.0.1",
    "unit": "hermes-live-video",
    "node_bin": "",
    "default_lines": 40,
    "max_lines": 200,
    "window_s": 90,
}

WATCH_STATE = {
    "WATCH_ARMED": "armed",
    "WATCH_REARMED": "armed",
    "WATCH_FIRED": "fired",
    "WATCH_EXPIRED": "expired",
}

TAGS = (
    "USER", "JARVIS", "VISION_EVENT", "WATCH_ARMED", "WATCH_FIRED",
    "WATCH_EXPIRED", "WATCH_REARMED", "AUDIO_START", "AUDIO_ABSENT",
    "CLIENT_HEALTH",
)

TRANSCRIPT_RE = re.compile(r"^\[(?P<ts>[^\]]+)\]\s+(?P<rest>.*)$")
CHECK_RE = re.compile(
    r"watch check (?P<n>\d+) \((?P<trigger>[^)]+)\): (?P<verdict>VISIBLE|not yet|verifier unavailable|pre-empted|rate limited)"
    r"(?: — (?P<model>[\w.\-]+) (?P<ms>\d+)ms)?"
)
# The relay stamps every check into the transcript as well as stdout, because
# server.log carries no clocks: without a stamp, checks from different sessions
# cannot be attributed to the window they belong to.
WATCH_CHECK_RE = re.compile(
    r"WATCH_CHECK: n=(?P<n>\d+) trigger=(?P<trigger>.+?) verdict=(?P<verdict>visible|not_yet|unavailable|rate_limited|pre_empted)"
    r" model=(?P<model>\S+) ms=(?P<ms>\d+)"
)
VERDICT_WORDS = {
    "visible": "VISIBLE",
    "not_yet": "not yet",
    "unavailable": "verifier unavailable",
    "rate_limited": "rate limited",
    "pre_empted": "pre-empted",
}
ARMED_RE = re.compile(r"watch armed for (?P<window>\d+)s: (?P<sentence>.+)$")
# The transcript spells it differently and carries no window length: the window
# comes from configuration, which is what armed it in the first place.
TRANSCRIPT_ARMED_RE = re.compile(r"^WATCH_ARMED: (?P<sentence>.+)$")
ENDED_RE = re.compile(r"watch ended without a sighting: (?P<reason>.+)$")

SCHEMA = {
    "name": "live_video",
    "description": (
        "Run and inspect the Hermes Live Video relay: a phone camera conversation with the "
        "agent on port 8098. start launches it and returns the URL to open; url reports that "
        "URL and health; status reports relay health and unit state; session replays the recent "
        "transcript of a live session; checks shows how the watch verifier behaved."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["start", "stop", "url", "status", "session", "checks"],
                "description": "start = launch the relay and return its URL; stop = stop a relay this plugin started; url = the phone URL plus health; status = health and unit state; session = transcript counts and rows; checks = verifier behaviour",
            },
            "lines": {
                "type": "integer",
                "description": "For session: how many transcript lines to read back (default 40).",
            },
            "since": {
                "type": "string",
                "description": "For checks: ISO-8601 timestamp; only watch windows at or after it are returned.",
            },
        },
        "required": ["action"],
    },
}


# --- configuration ----------------------------------------------------------

def hermes_home():
    """Hermes' own notion of its home, so paths agree with the running agent."""
    try:
        from hermes_constants import get_hermes_home  # public constant
        return Path(get_hermes_home())
    except Exception:
        return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))


def _load_config_file():
    """Read plugins.entries.live-video through Hermes' own config loader.

    Reading config.yaml directly meant a second YAML parser and a second idea of
    where the home is; the loader is the same view the agent itself sees, so a
    profile-relative config resolves the way the user expects. A bare interpreter
    (importable failure) falls back to the same default entry.
    """
    try:
        from hermes_cli.config import load_config
        data = load_config() or {}
        entry = ((data.get("plugins") or {}).get("entries") or {}).get("live-video") or {}
        return entry if isinstance(entry, dict) else {}
    except Exception:
        return {}


def config():
    cfg = dict(DEFAULT_CONFIG)
    cfg.update({k: v for k, v in _load_config_file().items() if k in DEFAULT_CONFIG})
    # Environment overrides keep the tests hermetic without touching config.yaml.
    if os.environ.get("LIVE_VIDEO_RELAY_DIR"):
        cfg["relay_dir"] = os.environ["LIVE_VIDEO_RELAY_DIR"]
    if os.environ.get("LIVE_VIDEO_PORT"):
        cfg["port"] = int(os.environ["LIVE_VIDEO_PORT"])
    return cfg


def _relay_dir(cfg):
    value = str(cfg.get("relay_dir") or "").strip()
    if not value:
        return PLUGIN_DIR
    return Path(os.path.expanduser(os.path.expandvars(value)))


def _no_relay(path, what):
    """A missing relay is a configuration instruction, not a mystery."""
    return (
        f"no {what} at {path} — set relay_dir under plugins.entries.live-video "
        f"(or LIVE_VIDEO_RELAY_DIR) to your hermes-live-video checkout"
    )


# --- relay lifecycle ---------------------------------------------------------

def _state_dir():
    d = Path(
        os.environ.get("LIVE_VIDEO_STATE_DIR")
        or (hermes_home() / "plugin-data" / "live-video")
    )
    d.mkdir(parents=True, exist_ok=True)
    return d


def _pid_file():
    return _state_dir() / "relay.pid"


def _log_file():
    return _state_dir() / "relay.log"


def _probe(port, timeout=1.0):
    """The relay's own health endpoint, or None when nothing is listening."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=timeout) as r:
            return json.loads(r.read().decode() or "{}")
    except Exception:
        return None


def _lan_ip():
    """Best-effort LAN address, so the phone knows where to point."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        pass
    try:
        return socket.gethostbyname(socket.gethostname())
    except Exception:
        return "127.0.0.1"


LOOPBACK_BINDS = ("127.0.0.1", "::1", "localhost")

# Only what the relay needs. Inheriting the whole agent environment would hand
# every other provider key and hermetic test variable to a child process that
# only needs to talk to Gemini and start a tracker.
ENV_ALLOW_KEYS = {"PATH", "HOME", "LANG", "LC_ALL", "TZ", "PYTHON_BIN", "NODE_ENV"}
ENV_ALLOW_PREFIXES = ("LIVE_", "WATCH_")


def _token_file():
    return _state_dir() / "relay.token"


def _current_token():
    try:
        return _token_file().read_text().strip()
    except Exception:
        return ""


def _urls(port, token="", bind="127.0.0.1"):
    query = f"?token={urllib.parse.quote(token)}" if token else ""
    urls = {"local": f"http://127.0.0.1:{port}/{query}"}
    urls["lan"] = None if bind in LOOPBACK_BINDS else f"http://{_lan_ip()}:{port}/{query}"
    return urls


def _child_env(key, port, bind, token, relay):
    env = {
        k: v for k, v in os.environ.items()
        if k in ENV_ALLOW_KEYS or k.startswith(ENV_ALLOW_PREFIXES)
    }
    env.update({
        "GEMINI_API_KEY": key,
        "PORT": str(port),
        "HOST": bind,
        "LIVE_RELAY_DIR": str(relay),
    })
    if token:
        env["LIVE_TOKEN"] = token
    return env


def _node_candidates(cfg):
    home = Path.home()
    candidates = [
        cfg.get("node_bin") or "",
        os.environ.get("NODE_BIN") or "",
        shutil.which("node") or "",
        shutil.which("node.exe") or "",
        str(home / ".hermes" / "node" / "bin" / "node"),
        str(home / ".hermes" / "node" / "node.exe"),
        os.path.expandvars(r"%ProgramFiles%\nodejs\node.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\nodejs\node.exe"),
    ]
    return candidates


def _node_bin(cfg):
    for c in _node_candidates(cfg):
        if c and Path(c).exists():
            return c
    return None


def _api_key():
    """The Gemini key, through Hermes' secret scope rather than the environment."""
    try:
        from agent.secret_scope import get_secret  # public plugin API
        value = get_secret("GEMINI_API_KEY")
        if value:
            return value.strip(), "hermes secret scope"
        return None, "not set in the active profile"
    except Exception as exc:
        return None, f"secret scope unavailable ({exc.__class__.__name__})"


def _win_pid_alive(pid):
    """Liveness on Windows, where os.kill(pid, 0) would terminate the process."""
    import ctypes
    from ctypes import wintypes

    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _pid_alive(pid, windows=None):
    if (IS_WINDOWS if windows is None else windows):
        try:
            return _win_pid_alive(pid)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _spawn_kwargs(windows=None):
    """Detach the relay so it outlives the tool call, by the platform's own means."""
    if IS_WINDOWS if windows is None else windows:
        return {"creationflags": CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS}
    return {"start_new_session": True}


def _terminate(pid, windows=None):
    """Stop the relay and whatever it spawned.

    On POSIX SIGTERM is enough because the relay's children die with it; on
    Windows a bare termination leaves the Python tracker running, so the tree
    is killed explicitly.
    """
    win = IS_WINDOWS if windows is None else windows
    if win:
        subprocess.run(
            ["taskkill", "/PID", str(int(pid)), "/T", "/F"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            check=False, timeout=30,
        )
        return
    os.kill(pid, signal.SIGTERM)


def _log_tail(path, lines=12):
    try:
        return "\n".join(path.read_text(errors="replace").splitlines()[-lines:])
    except Exception:
        return ""


def handle_url(args, **_kw):
    cfg = config()
    port = cfg["port"]
    bind = str(cfg.get("bind") or "127.0.0.1")
    token = "" if bind in LOOPBACK_BINDS else _current_token()
    health = _probe(port)
    return json.dumps({
        "ok": health is not None,
        "action": "url",
        "port": port,
        "bind": bind,
        "token_required": bool(token),
        "urls": _urls(port, token, bind),
        "health": health,
    }, ensure_ascii=False)


def handle_start(args, **_kw):
    cfg = config()
    port = cfg["port"]
    bind = str(cfg.get("bind") or "127.0.0.1")
    # A non-loopback bind is everyone on the network, so it carries a token that
    # exists only for this run and is handed back in the URL.
    token = "" if bind in LOOPBACK_BINDS else secrets.token_urlsafe(24)
    urls = _urls(port, token, bind)

    health = _probe(port)
    if health:
        return json.dumps({
            "ok": True, "action": "start", "already_running": True,
            "port": port, "urls": urls, "health": health,
        }, ensure_ascii=False)

    relay = _relay_dir(cfg)
    if not (relay / "server.js").exists():
        return json.dumps({"ok": False, "action": "start", "error": _no_relay(relay, "relay checkout")})

    key, key_source = _api_key()
    if not key:
        return json.dumps({
            "ok": False, "action": "start",
            "error": (
                f"GEMINI_API_KEY is {key_source} — set it for this Hermes profile "
                f"(hermes secrets set GEMINI_API_KEY, or in the profile's .env), then retry"
            ),
        })

    node = _node_bin(cfg)
    if not node:
        return json.dumps({
            "ok": False, "action": "start",
            "error": "no node binary found — install Node.js, or set node_bin under plugins.entries.live-video",
        })

    log = _log_file()
    env = _child_env(key, port, bind, token, relay)
    if token:
        _token_file().write_text(token)
        try:
            _token_file().chmod(0o600)
        except Exception:
            pass
    try:
        with open(log, "ab") as fh:
            proc = subprocess.Popen(
                [node, "server.js"],
                cwd=str(relay),
                env=env,
                stdout=fh,
                stderr=fh,
                stdin=subprocess.DEVNULL,
                **_spawn_kwargs(),
            )
    except Exception as exc:
        return json.dumps({"ok": False, "action": "start", "error": f"could not spawn the relay: {exc}"})

    _pid_file().write_text(str(proc.pid))

    # The relay resolves a Python interpreter and starts the tracker at boot, so
    # allow a generous window before calling it a failure.
    for _ in range(60):
        time.sleep(0.5)
        health = _probe(port)
        if health:
            return json.dumps({
                "ok": True, "action": "start", "pid": proc.pid, "port": port,
                "bind": bind, "token_required": bool(token),
                "urls": urls, "health": health, "log": str(log),
            }, ensure_ascii=False)
        if proc.poll() is not None:
            return json.dumps({
                "ok": False, "action": "start",
                "error": f"relay exited with code {proc.returncode}",
                "log_tail": _log_tail(log),
            })

    return json.dumps({
        "ok": False, "action": "start",
        "error": f"relay did not answer /healthz within 30s (pid {proc.pid})",
        "log_tail": _log_tail(log),
    })


def handle_stop(args, **_kw):
    cfg = config()
    port = cfg["port"]
    pid_path = _pid_file()

    if not pid_path.exists():
        health = _probe(port)
        return json.dumps({
            "ok": False, "action": "stop",
            "error": (
                "no relay started by this plugin — if it runs as a service, stop that instead "
                f"({cfg.get('unit')} via systemctl --user stop)"
            ) if health else "nothing to stop: the relay is not running",
        })

    try:
        pid = int(pid_path.read_text().strip())
    except Exception:
        pid_path.unlink(missing_ok=True)
        return json.dumps({"ok": False, "action": "stop", "error": "pid file was unreadable; removed it"})

    if not _pid_alive(pid):
        pid_path.unlink(missing_ok=True)
        _token_file().unlink(missing_ok=True)
        return json.dumps({"ok": True, "action": "stop", "stopped": False, "note": f"pid {pid} was already gone"})

    try:
        _terminate(pid)
    except Exception as exc:
        return json.dumps({"ok": False, "action": "stop", "error": f"could not stop pid {pid}: {exc}"})

    for _ in range(20):
        time.sleep(0.5)
        if not _pid_alive(pid):
            pid_path.unlink(missing_ok=True)
            _token_file().unlink(missing_ok=True)
            return json.dumps({"ok": True, "action": "stop", "stopped": True, "pid": pid})
    return json.dumps({
        "ok": False, "action": "stop",
        "error": f"pid {pid} still alive 10s after the stop signal",
    })


def _tail(path, lines):
    """Last N lines without loading a large log into memory."""
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        size = fh.tell()
        block = min(size, max(64 * 1024, lines * 400))
        fh.seek(size - block)
        data = fh.read().decode("utf-8", "replace")
    return data.splitlines()[-lines:]


# --- actions ----------------------------------------------------------------

def _health(cfg):
    url = f"http://127.0.0.1:{cfg['port']}/healthz"
    try:
        with urllib.request.urlopen(url, timeout=2.5) as resp:
            return {"reachable": True, "body": json.loads(resp.read().decode() or "{}")}
    except urllib.error.URLError as exc:
        return {"reachable": False, "error": str(exc.reason)}
    except Exception as exc:  # noqa: BLE001 - report, never raise to the agent
        return {"reachable": False, "error": f"{type(exc).__name__}: {exc}"}


def _unit_state(cfg):
    try:
        out = subprocess.run(
            ["systemctl", "--user", "show", cfg["unit"],
             "-p", "ActiveState", "-p", "SubState", "-p", "NRestarts"],
            capture_output=True, text=True, timeout=5,
        )
        fields = {}
        for line in out.stdout.splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                fields[key] = value
        return {
            "active_state": fields.get("ActiveState"),
            "sub_state": fields.get("SubState"),
            "restarts": int(fields.get("NRestarts") or 0),
        }
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}


def _trackers():
    try:
        out = subprocess.run(["pgrep", "-fc", "vision_tracker.py"], capture_output=True, text=True, timeout=5)
        return int((out.stdout or "0").strip() or 0)
    except Exception:
        return None


def _parse_ts(value):
    """Parse the relay's ISO-8601 UTC stamps into epoch seconds, or None."""
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _watch_summary(rows, cfg, session_live):
    """What the watch is doing, derived from the last WATCH_* event.

    A bare boolean was wrong in practice: after a watch expired on session end the
    last twelve lines still contained WATCH_ARMED, so status claimed a watch was
    armed when none was. Ordering plus age plus a live session is the honest test.
    """
    last = None
    for row in rows:
        if row["tag"] in WATCH_STATE:
            last = row
    if last is None:
        return {"state": "none", "armed": False, "sentence": None, "since": None, "age_s": None}
    state = WATCH_STATE[last["tag"]]
    started = _parse_ts(last["ts"])
    age = None if started is None else max(0.0, dt.datetime.now(dt.timezone.utc).timestamp() - started)
    armed = (
        state == "armed"
        and bool(session_live)
        and age is not None
        and age <= cfg["window_s"]
    )
    return {
        "state": state,
        "armed": armed,
        # Only an armed watch has a request sentence; on FIRED/EXPIRED the same
        # field in the transcript holds a reason or a receipt, so do not pass it
        # off as the request.
        "sentence": last["text"] if state == "armed" else None,
        "last_event_text": last["text"],
        "since": last["ts"],
        "age_s": round(age, 1) if age is not None else None,
        "session_live": bool(session_live),
    }


def handle_status(args, **_kw):
    cfg = config()
    relay = _relay_dir(cfg)
    transcript = relay / "transcript.log"
    trackers = _trackers()
    result = {
        "ok": True,
        "action": "status",
        "relay_dir": str(relay),
        "port": cfg["port"],
        "health": _health(cfg),
        "unit": _unit_state(cfg),
        "vision_trackers_running": trackers,
        "transcript": {
            "path": str(transcript),
            "exists": transcript.exists(),
            "bytes": transcript.stat().st_size if transcript.exists() else None,
        },
    }
    if transcript.exists():
        rows = [_parse_line(ln) for ln in _tail(transcript, 60) if ln.strip()]
        result["last_event"] = rows[-1] if rows else None
        result["watch"] = _watch_summary(rows, cfg, trackers)
        result["watch_armed"] = result["watch"]["armed"]
    else:
        result["watch"] = {"state": "unknown", "armed": False}
        result["watch_armed"] = False
        result["relay_present"] = relay.is_dir()
        result["hint"] = _no_relay(relay, "transcript")
    return json.dumps(result, ensure_ascii=False)


def _parse_line(line):
    m = TRANSCRIPT_RE.match(line)
    if not m:
        return {"ts": None, "tag": "UNPARSED", "text": line.strip()}
    rest = m.group("rest")
    tag = rest.split(":", 1)[0].strip() if ":" in rest else rest.split(" ", 1)[0].strip()
    if tag not in TAGS:
        tag = "OTHER"
    text = rest[len(tag) + 1:].strip() if rest.startswith(tag) else rest
    return {"ts": m.group("ts"), "tag": tag, "text": text}


def handle_session(args, **_kw):
    cfg = config()
    wanted = args.get("lines") or cfg["default_lines"]
    try:
        wanted = max(1, min(int(wanted), cfg["max_lines"]))
    except (TypeError, ValueError):
        wanted = cfg["default_lines"]
    path = _relay_dir(cfg) / "transcript.log"
    if not path.exists():
        return json.dumps({"ok": False, "action": "session", "error": _no_relay(path, "transcript")})
    rows = [_parse_line(ln) for ln in _tail(path, wanted) if ln.strip()]
    counts = {}
    for row in rows:
        counts[row["tag"]] = counts.get(row["tag"], 0) + 1
    return json.dumps({
        "ok": True,
        "action": "session",
        "lines_read": len(rows),
        "window": {"from": rows[0]["ts"] if rows else None, "to": rows[-1]["ts"] if rows else None},
        "counts": counts,
        "watch_events": [r for r in rows if r["tag"].startswith("WATCH_")],
        "user_turns": [r["text"] for r in rows if r["tag"] == "USER"],
        "jarvis_turns": [r["text"] for r in rows if r["tag"] == "JARVIS"],
        "rows": rows,
    }, ensure_ascii=False)


def _summarise(items):
    latencies = [c["ms"] for c in items if c.get("ms")]
    return {
        "checks": len(items),
        # The individual receipts stay available: which transport answered each
        # check is the difference between a live verdict and a paid REST call.
        "events": [dict(c) for c in items],
        "visible": sum(1 for c in items if c["verdict"] == "VISIBLE"),
        "not_yet": sum(1 for c in items if c["verdict"] == "not yet"),
        "verifier_unavailable": sum(1 for c in items if c["verdict"] == "verifier unavailable"),
        "pre_empted": sum(1 for c in items if c["verdict"] == "pre-empted"),
        "rate_limited": sum(1 for c in items if c["verdict"] == "rate limited"),
        "by_trigger": {t: sum(1 for c in items if c["trigger"] == t) for t in sorted({c["trigger"] for c in items})},
        "latency_ms": {
            "count": len(latencies),
            "min": min(latencies) if latencies else None,
            "median": statistics.median(latencies) if latencies else None,
            "max": max(latencies) if latencies else None,
        },
    }


def _stamp_of(line):
    """The line's ISO stamp, if it has one. server.log lines start '[live-video]'."""
    if not (line.startswith("[") and "]" in line):
        return None
    candidate = line[1:line.index("]")]
    return candidate if _parse_ts(candidate) is not None else None


def _normal(text):
    return re.sub(r"[^a-z0-9 ]", " ", (text or "").lower()).split()


def _transcript_watch_stamps(cfg):
    """Transcript timestamps for each armed watch, keyed by the sentence.

    server.log carries no clocks — the unit's stdout has no timestamp prefix — so
    transcript.log is what dates a window. Matching is by normalised text with
    containment either way, because the two logs quote the same utterance and a
    window whose transcript line was excised should stay undated rather than be
    dated by position.
    """
    path = _relay_dir(cfg) / "transcript.log"
    if not path.exists():
        return []
    armed = []
    for line in _tail(path, 400):
        row = _parse_line(line)
        if row["tag"] in ("WATCH_ARMED", "WATCH_REARMED"):
            armed.append((row["ts"], _normal(row["text"])))
    return armed


def _match_stamp(sentence, armed):
    needle = _normal(sentence)
    if not needle:
        return None
    for index, (stamp, words) in enumerate(armed):
        shorter, longer = (needle, words) if len(needle) <= len(words) else (words, needle)
        if not shorter:
            continue
        joined_long = " " + " ".join(longer) + " "
        if " " + " ".join(shorter) + " " in joined_long:
            armed.pop(index)
            return stamp
    return None


def _checks_from_transcript(cfg):
    """Watch windows and their checks, read from the timestamped transcript.

    Returns [] when the relay has not written any WATCH_CHECK lines (older runs,
    or a relay predating that line), so the caller can fall back to server.log.
    """
    path = _relay_dir(cfg) / "transcript.log"
    if not path.exists():
        return []
    windows = []
    current = None
    for line in _tail(path, 4000):
        m = TRANSCRIPT_RE.match(line.strip())
        if not m:
            continue
        stamp, rest = m.group("ts"), m.group("rest")
        armed = ARMED_RE.search(rest) or TRANSCRIPT_ARMED_RE.search(rest)
        if armed:
            sentence = armed.groupdict().get("sentence")
            window = armed.groupdict().get("window")
            current = {
                "armed_at": stamp,
                "sentence": (sentence or "").strip() or None,
                "window_s": int(window) if window else int(cfg.get("window_s") or 90),
                "checks": [],
                "outcome": "open",
            }
            windows.append(current)
            continue
        check = WATCH_CHECK_RE.search(rest)
        if check:
            if current is None:
                current = {"armed_at": None, "sentence": None, "window_s": None, "checks": [], "outcome": "unattributed"}
                windows.append(current)
            model = check.group("model")
            ms = int(check.group("ms"))
            current["checks"].append({
                "ts": stamp,
                "n": int(check.group("n")),
                "trigger": check.group("trigger"),
                "verdict": VERDICT_WORDS.get(check.group("verdict"), check.group("verdict")),
                "model": None if model in ("none", "-") else model,
                "ms": ms or None,
            })
            continue
        if rest.startswith("WATCH_FIRED") and current is not None:
            current["outcome"] = "sighted"
            continue
        if rest.startswith("WATCH_EXPIRED") and current is not None:
            reason = rest.split(":", 1)[1].strip() if ":" in rest else "window ended"
            current["outcome"] = f"ended: {reason}"
    return windows


def _windows_from_server_log(path):
    """Fallback: rebuild windows from stdout, which carries no clocks."""
    windows = []
    current = None
    for line in _tail(path, 4000):
        stamp = _stamp_of(line)
        m = ARMED_RE.search(line)
        if m:
            current = {
                "armed_at": stamp,
                "sentence": m.group("sentence").strip(),
                "window_s": int(m.group("window")),
                "checks": [],
                "outcome": "open",
            }
            windows.append(current)
            continue
        m = CHECK_RE.search(line)
        if m:
            if current is None:
                current = {"armed_at": None, "sentence": None, "window_s": None, "checks": [], "outcome": "unattributed"}
                windows.append(current)
            current["checks"].append({
                "ts": stamp,
                "n": int(m.group("n")),
                "trigger": m.group("trigger"),
                "verdict": m.group("verdict"),
                "model": m.group("model"),
                "ms": int(m.group("ms")) if m.group("ms") else None,
            })
            continue
        if "watch sighted" in line and current is not None:
            current["outcome"] = "sighted"
            continue
        m = ENDED_RE.search(line)
        if m and current is not None:
            current["outcome"] = f"ended: {m.group('reason').strip()}"
    return windows


def handle_checks(args, **_kw):
    """Verifier behaviour, grouped by the watch window each check belongs to.

    Grouping matters: a single flat list mixes every session in the log, so a
    review has to count backwards by hand to find which checks belong to the
    watch under discussion. A window starts at WATCH_ARMED and is closed by a
    sighting or by the disarm line.
    """
    cfg = config()
    path = _relay_dir(cfg) / "server.log"
    if not path.exists():
        return json.dumps({"ok": False, "action": "checks", "error": _no_relay(path, "server log")})
    since = _parse_ts(args.get("since")) if args.get("since") else None
    # The timestamped transcript wins when it actually carries checks; otherwise
    # fall back to stdout, which can group the same session's checks but not date
    # them. A relay older than the WATCH_CHECK line writes only the latter.
    transcript_windows = _checks_from_transcript(cfg)
    windows = transcript_windows if any(w["checks"] for w in transcript_windows) else _windows_from_server_log(path)

    # Date each window from the matching transcript stamp, never by position.
    armed = _transcript_watch_stamps(cfg)
    for window in windows:
        if window["sentence"] is not None and not window["armed_at"]:
            window["armed_at"] = _match_stamp(window["sentence"], armed)

    if since is not None:
        windows = [
            w for w in windows
            if (_parse_ts(w["armed_at"]) or 0) >= since
            or any((_parse_ts(c["ts"]) or 0) >= since for c in w["checks"])
        ]

    enriched = []
    for w in windows:
        row = dict(w)
        row.update(_summarise(w["checks"]))
        enriched.append(row)

    all_checks = [c for w in windows for c in w["checks"]]
    latest = enriched[-1] if enriched else None
    return json.dumps({
        "ok": True,
        "action": "checks",
        "since": args.get("since"),
        "windows_count": len(enriched),
        "latest_window": latest,
        "windows": enriched,
        "totals": _summarise(all_checks),
        "recent": all_checks[-12:],
    }, ensure_ascii=False)


HANDLERS = {
    "start": handle_start,
    "stop": handle_stop,
    "url": handle_url,
    "status": handle_status,
    "session": handle_session,
    "checks": handle_checks,
}


def handle_live_video(args, **kwargs):
    action = (args or {}).get("action") or "status"
    handler = HANDLERS.get(action)
    if handler is None:
        return json.dumps({"ok": False, "error": f"unknown action {action!r}; use one of {sorted(HANDLERS)}"})
    return handler(args, **kwargs)


def register_tools(ctx):
    if not hasattr(ctx, "register_tool"):
        return
    ctx.register_tool(
        name=SCHEMA["name"],
        toolset=TOOLSET,
        schema=SCHEMA,
        handler=handle_live_video,
        emoji="\U0001F4F9",
    )
