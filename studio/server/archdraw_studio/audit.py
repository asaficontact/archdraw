"""The daily archdraw audit, the mechanical half: facts for the task that keeps the diagrams current.

    python -m archdraw_studio.audit [--since 24h] [--json]

It reports, and changes nothing:
- every diagram in the brain that the engine refuses (a broken file is a broken document);
- every project touched since `--since` (commits under `projects/<slug>/` in the brain, and commits on the default
  branch of a repo the hub's frontmatter names in `repo:`/`repos:`) whose diagrams did not change in that window;
- every project with a hub but no `archdraw/` folder in the brain or its named repository;
- the newest upstream reladraw release and whether this fork has merged it.

Judgement (does that change alter the architecture? what should the diagram now say?) is the task's, not this script's.
Exit 0 when all is current, 1 when anything above needs attention.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from archdraw_studio.library import EXT, SUBDIR, Library

REPO = Path(__file__).resolve().parents[3]
BRAIN = Path(os.environ.get("BRAIN", str(Path.home() / "work" / "brain")))
PROJECTS_DIR = Path.home() / "work" / "projects"


def git(*args: str, cwd: Path) -> str:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=False)
    return r.stdout.strip() if r.returncode == 0 else ""


def since_arg(value: str) -> str:
    m = re.fullmatch(r"(\d+)([hd])", value)
    if not m:
        raise argparse.ArgumentTypeError("use e.g. 24h or 7d")
    n, unit = int(m.group(1)), m.group(2)
    return f"{n} hours ago" if unit == "h" else f"{n} days ago"


def hub_repos(hub: Path) -> list[str]:
    """`repo:` / `repos:` from the hub's frontmatter: owner/name entries, comma or list separated."""
    try:
        text = hub.read_text(errors="replace")
    except OSError:
        return []
    if not text.startswith("---"):
        return []
    front = text.split("\n---", 1)[0]
    found: list[str] = []
    in_list = False  # list items count only right under a `repos:` key with no inline value (review L4)
    for line in front.splitlines():
        m = re.match(r"^(repo|repos)\s*:\s*(.*)$", line.strip())
        if m:
            found += re.findall(r"[\w.-]+/[\w.-]+", m.group(2))
            in_list = not m.group(2).strip()
        elif in_list and re.match(r"^\s*-\s*[\w.-]+/[\w.-]+", line):
            found += re.findall(r"[\w.-]+/[\w.-]+", line)
        else:
            in_list = False
    return sorted(set(found))


def repo_head(path: Path) -> str:
    """The remote default branch when it is available, otherwise an empty string."""
    if not (path / ".git").exists():
        return ""
    head = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD", cwd=path) or "origin/main"
    return head if git("rev-parse", "--verify", "--quiet", head, cwd=path) else ""


def repo_commits(slug: str, since: str) -> int:
    """Commits on the default branch of ~/work/projects/<name> since `since` (0 when there is no checkout)."""
    path = PROJECTS_DIR / slug
    head = repo_head(path)
    if not head:
        return 0
    out = git("rev-list", "--count", f"--since={since}", head, cwd=path)
    return int(out) if out.isdigit() else 0


def repo_archdraw(slug: str, since: str) -> tuple[list[tuple[str, str]], bool]:
    """Diagram sources on origin/main and whether later repo commits make them stale.

    The repository checkout is only a cache: `git show` reads the version recorded on
    its remote-tracking default branch rather than an uncommitted local edit.
    """
    path = PROJECTS_DIR / slug
    head = repo_head(path)
    if not head:
        return [], False
    names = [
        name
        for name in git("ls-tree", "-r", "--name-only", head, "--", ".archdraw", cwd=path).splitlines()
        if name.endswith(EXT)
    ]
    if not names:
        return [], False
    files = [(name, git("show", f"{head}:{name}", cwd=path)) for name in names]
    folder_commit = git("log", "-1", "--format=%H", head, "--", ".archdraw", cwd=path)
    if not folder_commit:
        return files, False
    later = git("rev-list", "--count", f"--since={since}", f"{folder_commit}..{head}", cwd=path)
    return files, later.isdigit() and int(later) > 0


