"""archdraw studio: projects, their diagram files, and an infinite canvas that renders them.

The server lists, reads and saves `.archdraw` files in the brain (see `library.py`); the browser renders them with
the engine itself, so what you see is what the CLI and every agent produce. Every request passes the tailnet identity
gate (`identity.decide`): Tawab through Tailscale Serve from his own devices, or this box's own uid on loopback for the
health check (and for screenshot runs when ARCHDRAW_ALLOW_LOCAL=1).
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.types import Scope

from archdraw_studio import agent, identity
from archdraw_studio.library import Library, LibraryError, check_slug

log = logging.getLogger("archdraw")
REPO = Path(__file__).resolve().parents[3]  # the archdraw checkout: <repo>/studio/server/archdraw_studio/app.py


# The page runs only its own bundle: a diagram that slipped markup past the sanitizer still cannot run script,
# load a frame, or post a form elsewhere (review of archdraw#1, H1, second line). Inline style attributes are allowed
# because React and the engine's SVG use them; `data:` images are the favicon.
CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
    "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
)


def same_origin(request: Request) -> bool:
    """A write must come from the studio's own page (review L3): when the browser names an Origin (or else a Referer),
    its host must be the one the request was sent to. Tools without either (curl from this uid) pass."""
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    origin = request.headers.get("origin") or ""
    if not origin:
        referer = request.headers.get("referer") or ""
        origin = "/".join(referer.split("/")[:3]) if referer else ""
    if not origin or origin == "null":
        return not origin
    return origin.split("://", 1)[-1].rstrip("/") == host


class SaveBody(BaseModel):
    source: str
    base: str | None = None


class ProjectBody(BaseModel):
    slug: str


class OpenBody(BaseModel):
    project: str


class SayBody(BaseModel):
    text: str
    file: str | None = None  # the diagram open on the canvas, if any
    source: str | None = None  # its source as the editor holds it (may be unsaved)


def agent_context(lib: Library, project: str, file: str | None, source: str | None) -> str:
    """What rides with Tawab's message: where the agent is, which diagrams exist, and the one he is looking at."""
    where = f"[studio] Project `{project}`. Your working directory is its brain folder: the hub is `{project}.md`, "
    lines = [where + "the diagrams are `archdraw/*.archdraw`."]
    rows = lib.files(project)
    if rows:
        lines.append("Diagrams: " + "; ".join(f"{r['name']} ({r['title']})" for r in rows) + ".")
    if file:
        check_slug(file, "diagram name")
        if source is None:
            source = lib.read(project, file)["source"]
        lines.append(f"Tawab is looking at `{file}`; its source as it stands in the editor:")
        lines.append(f"```archdraw file={file}\n{source.rstrip()}\n```")
    return "\n".join(lines)


