"""archdraw studio: projects, their diagram files, and an infinite canvas that renders them.

The server lists, reads and saves `.archdraw` files in the brain (see `library.py`); the browser renders them with
the engine itself, so what you see is what the CLI and every agent produce. Every request passes the tailnet identity
gate (`identity.decide`): Tawab through Tailscale Serve from his own devices, or this box's own uid on loopback for the
health check (and for screenshot runs when ARCHDRAW_ALLOW_LOCAL=1).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.types import Scope

from archdraw_studio import identity
from archdraw_studio.library import Library, LibraryError, check_slug

log = logging.getLogger("archdraw")
REPO = Path(__file__).resolve().parents[3]  # the archdraw checkout: <repo>/studio/server/archdraw_studio/app.py


class SaveBody(BaseModel):
    source: str
    base: str | None = None


class ProjectBody(BaseModel):
    slug: str


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
    library: Library | None = None, *, allow_local: bool | None = None, ui_dist: Path | None = None
) -> FastAPI:
    lib = library or Library(
        root=Path(os.environ.get("ARCHDRAW_LIBRARY", str(Path.home() / "work" / "brain" / "projects"))),
        engine=REPO / "dist" / "cli.js",
        node=os.environ.get("ARCHDRAW_NODE", "node"),
    )
    local = os.environ.get("ARCHDRAW_ALLOW_LOCAL") == "1" if allow_local is None else allow_local
    dist = ui_dist or REPO / "studio" / "ui" / "dist"
    app = FastAPI(title="archdraw studio", docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def gate(request: Request, call_next: Any) -> Response:
        client = (request.client.host, request.client.port) if request.client else ("", 0)
        server_port = request.scope.get("server", ("", 0))[1] or 0
        ok, reason = identity.decide(request.url.path, request.headers, client, server_port, allow_local=local)
        if not ok:
            log.warning("refused %s %s: %s", request.method, request.url.path, reason)
            return JSONResponse({"detail": f"refused: {reason}"}, status_code=403)
        request.state.who = request.headers.get("Tailscale-User-Login") or "banna (local)"
        return await call_next(request)

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

    @app.get("/api/{rest:path}", include_in_schema=False)
    def api_404(rest: str) -> Response:
        return JSONResponse({"detail": f"no route /api/{rest}"}, status_code=404)

    if (dist / "index.html").is_file():
        app.mount("/", UiFiles(directory=dist, html=True), name="ui")
    return app


def main_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    return create_app()
