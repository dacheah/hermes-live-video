"""Hermes Live Video — the tool surface for a phone-camera live voice relay.

The relay is this same directory: server.js, the browser client and the vision
tracker, with the plugin manifest beside them. This plugin starts and stops that
relay as a child process, hands it the Gemini key through its environment, and
reads back what a session saw — /healthz, transcript.log and server.log — so the
agent can answer "is a live session running", "what happened in it" and "how did
the verifier behave" without a shell.

It does not sit in the relay's audio or video path, and a relay run as a systemd
unit is left to systemd. The bind is loopback by default; a LAN bind carries a
token minted per start.
"""

from .tools import register_tools


def register(ctx):
    register_tools(ctx)
