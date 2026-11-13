"""Handler tests for the live-video plugin.

Stdlib only: run with `python3 tests/test_handlers.py` from the repo root, which
is also the plugin directory.
Every expected value is taken from a real relay log line observed on 2026-11-12,
not from the parser's own arithmetic, so a regex that stops matching shows up as
a failure rather than as a quietly empty result.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import unittest.mock
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import tools  # noqa: E402

TRANSCRIPT = """\
[2026-11-12T13:32:09.395Z] USER: Hey Jarvis, let me know when the screen turns blue.
[2026-11-12T13:32:09.498Z] JARVIS:  Understood, sir. I will alert you the moment the screen turns blue.
[2026-11-12T13:32:09.500Z] WATCH_ARMED: Hey Jarvis, let me know when the screen turns blue.
[2026-11-12T13:32:26.940Z] VISION_EVENT: Significant visual change (dist=1.2434)
[2026-11-12T13:32:35.608Z] WATCH_FIRED: visible (check 3, 4542ms)
[2026-11-12T13:32:35.700Z] JARVIS:  The screen has now turned blue, sir.
"""

# Two windows: the first sighted, the second expired with no sighting.
SERVER_LOG = """\
[2026-11-12T13:32:12.000Z] [live-video] watch armed for 90s: let me know when the screen turns blue
[2026-11-12T13:32:17.000Z] [live-video] watch check 1 (heartbeat): not yet — gemini-3-flash-preview 3432ms
[2026-11-12T13:32:22.000Z] [live-video] watch check 2 (heartbeat): verifier unavailable
[2026-11-12T13:32:29.000Z] [live-video] watch check 3 (scene change): VISIBLE — gemini-3-flash-preview 4542ms
[2026-11-12T13:32:29.100Z] [live-video] watch sighted — voiced turn requested (check 3, gemini-3-flash-preview 4542ms)
[2026-11-12T13:40:00.000Z] [live-video] watch armed for 90s: let me know when the pendant lights come into view
[2026-11-12T13:40:05.000Z] [live-video] watch check 1 (heartbeat): not yet — gemini-3-flash-preview 2063ms
[2026-11-12T13:41:30.000Z] [live-video] watch ended without a sighting: window elapsed
"""


class TranscriptChecks(unittest.TestCase):
    """A relay that stamps WATCH_CHECK lines: the transcript dates every check.

    server.log is deliberately populated with a different session's checks, so a
    parser that preferred stdout would report the wrong latency here.
    """

    TRANSCRIPT = """\
[2026-11-12T16:03:15.400Z] USER: Let me know when the screen turns blue.
[2026-11-12T16:03:15.402Z] WATCH_ARMED: Let me know when the screen turns blue.
[2026-11-12T16:03:17.930Z] JARVIS: Understood, sir. I shall keep watch.
[2026-11-12T16:03:30.747Z] VISION_EVENT: Significant visual change (dist=0.7391)
[2026-11-12T16:03:32.874Z] WATCH_CHECK: n=1 trigger=scene change verdict=visible model=live ms=1126
[2026-11-12T16:03:32.874Z] WATCH_FIRED: visible (check 1, 1126ms)
"""

    SERVER_LOG = """\
[live-video] watch armed for 90s: let me know when the screen turns blue
[live-video] watch check 1 (heartbeat): not yet — gemini-3-flash-preview 4542ms
[live-video] watch check 2 (heartbeat): not yet — gemini-3-flash-preview 3432ms
[live-video] watch check 3 (scene change): VISIBLE — gemini-3-flash-preview 4542ms
"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "transcript.log").write_text(self.TRANSCRIPT)
        (self.root / "server.log").write_text(self.SERVER_LOG)
        os.environ["LIVE_VIDEO_RELAY_DIR"] = str(self.root)
        os.environ["LIVE_VIDEO_PORT"] = "9"

    def tearDown(self):
        os.environ.pop("LIVE_VIDEO_RELAY_DIR", None)
        os.environ.pop("LIVE_VIDEO_PORT", None)
        self.tmp.cleanup()

    def call(self, **args):
        return json.loads(tools.handle_live_video({"action": "checks", **args}))

    def test_transcript_checks_win_over_stdout(self):
        out = self.call()
        self.assertEqual(out["windows_count"], 1)
        window = out["windows"][0]
        self.assertEqual(window["checks"], 1)
        self.assertEqual(window["by_trigger"], {"scene change": 1})
        self.assertEqual(window["latency_ms"]["median"], 1126)
        self.assertEqual(window["outcome"], "sighted")

    def test_armed_sentence_survives_without_a_window_in_the_line(self):
        window = self.call()["windows"][0]
        self.assertEqual(window["sentence"], "Let me know when the screen turns blue.")
        self.assertEqual(window["window_s"], 90)

    def test_live_transport_is_reported_as_the_model(self):
        events = self.call()["windows"][0]["events"]
        self.assertEqual(events[0]["model"], "live")

    def test_since_still_filters_transcript_windows(self):
        self.assertEqual(self.call(since="2026-11-12T16:00:00Z")["windows_count"], 1)
        self.assertEqual(self.call(since="2026-11-12T17:00:00Z")["windows_count"], 0)


