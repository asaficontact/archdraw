"""The archdraw agent: one piray RPC worker (`banna-archdraw`) per conversation, bridged to the studio.

    piray rpc run banna-archdraw --run-env host --repo <project dir> --protocol-version 1 --no-session --no-input

The worker speaks JSONL (piray's public RPC protocol v1, `piray/docs/design/rpc-run/protocol-v1.md`). A `prompt` is
accepted only while the worker is idle and settled, so a message that arrives while the agent works waits here and
goes out as the next prompt after `agent_settled`; `follow_up` is never used. A `Conversation` owns one worker, keeps
every event in order (so a second device that opens the same conversation sees all of it), and closes the worker
after `IDLE_S` without a message or past its budget.

Credentials: piray resolves the model's provider key from its own environment, so the key is loaded by this program
from the owner-only `~/work/secrets/providers.env` (as the desk's harness_runner does), never logged, never sent to
the browser, never written. The agent is read-only by its harness (read, ls, find, grep; no shell, no writes).

Proposals: the agent fences a whole file as ```archdraw file=<name>``` (or ```markdown file=decisions```). The studio
checks each archdraw proposal with the engine; a refusal goes back to the agent as a follow-up, at most `MAX_FIXES`
times, before it is shown to Tawab as a proposal with its error.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

AGENT = os.environ.get("ARCHDRAW_AGENT", "banna-archdraw")
PIRAY = os.environ.get("PIRAY_BIN", "piray")
SECRETS = Path(os.environ.get("ARCHDRAW_SECRETS", str(Path.home() / "work" / "secrets" / "providers.env")))
PROVIDER_KEYS = ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY")
IDLE_S = 20 * 60
BUDGET_USD = float(os.environ.get("ARCHDRAW_CONVERSATION_USD", "1.0"))
DAY_BUDGET_USD = float(os.environ.get("ARCHDRAW_DAY_USD", "10.0"))
MAX_FIXES = 2
FENCE = re.compile(r"```(archdraw|markdown)\s+file=([a-z0-9][a-z0-9-]{0,62})\s*\n(.*?)\n```", re.DOTALL)


def load_keys(env: dict[str, str]) -> None:
    """Provider keys into `env` from the owner-only secrets file; a file anyone else can read is refused."""
    if not SECRETS.exists():
        return
    st = SECRETS.stat()
    if st.st_uid != os.getuid() or st.st_mode & 0o077:
        return
    for line in SECRETS.read_text().splitlines():
        key, _, value = line.strip().removeprefix("export ").strip().partition("=")
        if key in PROVIDER_KEYS and key not in env and value:
            env[key] = value.strip().strip('"').strip("'")


def proposals(text: str) -> list[dict]:
    """Every fenced whole file in an assistant message: {kind, name, source}."""
    return [{"kind": k, "name": n, "source": s.strip() + "\n"} for k, n, s in FENCE.findall(text)]


def cost_of(usage: dict) -> float:
    """Dollars so far from a protocol-v1 Usage object (`cost` is nullable)."""
    v = usage.get("cost")
    return float(v) if isinstance(v, (int, float)) else 0.0


@dataclass
class Conversation:
    project: str
    repo: Path
    check: Callable[[str], str | None]  # the engine check: None when a source renders, else the error
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    events: list[dict] = field(default_factory=list)  # what the page shows, in order; a reconnecting device replays it
    cost: float = 0.0
    started: float = field(default_factory=time.time)
    last: float = field(default_factory=time.time)
    state: str = "starting"  # starting | ready | working | closed
    title: str = ""
    _child: subprocess.Popen | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _cond: threading.Condition = field(init=False)
    _fixes: int = 0
    _pending: list[str] = field(default_factory=list)
    _text: dict[str, str] = field(default_factory=dict)
    on_settle: Callable[[Conversation], None] | None = None  # persistence, called after each settled turn and at close

    def __post_init__(self) -> None:
        self._cond = threading.Condition(self._lock)

    def summary(self) -> dict:
        return {"id": self.id, "project": self.project, "title": self.title, "state": self.state,
                "cost": round(self.cost, 4), "started": self.started, "last": self.last,
                "events": len(self.events)}  # fmt: skip

    def _saved(self) -> None:
        if self.on_settle:
            try:
                self.on_settle(self)
            except OSError:
                pass

    # -- lifecycle -------------------------------------------------------------------------------------------------

    def start(self) -> None:
        env = dict(
            os.environ
        )  # piray builds the agent's environment from its own allowlist (as harness_runner relies on)
        load_keys(env)
        argv = [PIRAY, "rpc", "run", AGENT, "--run-env", "host", "--repo", str(self.repo)]
        argv += ["--protocol-version", "1", "--shutdown-timeout", "15", "--no-session", "--no-input"]
        self._child = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=env,
        )
        threading.Thread(target=self._read, daemon=True).start()

    def close(self, why: str = "closed") -> None:
        with self._lock:
            if self.state == "closed":
                return
            self.state = "closed"
        self._send("close")
        self._emit({"type": "closed", "why": why})
        self._saved()
        child = self._child
        if child and child.poll() is None:
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                child.kill()

    # -- talking ---------------------------------------------------------------------------------------------------

    def say(self, text: str, context: str = "") -> None:
        """Tawab's message; `context` (the open diagram, the project notes) rides with it, unseen in the transcript."""
        self.last = time.time()
        self._emit({"type": "user", "text": text})
        if not self.title:
            self.title = text[:80]
        message = f"{context}\n\n---\n\n{text}" if context else text
        if message.lstrip().startswith(
            "/"
        ):  # piray refuses a prompt that reads as a command (COMMAND_FORM_PROMPT_FORBIDDEN)
            message = "Tawab: " + message
        self._queue(message)

    def _queue(self, message: str) -> None:
        """Send now when the worker is idle and settled; else hold it for the next settlement."""
        with self._lock:
            idle = self.state == "ready"
            if idle:
                self.state = "working"
            else:
                self._pending.append(message)
        if idle:
            self._send("prompt", {"message": message})

    def _drain(self) -> None:
        with self._lock:
            if self.state != "ready" or not self._pending:
                return
            message = self._pending.pop(0)
            self.state = "working"
        self._send("prompt", {"message": message})

    def interrupt(self) -> None:
        self._send("interrupt")

    def _send(self, ctype: str, payload: dict | None = None) -> None:
        child = self._child
        if not child or not child.stdin or child.poll() is not None:
            return
        line = json.dumps({"schema_version": 1, "id": uuid.uuid4().hex[:8], "type": ctype, "payload": payload or {}})
        try:
            child.stdin.write(line + "\n")
            child.stdin.flush()
        except (BrokenPipeError, OSError):
            pass

    # -- events ----------------------------------------------------------------------------------------------------

    def _emit(self, event: dict) -> None:
        with self._cond:
            event = {"n": len(self.events), "at": time.time(), **event}
            self.events.append(event)
            self._cond.notify_all()

    def wait(self, after: int, timeout: float = 25.0) -> list[dict]:
        """Events numbered after `after`, waiting up to `timeout` for one (a long poll the page and SSE share)."""
        with self._cond:
            if len(self.events) <= after + 1:
                self._cond.wait(timeout)
            return self.events[after + 1 :]

    def _read(self) -> None:
        child = self._child
        assert child and child.stdout
        for line in child.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            self._on(ev.get("type", ""), ev.get("payload") or {})
        self._emit({"type": "ended"})
        with self._lock:
            self.state = "closed"
        self._saved()

    def _on(self, kind: str, p: dict) -> None:
        if kind == "run_started":
            with self._lock:
                if self.state == "starting":
                    self.state = "ready"
            self._emit({"type": "ready", "model": p.get("model")})
            self._drain()
        elif kind == "verification_blocked":
            self._emit({"type": "error", "text": "the agent's harness did not pass piray's verification"})
        elif kind == "state_changed":
            busy = bool(p.get("streaming")) or p.get("activity") not in ("idle", None)
            self._emit({"type": "state", "busy": busy, "activity": p.get("activity")})
        elif kind == "agent_settled":
            with self._lock:
                if self.state == "working":
                    self.state = "ready"
            self._emit({"type": "settled"})
            self._send("get_usage")  # the cost so far, for the budget and the panel
            self._saved()
            self._drain()
        elif kind == "message_started" and p.get("role") == "assistant":
            self._text[p["message_id"]] = ""
            self._emit({"type": "assistant_start", "id": p["message_id"]})
        elif kind == "message_delta":
            mid = p.get("message_id", "")
            if mid in self._text:
                self._text[mid] += p.get("text") or ""
                self._emit({"type": "delta", "id": mid, "text": p.get("text") or ""})
        elif kind == "message_completed" and p.get("message_id") in self._text:
            text = p.get("text") or self._text.pop(p["message_id"], "")
            self._text.pop(p["message_id"], None)
            if text.strip():  # a turn that only called a tool completes with no text
                self._emit({"type": "assistant", "id": p["message_id"], "text": text})
            self._propose(text)
        elif kind == "tool_started":
            self._emit({"type": "tool", "name": p.get("name"), "args": _short(p.get("args"))})
        elif kind in ("usage", "command_result") and (p.get("usage") or (p.get("result") or {}).get("usage")):
            self.cost = max(self.cost, cost_of(p.get("usage") or p["result"]["usage"]))
            self._emit({"type": "cost", "usd": round(self.cost, 4)})
            if self.cost >= BUDGET_USD:
                self._emit({"type": "error", "text": f"this conversation reached its ${BUDGET_USD:.2f} budget"})
                threading.Thread(target=self.close, args=("budget",), daemon=True).start()
        elif kind == "command_result" and p.get("status") == "rejected":
            err = p.get("error") or {}
            self._emit(
                {"type": "error", "text": f"{p.get('command_type')}: {err.get('code')}: {err.get('message')}"[:400]}
            )
            with self._lock:
                if p.get("command_type") == "prompt" and self.state == "working":
                    self.state = "ready"
        elif kind == "error":
            self._emit({"type": "error", "text": str(p.get("message") or p.get("code") or "error")[:400]})
        elif kind == "run_ended":
            self._emit({"type": "run_ended", "reason": p.get("exit_reason")})

    def _propose(self, text: str) -> None:
        """Check every archdraw file the agent proposed; a refusal goes back to it (at most MAX_FIXES times)."""
        found = proposals(text)
        errors = []
        for prop in found:
            if prop["kind"] == "archdraw":
                prop["error"] = self.check(prop["source"])
                if prop["error"]:
                    errors.append(f"{prop['name']}: {prop['error']}")
        if errors and self._fixes < MAX_FIXES:
            self._fixes += 1
            self._emit({"type": "fixing", "errors": errors})
            self._queue("The studio's engine refused your file:\n" + "\n".join(errors)
                        + "\nAnswer with the corrected complete file in the same fence, nothing else.")  # fmt: skip
            return
        self._fixes = 0
        for prop in found:
            self._emit({"type": "proposal", **prop})


