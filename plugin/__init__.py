"""Hermes Live Video — a read-only control surface over the live video relay.

The relay itself (server.js, the browser client, the vision tracker) keeps
running as its own systemd user service on port 8098. This plugin does not host
it, restart it or sit in its audio path; it reads the relay's own artefacts —
/healthz, transcript.log and server.log — so the agent can answer "is a live
session running", "what happened in it" and "how did the verifier behave"
without a shell.
"""

from .tools import register_tools


def register(ctx):
    register_tools(ctx)
