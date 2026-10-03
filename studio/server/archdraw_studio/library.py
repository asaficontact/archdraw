"""The diagram library: archdraw files kept in the brain, one folder per project.

    <root>/<project>/archdraw/<name>.archdraw

`root` is the brain's `projects/` directory, so a project's diagrams sit beside its hub note and every agent that
reads the brain reads them. The files are the record; this module only lists, reads, checks and writes them. A write
is committed to the brain checkout under the same flock the desk and `brain-sync` take
(`<git common dir>/brain-write.lock`), committing only the written path, so it never sweeps up another writer's
staged work. Pushing is left to the brain's own publish step.

A file's first lines may carry `// title: …` and `// summary: …`; the studio shows them in place of the file name.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import re
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
EXT = ".archdraw"
SUBDIR = "archdraw"
META = re.compile(r"^//\s*(title|summary)\s*:\s*(.+?)\s*$")
MAX_BYTES = 200_000


class LibraryError(Exception):
    """A request the library refuses: `status` is the HTTP status to answer with."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def check_slug(value: str, what: str) -> str:
    if not SLUG.match(value or ""):
        raise LibraryError(400, f"{what} must be lowercase letters, digits and dashes (got {value!r})")
    return value


def meta(source: str) -> dict[str, str]:
    """`// title:` and `// summary:` from the comment lines at the top of a file."""
    found: dict[str, str] = {}
    for line in source.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if not stripped.startswith("//"):
            break
        m = META.match(stripped)
        if m and m.group(1) not in found:
            found[m.group(1)] = m.group(2)
    return found


def digest(source: str) -> str:
    return hashlib.sha256(source.encode()).hexdigest()[:16]


def starter(title: str) -> str:
    return (
        f"// title: {title}\n"
        "// summary: One sentence on what this diagram shows.\n\n"
        'node app "App"\n'
        'node store "Store"  right of app\n'
        'edge app -> store  "reads"  from: right  to: left\n'
    )