def _short(value: object) -> str:
    text = value if isinstance(value, str) else json.dumps(value)
    return text[:200]


class Conversations:
    """Every conversation, by id. Each is saved under `state_dir` when it settles or closes, so the history survives a
    restart and any device can reopen it (read-only once its worker is gone). Idle ones are closed by `sweep`."""

    def __init__(self, state_dir: Path | None = None) -> None:
        self.by_id: dict[str, Conversation] = {}
        self.state_dir = state_dir
        if state_dir and state_dir.is_dir():
            for f in sorted(state_dir.glob("*.json")):
                try:
                    d = json.loads(f.read_text())
                    c = Conversation(project=d["project"], repo=Path(d["repo"]), check=lambda _s: None, id=d["id"])
                    c.events, c.cost, c.started, c.last, c.title = (
                        d["events"],
                        d["cost"],
                        d["started"],
                        d["last"],
                        d["title"],
                    )
                    c.state = "closed"
                    self.by_id[c.id] = c
                except (OSError, ValueError, KeyError, TypeError):
                    continue

    def save(self, c: Conversation) -> None:
        if not self.state_dir:
            return
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        d = {"id": c.id, "project": c.project, "repo": str(c.repo), "title": c.title, "cost": c.cost,
             "started": c.started, "last": c.last, "events": c.events}  # fmt: skip
        tmp = self.state_dir / f".{c.id}.tmp"
        tmp.write_text(json.dumps(d))
        tmp.replace(self.state_dir / f"{c.id}.json")

    def spent_today(self) -> float:
        today = time.strftime("%Y-%m-%d")
        return sum(c.cost for c in self.by_id.values() if time.strftime("%Y-%m-%d", time.localtime(c.started)) == today)

    def list(self) -> list[dict]:
        rows = [c.summary() for c in self.by_id.values()]
        return sorted(rows, key=lambda r: -r["last"])

    def get(self, cid: str) -> Conversation | None:
        return self.by_id.get(cid)

    def open(self, project: str, repo: Path, check: Callable[[str], str | None]) -> Conversation:
        if self.spent_today() >= DAY_BUDGET_USD:
            raise RuntimeError(f"today's ${DAY_BUDGET_USD:.0f} for the archdraw agent is spent")
        # piray leases the working directory to one worker, so a project has one live conversation: a new one ends the
        # last (every device that had it open sees why), and the worker it starts gets the lease
        for old in list(self.by_id.values()):
            if old.project == project and old.state != "closed":
                old.close("a new conversation started on this project")
            child = old._child
            if old.project == project and child and child.poll() is None:  # still letting go of the lease
                try:
                    child.wait(timeout=25)
                except subprocess.TimeoutExpired:
                    child.kill()
        c = Conversation(project=project, repo=repo, check=check, on_settle=self.save)
        self.by_id[c.id] = c
        c.start()
        return c

    def sweep(self) -> None:
        now = time.time()
        for c in list(self.by_id.values()):
            if c.state != "closed" and now - c.last > IDLE_S:
                c.close("idle")

    def close_all(self) -> None:
        for c in list(self.by_id.values()):
            if c.state != "closed":
                c.close("the studio restarted")