class UiFiles(StaticFiles):
    """The page is never cached; hashed assets are cached for good (a deploy renames them)."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if path.startswith("assets/") and response.status_code < 400:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


def create_app(
    library: Library | None = None,
    *,
    allow_local: bool | None = None,
    ui_dist: Path | None = None,
    state: Path | None = None,
) -> FastAPI:
    lib = library or Library(
        root=Path(os.environ.get("ARCHDRAW_LIBRARY", str(Path.home() / "work" / "brain" / "projects"))),
        engine=REPO / "dist" / "cli.js",
        node=os.environ.get("ARCHDRAW_NODE", "node"),
    )
    local = os.environ.get("ARCHDRAW_ALLOW_LOCAL") == "1" if allow_local is None else allow_local
    dist = ui_dist or REPO / "studio" / "ui" / "dist"
    default_state = Path.home() / "work" / ".archdraw-studio" / "conversations"
    talks = agent.Conversations(state_dir=state or Path(os.environ.get("ARCHDRAW_STATE", str(default_state))))

    def sweeper() -> None:
        while True:
            time.sleep(60)
            talks.sweep()

    threading.Thread(target=sweeper, daemon=True).start()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        talks.close_all()  # no agent worker outlives the studio

    app = FastAPI(title="archdraw studio", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.middleware("http")
    async def gate(request: Request, call_next: Any) -> Response:
        client = (request.client.host, request.client.port) if request.client else ("", 0)
        server_port = request.scope.get("server", ("", 0))[1] or 0
        ok, reason = identity.decide(request.url.path, request.headers, client, server_port, allow_local=local)
        if not ok:
            log.warning("refused %s %s: %s", request.method, request.url.path, reason)
            return JSONResponse({"detail": f"refused: {reason}"}, status_code=403)
        if request.method not in ("GET", "HEAD", "OPTIONS") and not same_origin(request):
            log.warning("refused %s %s: cross-origin", request.method, request.url.path)
            return JSONResponse({"detail": "refused: cross-origin write"}, status_code=403)
        request.state.who = request.headers.get("Tailscale-User-Login") or "banna (local)"
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = CSP
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.exception_handler(LibraryError)
    async def library_error(_: Request, exc: LibraryError) -> JSONResponse:
        return JSONResponse({"detail": exc.message}, status_code=exc.status)

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True, "library": str(lib.root), "projects": len(lib.projects())}

    @app.get("/api/projects")
    def projects() -> list[dict]:
        return lib.projects()

    @app.post("/api/projects")
    def create_project(body: ProjectBody, request: Request) -> dict:
        return lib.create_project(check_slug(body.slug, "project"), request.state.who)

    @app.get("/api/projects/{project}/files")
    def files(project: str) -> list[dict]:
        return lib.files(project)

    @app.get("/api/projects/{project}/files/{name}")
    def read(project: str, name: str) -> dict:
        return lib.read(project, name)

    @app.put("/api/projects/{project}/files/{name}")
    def save(project: str, name: str, body: SaveBody, request: Request) -> dict:
        return lib.save(project, name, body.source, body.base, request.state.who)

    def talk(cid: str) -> agent.Conversation:
        c = talks.get(cid)
        if c is None:
            raise LibraryError(404, "no such conversation")
        return c

    @app.get("/api/agent")
    def agent_status() -> dict:
        return {"spent_today": round(talks.spent_today(), 4), "day_budget": agent.DAY_BUDGET_USD,
                "conversation_budget": agent.BUDGET_USD, "conversations": talks.list()[:30]}  # fmt: skip

    @app.post("/api/agent/conversations")
    def agent_open(body: OpenBody) -> dict:
        project = check_slug(body.project, "project")
        lib.files(project)  # 404 for a project that does not exist
        try:
            c = talks.open(project, lib.root / project, lib.check)
        except RuntimeError as exc:
            raise LibraryError(429, str(exc)) from exc
        return c.summary()

    @app.get("/api/agent/conversations/{cid}")
    def agent_events(cid: str, after: int = -1, wait: float = 0) -> dict:
        """Events after `after`; with `wait` (seconds, at most 25), a long poll that answers as soon as one arrives."""
        c = talk(cid)
        events = c.wait(after, min(max(wait, 0), 25)) if wait else c.events[after + 1 :]
        return {**c.summary(), "items": events}

    @app.post("/api/agent/conversations/{cid}/messages")
    def agent_say(cid: str, body: SayBody) -> dict:
        c = talk(cid)
        if c.state == "closed":
            raise LibraryError(409, "this conversation has ended; start a new one")
        if not body.text.strip() or len(body.text) > 20_000:
            raise LibraryError(400, "a message is 1 to 20,000 characters")
        c.say(body.text.strip(), agent_context(lib, c.project, body.file, body.source))
        return c.summary()

    @app.post("/api/agent/conversations/{cid}/interrupt")
    def agent_interrupt(cid: str) -> dict:
        talk(cid).interrupt()
        return {"ok": True}

    @app.post("/api/agent/conversations/{cid}/close")
    def agent_close(cid: str) -> dict:
        c = talk(cid)
        threading.Thread(target=c.close, args=("closed by Tawab",), daemon=True).start()
        return {"ok": True}

    @app.get("/api/{rest:path}", include_in_schema=False)
    def api_404(rest: str) -> Response:
        return JSONResponse({"detail": f"no route /api/{rest}"}, status_code=404)

    if (dist / "index.html").is_file():
        app.mount("/", UiFiles(directory=dist, html=True), name="ui")
    return app


def main_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    return create_app()