@dataclass
class Library:
    root: Path
    engine: Path | None = None  # the built CLI (dist/cli.js) used to check a file before it is saved
    node: str = "node"
    commit: bool = True

    # -- reading ---------------------------------------------------------------------------------------------------

    def _project_dir(self, project: str) -> Path:
        return self.root / check_slug(project, "project") / SUBDIR

    def _file(self, project: str, name: str) -> Path:
        return self._project_dir(project) / f"{check_slug(name, 'diagram name')}{EXT}"

    def projects(self) -> list[dict]:
        out = []
        if not self.root.is_dir():
            return out
        for d in sorted(self.root.iterdir()):
            folder = d / SUBDIR
            if not (SLUG.match(d.name) and folder.is_dir()):
                continue
            files = sorted(folder.glob(f"*{EXT}"))
            out.append(
                {
                    "slug": d.name,
                    "title": self._project_title(d),
                    "files": len(files),
                    "updated": max((f.stat().st_mtime for f in files), default=folder.stat().st_mtime),
                }
            )
        return out

    def _project_title(self, d: Path) -> str:
        hub = d / f"{d.name}.md"
        if hub.is_file():
            for line in hub.read_text(errors="replace").splitlines():
                if line.startswith("# "):
                    return line[2:].split(" — ")[0].strip()
        return d.name

    def files(self, project: str) -> list[dict]:
        folder = self._project_dir(project)
        if not folder.is_dir():
            raise LibraryError(404, f"no project {project!r}")
        out = []
        for f in sorted(folder.glob(f"*{EXT}")):
            source = f.read_text(errors="replace")
            m = meta(source)
            out.append(
                {
                    "name": f.stem,
                    "title": m.get("title", f.stem),
                    "summary": m.get("summary", ""),
                    "updated": f.stat().st_mtime,
                    "bytes": len(source.encode()),
                    "version": digest(source),
                }
            )
        order = self._order(folder)
        out.sort(key=lambda x: (order.index(x["name"]) if x["name"] in order else len(order), x["name"]))
        return out

    def _order(self, folder: Path) -> list[str]:
        """An optional `order.json` (a list of names) puts the files in reading order; the rest follow by name."""
        try:
            value = json.loads((folder / "order.json").read_text())
            return [str(v) for v in value] if isinstance(value, list) else []
        except (OSError, ValueError):
            return []

    def read(self, project: str, name: str) -> dict:
        path = self._file(project, name)
        if not path.is_file():
            raise LibraryError(404, f"no diagram {project}/{name}")
        source = path.read_text(errors="replace")
        return {"project": project, "name": name, "source": source, "version": digest(source), **meta(source)}

    # -- checking --------------------------------------------------------------------------------------------------

    def check(self, source: str) -> str | None:
        """The engine's error for this source, or None when it renders. Without an engine, nothing is checked."""
        if self.engine is None:
            return None
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / f"check{EXT}"
            src.write_text(source)
            try:
                r = subprocess.run(
                    [self.node, str(self.engine), str(src), "-o", str(Path(tmp) / "out.svg")],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise LibraryError(503, f"the engine could not check the file: {exc.__class__.__name__}") from exc
        if r.returncode == 0:
            return None
        return (r.stderr or r.stdout).strip().replace(str(src), "diagram")[:2000] or "the engine refused the file"

    # -- writing ---------------------------------------------------------------------------------------------------

    def _inside(self, path: Path) -> Path:
        """The path, after refusing any symlink between the library root and it (review L2): the slugs keep a name
        inside its folder, and this keeps a linked folder or file from sending a write elsewhere."""
        try:
            rel = path.relative_to(self.root)
        except ValueError as exc:
            raise LibraryError(400, "refusing a path outside the library") from exc
        cur = self.root
        for part in rel.parts:
            cur = cur / part
            if cur.is_symlink():
                raise LibraryError(400, "refusing a path that passes through a symlink")
        return path

    def create_project(self, project: str, by: str) -> dict:
        folder = self._inside(self._project_dir(project))
        with self._lock():
            if folder.exists():
                raise LibraryError(409, f"project {project!r} already exists")
            folder.mkdir(parents=True)
            first = folder / f"overview{EXT}"
            first.write_text(starter(f"{project} overview"))
            try:
                self._commit_locked([first], f"archdraw: new project {project}", by)
            except LibraryError:
                first.unlink(missing_ok=True)
                folder.rmdir()
                raise
        return {"slug": project}

    def save(self, project: str, name: str, source: str, base: str | None, by: str) -> dict:
        """Check with the engine first (no lock needed); then, under the brain's writer lock, compare the base, write,
        and commit that one path, putting the file back as it was if the commit fails (review M1). `base` None means
        a new file and is refused when the file exists (M2)."""
        if len(source.encode()) > MAX_BYTES:
            raise LibraryError(413, f"a diagram is at most {MAX_BYTES} bytes")
        folder = self._project_dir(project)
        if not folder.is_dir():
            raise LibraryError(404, f"no project {project!r}")
        path = self._inside(self._file(project, name))
        error = self.check(source)
        if error:
            raise LibraryError(422, error)
        if not source.endswith("\n"):
            source += "\n"
        with self._lock():
            exists = path.is_file()
            before = path.read_text(errors="replace") if exists else None
            if base is None and exists:
                raise LibraryError(409, f"{project}/{name} already exists; open it to edit it")
            if base is not None and not exists:
                raise LibraryError(409, "the file was removed since you opened it")
            if base is not None and before is not None and digest(before) != base:
                raise LibraryError(409, "the file changed since you opened it; your edit is kept in the editor")
            path.write_text(source)
            try:
                commit = self._commit_locked(
                    [path], f"archdraw: {'edit' if exists else 'new diagram'} {project}/{name}", by
                )
            except LibraryError:
                if before is None:
                    path.unlink(missing_ok=True)
                else:
                    path.write_text(before)
                raise
        return {"project": project, "name": name, "version": digest(source), "commit": commit}

    def _git_root(self) -> Path | None:
        r = subprocess.run(
            ["git", "-C", str(self.root), "rev-parse", "--show-toplevel"], capture_output=True, text=True, check=False
        )
        return Path(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else None

    @contextmanager
    def _lock(self) -> Iterator[None]:
        """The brain's writer lock (`<git common dir>/brain-write.lock`), the flock the desk and brain-sync take.
        Without a git repo (tests, a scratch library) there is nothing to serialise against."""
        top = self._git_root() if self.commit else None
        if top is None:
            yield
            return
        common = subprocess.run(
            ["git", "-C", str(top), "rev-parse", "--path-format=absolute", "--git-common-dir"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout.strip()
        with open(Path(common) / "brain-write.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _commit_locked(self, paths: list[Path], message: str, by: str) -> str | None:
        """Commit exactly these paths; the caller holds the lock. On failure the paths are unstaged again, so the
        shared index is left as it was. The short sha, or None when not committing."""
        top = self._git_root() if self.commit else None
        if top is None:
            return None
        rel = [str(p.relative_to(top)) for p in paths]
        body = f"{message}\n\nSaved in the archdraw studio by {by}.\n\nAgent: Banna"
        add = subprocess.run(["git", "-C", str(top), "add", "--", *rel], capture_output=True, text=True, check=False)
        r = add
        if add.returncode == 0:
            r = subprocess.run(
                ["git", "-C", str(top), "commit", "-q", "-m", body, "--", *rel],
                capture_output=True,
                text=True,
                check=False,
            )
        if r.returncode != 0:
            if "nothing to commit" in (r.stdout + r.stderr):
                return None
            subprocess.run(["git", "-C", str(top), "reset", "-q", "--", *rel], capture_output=True, check=False)
            raise LibraryError(500, f"commit failed: {(r.stderr or r.stdout).strip()[:300]}")
        return subprocess.run(
            ["git", "-C", str(top), "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=False
        ).stdout.strip()