class Handlers(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "transcript.log").write_text(TRANSCRIPT)
        (self.root / "server.log").write_text(SERVER_LOG)
        os.environ["LIVE_VIDEO_RELAY_DIR"] = str(self.root)
        os.environ["LIVE_VIDEO_PORT"] = "9"  # closed port: health must report, not raise
        os.environ["LIVE_VIDEO_STATE_DIR"] = str(self.root / "state")

    def tearDown(self):
        os.environ.pop("LIVE_VIDEO_RELAY_DIR", None)
        os.environ.pop("LIVE_VIDEO_PORT", None)
        os.environ.pop("LIVE_VIDEO_STATE_DIR", None)
        self.tmp.cleanup()

    def call(self, **args):
        return json.loads(tools.handle_live_video(args))

    # --- session ---------------------------------------------------------

    def test_session_counts_and_window(self):
        out = self.call(action="session", lines=10)
        self.assertTrue(out["ok"])
        self.assertEqual(out["counts"]["USER"], 1)
        self.assertEqual(out["counts"]["JARVIS"], 2)
        self.assertEqual(out["counts"]["VISION_EVENT"], 1)
        self.assertEqual(out["counts"]["WATCH_ARMED"], 1)
        self.assertEqual(out["counts"]["WATCH_FIRED"], 1)
        self.assertEqual(out["window"]["from"], "2026-11-12T13:32:09.395Z")
        self.assertEqual(out["window"]["to"], "2026-11-12T13:32:35.700Z")
        self.assertEqual(out["jarvis_turns"][0][:12], "Understood, ")

    def test_session_respects_line_cap(self):
        out = self.call(action="session", lines=2)
        self.assertEqual(out["lines_read"], 2)
        self.assertEqual(out["counts"], {"WATCH_FIRED": 1, "JARVIS": 1})

    # --- checks ----------------------------------------------------------

    def test_checks_are_grouped_per_window(self):
        out = self.call(action="checks")
        self.assertEqual(out["windows_count"], 2)
        first, second = out["windows"]
        self.assertEqual(first["sentence"], "let me know when the screen turns blue")
        self.assertEqual(first["outcome"], "sighted")
        self.assertEqual(first["checks"], 3)
        self.assertEqual(first["visible"], 1)
        self.assertEqual(first["not_yet"], 1)
        self.assertEqual(first["verifier_unavailable"], 1)
        self.assertEqual(first["latency_ms"]["median"], 3987.0)
        self.assertEqual(first["by_trigger"], {"heartbeat": 2, "scene change": 1})
        self.assertEqual(first["window_s"], 90)
        self.assertEqual(second["outcome"], "ended: window elapsed")
        self.assertEqual(second["checks"], 1)
        self.assertEqual(out["latest_window"]["armed_at"], "2026-11-12T13:40:00.000Z")
        self.assertEqual(out["totals"]["checks"], 4)

    def test_checks_since_filters_to_one_window(self):
        out = self.call(action="checks", since="2026-11-12T13:35:00Z")
        self.assertEqual(out["windows_count"], 1)
        self.assertEqual(out["windows"][0]["armed_at"], "2026-11-12T13:40:00.000Z")

    def test_pre_empted_check_is_counted_apart_from_a_failure(self):
        (self.root / "server.log").write_text(
            SERVER_LOG.replace(
                "[2026-11-12T13:32:22.000Z] [live-video] watch check 2 (heartbeat): verifier unavailable",
                "[2026-11-12T13:32:22.000Z] [live-video] watch check 2 (heartbeat): pre-empted",
            )
        )
        first = self.call(action="checks")["windows"][0]
        self.assertEqual(first["pre_empted"], 1)
        self.assertEqual(first["verifier_unavailable"], 0)

    def test_windows_dated_from_transcript_when_log_has_no_stamps(self):
        # The unit's stdout carries no clocks; transcript.log is what dates a window.
        stranded = "\n".join(
            line.split("] ", 1)[1] if line.startswith("[") else line
            for line in SERVER_LOG.strip().splitlines()
        )
        (self.root / "server.log").write_text(stranded)
        (self.root / "transcript.log").write_text(
            TRANSCRIPT
            + "[2026-11-12T13:40:00.100Z] WATCH_ARMED: let me know when the pendant lights come into view\n"
        )
        out = self.call(action="checks")
        self.assertEqual(out["windows_count"], 2)
        self.assertEqual(out["windows"][0]["armed_at"], "2026-11-12T13:32:09.500Z")
        self.assertEqual(out["windows"][1]["armed_at"], "2026-11-12T13:40:00.100Z")

    def test_rate_limited_checks_are_counted_separately(self):
        (self.root / "server.log").write_text(
            SERVER_LOG + "[2026-11-12T13:41:35.000Z] [live-video] watch check 2 (heartbeat): rate limited\n"
        )
        out = self.call(action="checks")
        self.assertEqual(out["windows"][1]["rate_limited"], 1)
        self.assertEqual(out["windows"][1]["verifier_unavailable"], 0)
        self.assertEqual(out["windows"][1]["latency_ms"]["count"], 1)

    def test_window_without_a_transcript_line_stays_undated(self):
        stranded = "\n".join(
            line.split("] ", 1)[1] if line.startswith("[") else line
            for line in SERVER_LOG.strip().splitlines()
        )
        (self.root / "server.log").write_text(stranded)
        # The transcript quotes only the first window, so the second cannot be dated.
        out = self.call(action="checks")
        self.assertEqual(out["windows"][0]["armed_at"], "2026-11-12T13:32:09.500Z")
        self.assertIsNone(out["windows"][1]["armed_at"])
        # An undated window cannot be shown to fall after a cutoff, so it is omitted.
        self.assertEqual(self.call(action="checks", since="2026-11-12T00:00:00Z")["windows_count"], 1)

    # --- status ----------------------------------------------------------

    def test_watch_state_follows_the_last_watch_event(self):
        # The fixture's last WATCH_* event is WATCH_FIRED, so the watch is spent.
        out = self.call(action="status")
        self.assertEqual(out["watch"]["state"], "fired")
        self.assertFalse(out["watch"]["armed"])
        self.assertFalse(out["watch_armed"])

    def test_armed_state_needs_a_live_session(self):
        # Last WATCH_* is WATCH_ARMED, but no tracker is running: not armed.
        (self.root / "transcript.log").write_text(
            TRANSCRIPT.split("[2026-11-12T13:32:26.940Z]")[0]
        )
        out = self.call(action="status")
        self.assertEqual(out["watch"]["state"], "armed")
        self.assertFalse(out["watch"]["armed"])
        self.assertFalse(out["watch"]["session_live"])

    def test_status_reports_unreachable_health_without_raising(self):
        out = self.call(action="status")
        self.assertTrue(out["ok"])
        self.assertFalse(out["health"]["reachable"])
        self.assertTrue(out["transcript"]["exists"])
        self.assertGreater(out["transcript"]["bytes"], 0)

    def test_unknown_action_is_a_stated_error(self):
        out = self.call(action="teleport")
        self.assertFalse(out["ok"])
        self.assertIn("unknown action", out["error"])

    def test_default_relay_dir_is_the_plugin_itself(self):
        # The catalogue installs the plugin tree; the relay is that tree, so the
        # default must resolve to this directory rather than to a stranger's home.
        self.assertEqual(tools.DEFAULT_CONFIG["relay_dir"], "")
        self.assertEqual(tools._relay_dir({"relay_dir": ""}), tools.PLUGIN_DIR)
        self.assertTrue((tools.PLUGIN_DIR / "server.js").exists())
        self.assertEqual(
            tools._relay_dir({"relay_dir": "~/elsewhere"}),
            Path.home() / "elsewhere",
        )

    def test_default_bind_is_loopback(self):
        self.assertEqual(tools.DEFAULT_CONFIG["bind"], "127.0.0.1")

    def test_lan_bind_mints_a_token_and_carries_it_in_the_url(self):
        token = "tok3n-for-this-run"
        urls = tools._urls(8098, token, "0.0.0.0")
        self.assertTrue(urls["local"].endswith(f"?token={token}"))
        self.assertIn(":8098/?token=", urls["lan"])
        loopback = tools._urls(8098, "", "127.0.0.1")
        self.assertEqual(loopback["local"], "http://127.0.0.1:8098/")
        self.assertIsNone(loopback["lan"])

    def test_child_env_is_minimal_and_carries_the_key(self):
        os.environ["OPENAI_API_KEY"] = "should-not-leak"
        os.environ["WATCH_WINDOW_SECONDS"] = "45"
        os.environ["LIVE_USER_NAME"] = "Tester"
        try:
            env = tools._child_env("gem-key", 8098, "0.0.0.0", "tok", Path("/relay"))
        finally:
            for k in ("OPENAI_API_KEY", "WATCH_WINDOW_SECONDS", "LIVE_USER_NAME"):
                os.environ.pop(k, None)
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertEqual(env["GEMINI_API_KEY"], "gem-key")
        self.assertEqual(env["HOST"], "0.0.0.0")
        self.assertEqual(env["PORT"], "8098")
        self.assertEqual(env["LIVE_TOKEN"], "tok")
        self.assertEqual(env["WATCH_WINDOW_SECONDS"], "45")
        self.assertEqual(env["LIVE_USER_NAME"], "Tester")
        self.assertIn("PATH", env)

    def test_state_lives_under_hermes_home_plugin_data(self):
        home = Path(self.tmp.name) / "hermes-home"
        os.environ["HERMES_HOME"] = str(home)
        os.environ.pop("LIVE_VIDEO_STATE_DIR", None)
        try:
            self.assertEqual(tools._state_dir(), home / "plugin-data" / "live-video")
        finally:
            os.environ.pop("HERMES_HOME", None)

    def test_config_loader_falls_back_without_raising(self):
        # Under a bare interpreter hermes_cli may be unimportable; the entry is
        # then simply empty, never an exception on the agent's tool call.
        self.assertIsInstance(tools._load_config_file(), dict)

    def test_missing_relay_explains_what_to_set(self):
        os.environ["LIVE_VIDEO_RELAY_DIR"] = str(Path(self.tmp.name) / "absent")
        err = self.call(action="session")["error"]
        self.assertIn("relay_dir", err)
        self.assertIn("plugins.entries.live-video", err)
        self.assertEqual(
            self.call(action="status")["relay_present"], False
        )
        hint = self.call(action="status")["hint"]
        self.assertIn("relay_dir", hint)
        self.assertIn("plugins.entries.live-video", hint)
        self.assertIn("relay_dir", self.call(action="checks")["error"])

    def test_missing_logs_are_stated_not_raised(self):
        os.environ["LIVE_VIDEO_RELAY_DIR"] = str(Path(self.tmp.name) / "absent")
        self.assertFalse(self.call(action="session")["ok"])
        self.assertFalse(self.call(action="checks")["ok"])

    def test_register_is_guarded_without_a_context(self):
        tools.register_tools(object())  # no register_tool attribute: must not raise


    # --- lifecycle -------------------------------------------------------

    def test_url_reports_a_closed_port_without_raising(self):
        out = self.call(action="url")
        self.assertFalse(out["ok"])
        self.assertIsNone(out["health"])
        self.assertEqual(out["urls"]["local"], "http://127.0.0.1:9/")

    def test_start_explains_a_missing_checkout(self):
        os.environ["LIVE_VIDEO_RELAY_DIR"] = str(self.root / "absent")
        out = self.call(action="start")
        self.assertFalse(out["ok"])
        self.assertIn("relay_dir", out["error"])

    def test_start_requires_a_gemini_key(self):
        (self.root / "server.js").write_text("// stub\n")
        previous = os.environ.pop("GEMINI_API_KEY", None)
        try:
            out = self.call(action="start")
        finally:
            if previous is not None:
                os.environ["GEMINI_API_KEY"] = previous
        self.assertFalse(out["ok"])
        self.assertIn("GEMINI_API_KEY", out["error"])

    def test_stop_without_a_pid_file_says_so(self):
        out = self.call(action="stop")
        self.assertFalse(out["ok"])
        self.assertIn("not running", out["error"])

    def test_start_notices_a_relay_that_is_already_up(self):
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        class Health(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                body = json.dumps({"ok": True, "port": 8098, "hasKey": True, "tracker": True}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_a):
                return

        server = HTTPServer(("127.0.0.1", 0), Health)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            os.environ["LIVE_VIDEO_PORT"] = str(server.server_address[1])
            out = self.call(action="start")
        finally:
            server.shutdown()
            os.environ["LIVE_VIDEO_PORT"] = "9"
        self.assertTrue(out["ok"])
        self.assertTrue(out["already_running"])
        self.assertTrue(out["health"]["tracker"])

class WindowsProcessShape(unittest.TestCase):
    """The Windows branch is exercised on Linux by passing the platform explicitly.

    These cover the three places where Windows is not merely a different path:
    detachment, liveness and termination.
    """

    def test_spawn_detaches_with_process_group_on_windows(self):
        kwargs = tools._spawn_kwargs(windows=True)
        self.assertNotIn("start_new_session", kwargs)
        self.assertEqual(kwargs["creationflags"],
                         tools.CREATE_NEW_PROCESS_GROUP | tools.DETACHED_PROCESS)

    def test_spawn_uses_setsid_elsewhere(self):
        self.assertEqual(tools._spawn_kwargs(windows=False), {"start_new_session": True})

    def test_windows_liveness_never_calls_os_kill(self):
        calls = []
        real_kill = os.kill
        os.kill = lambda *a, **k: self.fail("os.kill must not be used as a liveness probe on Windows")
        try:
            real_win = tools._win_pid_alive
            tools._win_pid_alive = lambda pid: calls.append(pid) or True
            try:
                self.assertTrue(tools._pid_alive(4321, windows=True))
            finally:
                tools._win_pid_alive = real_win
        finally:
            os.kill = real_kill
        self.assertEqual(calls, [4321])

    def test_posix_liveness_uses_signal_zero(self):
        seen = []
        real_kill = os.kill
        os.kill = lambda pid, sig: seen.append((pid, sig))
        try:
            self.assertTrue(tools._pid_alive(99, windows=False))
        finally:
            os.kill = real_kill
        self.assertEqual(seen, [(99, 0)])

    def test_windows_terminate_kills_the_tree(self):
        seen = []
        real_run = tools.subprocess.run
        tools.subprocess.run = lambda argv, **kw: seen.append(argv)
        try:
            tools._terminate(1234, windows=True)
        finally:
            tools.subprocess.run = real_run
        self.assertEqual(seen, [["taskkill", "/PID", "1234", "/T", "/F"]])

    def test_posix_terminate_sends_sigterm(self):
        seen = []
        real_kill = os.kill
        os.kill = lambda pid, sig: seen.append((pid, sig))
        try:
            tools._terminate(1234, windows=False)
        finally:
            os.kill = real_kill
        self.assertEqual(seen, [(1234, tools.signal.SIGTERM)])

    def test_zombie_child_counts_as_dead(self):
        """An exited-but-unwaited child answers signal 0; it must not read as alive."""
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        try:
            for _ in range(40):
                if Path(f"/proc/{proc.pid}/stat").exists():
                    break
                time.sleep(0.05)
            time.sleep(0.3)
            self.assertFalse(tools._pid_alive(proc.pid, windows=False))
        finally:
            proc.wait()

    def test_node_candidates_cover_windows_install_locations(self):
        cands = tools._node_candidates({"node_bin": "C:/Program Files/nodejs/node.exe"})
        self.assertEqual(cands[0], "C:/Program Files/nodejs/node.exe")
        self.assertTrue(any(c.lower().endswith("node.exe") for c in cands if c))


if __name__ == "__main__":
    unittest.main(verbosity=2)