def audit(since: str) -> dict:
    lib = Library(
        root=BRAIN / "projects", engine=REPO / "dist" / "cli.js", node=os.environ.get("ARCHDRAW_NODE", "node")
    )
    broken, stale, missing = [], [], []
    for d in sorted((BRAIN / "projects").iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        folder = d / SUBDIR
        hub = d / f"{d.name}.md"
        rel = f"projects/{d.name}"
        brain_changes = git("log", f"--since={since}", "--format=%h", "--", rel, f":!{rel}/{SUBDIR}", cwd=BRAIN)
        diagram_changes = git("log", f"--since={since}", "--format=%h", "--", f"{rel}/{SUBDIR}", cwd=BRAIN)
        repos = hub_repos(hub)
        repo_folders = [(repo, *repo_archdraw(repo.split("/", 1)[1], since)) for repo in repos]
        code = sum(repo_commits(repo.split("/", 1)[1], since) for repo in repos)
        if not folder.is_dir() and not any(files for _, files, _ in repo_folders):
            if hub.is_file() and (brain_changes or code):
                missing.append({"project": d.name, "brain_commits": len(brain_changes.split()), "repo_commits": code})
            continue
        if folder.is_dir():
            for f in sorted(folder.glob(f"*{EXT}")):
                error = lib.check(f.read_text(errors="replace"))
                if error:
                    broken.append({"file": f"{rel}/{SUBDIR}/{f.name}", "error": error})
            diagrams_current = bool(diagram_changes)
            repo_stale = False
        else:
            for repo, files, _ in repo_folders:
                for name, source in files:
                    error = lib.check(source)
                    if error:
                        broken.append({"file": f"{repo}/{name}", "error": error})
            diagrams_current = any(files for _, files, _ in repo_folders)
            repo_stale = any(stale for _, _, stale in repo_folders)
        if repo_stale or ((brain_changes or code) and not diagrams_current):
            stale.append(
                {"project": d.name, "brain_commits": len(brain_changes.split()), "repo_commits": code, "repos": repos}
            )
    upstream = git("ls-remote", "--tags", "--sort=-v:refname", "upstream", "refs/tags/v*", cwd=REPO)
    tags = [ln.split("refs/tags/")[-1] for ln in upstream.splitlines() if not ln.endswith("^{}")]
    latest = tags[0] if tags else ""
    merged = (
        bool(latest)
        and subprocess.run(
            ["git", "merge-base", "--is-ancestor", latest, "HEAD"], cwd=REPO, capture_output=True, check=False
        ).returncode
        == 0
    )
    if latest and not merged:
        git("fetch", "-q", "upstream", "--tags", cwd=REPO)
        merged = (
            subprocess.run(
                ["git", "merge-base", "--is-ancestor", latest, "HEAD"], cwd=REPO, capture_output=True, check=False
            ).returncode
            == 0
        )
    return {
        "since": since,
        "broken": broken,
        "stale": stale,
        "missing": missing,
        "upstream": {"latest": latest, "merged": merged},
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    ap.add_argument("--since", type=since_arg, default="24 hours ago")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    r = audit(a.since)
    if a.json:
        print(json.dumps(r, indent=1))
    else:
        print(f"archdraw audit, changes since {r['since']}")
        for b in r["broken"]:
            print(f"  BROKEN   {b['file']}: {b['error'].splitlines()[0]}")
        for s in r["stale"]:
            print(
                f"  STALE    {s['project']}: {s['brain_commits']} brain + {s['repo_commits']} code commits, diagrams unchanged"
            )
        for m in r["missing"]:
            print(
                f"  MISSING  {m['project']}: worked on ({m['brain_commits']} brain + {m['repo_commits']} code commits), no archdraw/ yet"
            )
        u = r["upstream"]
        print(f"  UPSTREAM reladraw {u['latest'] or '?'}: {'merged' if u['merged'] else 'NOT merged into the fork'}")
    attention = r["broken"] or r["stale"] or r["missing"] or not r["upstream"]["merged"]
    return 1 if attention else 0


if __name__ == "__main__":
    sys.exit(main())
