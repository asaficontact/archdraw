import subprocess
from pathlib import Path

from archdraw_studio import audit


def test_hub_repos_reads_repo_and_repos_from_frontmatter(tmp_path: Path):
    hub = tmp_path / "x.md"
    hub.write_text(
        "---\ntype: project\nrepos: asaficontact/ohara, asaficontact/ohara-inspector\n---\n# X\nrepo: not/this\n"
    )
    assert audit.hub_repos(hub) == ["asaficontact/ohara", "asaficontact/ohara-inspector"]
    other = tmp_path / "y.md"
    other.write_text("---\nrepos:\n  - asaficontact/kestrel\naliases:\n  - not/arepo\n---\n")
    assert audit.hub_repos(other) == ["asaficontact/kestrel"]


def test_audit_flags_broken_stale_and_missing(tmp_path: Path, monkeypatch):
    brain = tmp_path / "brain"
    (brain / "projects" / "a" / "archdraw").mkdir(parents=True)
    (brain / "projects" / "a" / "a.md").write_text("# A\n")
    (brain / "projects" / "a" / "archdraw" / "ok.archdraw").write_text('node a "A"\n')
    (brain / "projects" / "b").mkdir()
    (brain / "projects" / "b" / "b.md").write_text("# B\n")
    for cmd in (
        ["init", "-q"],
        ["config", "user.email", "t@t"],
        ["config", "user.name", "t"],
        ["add", "-A"],
        ["commit", "-qm", "seed"],
    ):
        subprocess.run(["git", "-C", str(brain), *cmd], check=True)
    (brain / "projects" / "a" / "a.md").write_text("# A\nchanged\n")
    subprocess.run(["git", "-C", str(brain), "commit", "-qam", "work on a"], check=True)
    monkeypatch.setattr(audit, "BRAIN", brain)
    monkeypatch.setattr(audit, "PROJECTS_DIR", tmp_path / "none")
    r = audit.audit("1 hour ago")
    assert [m["project"] for m in r["missing"]] == ["b"]
    assert [s["project"] for s in r["stale"]] == []  # the seed commit also touched a's diagrams in the window
    assert r["broken"] == [] or all("ok.archdraw" not in b["file"] for b in r["broken"])


def test_audit_uses_repo_archdraw_when_brain_folder_is_absent(tmp_path: Path, monkeypatch):
    brain = tmp_path / "brain"
    projects = tmp_path / "projects"
    project = brain / "projects" / "ohara"
    project.mkdir(parents=True)
    (project / "ohara.md").write_text("---\nrepos: asaficontact/ohara\n---\n# Ohara\n")
    missing = brain / "projects" / "missing"
    missing.mkdir()
    (missing / "missing.md").write_text("---\nrepos: asaficontact/missing\n---\n# Missing\n")

    def commit(repo: Path, message: str) -> None:
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-qm", message], check=True)
        subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", "HEAD"], check=True)

    for repo, with_diagram in ((projects / "ohara", True), (projects / "missing", False)):
        repo.mkdir(parents=True)
        for cmd in (["init", "-q"], ["config", "user.email", "t@t"], ["config", "user.name", "t"]):
            subprocess.run(["git", "-C", str(repo), *cmd], check=True)
        (repo / "app.txt").write_text("initial\n")
        if with_diagram:
            diagram = repo / ".archdraw" / "system.archdraw"
            diagram.parent.mkdir()
            diagram.write_text('node system "System"\n')
        commit(repo, "initial")

    for cmd in (
        ["init", "-q"],
        ["config", "user.email", "t@t"],
        ["config", "user.name", "t"],
        ["add", "-A"],
        ["commit", "-qm", "initial"],
    ):
        subprocess.run(["git", "-C", str(brain), *cmd], check=True)
    monkeypatch.setattr(audit, "BRAIN", brain)
    monkeypatch.setattr(audit, "PROJECTS_DIR", projects)

    first = audit.audit("1 hour ago")
    assert [m["project"] for m in first["missing"]] == ["missing"]
    assert first["stale"] == []

    (projects / "ohara" / "app.txt").write_text("changed\n")
    commit(projects / "ohara", "change code")
    stale = audit.audit("1 hour ago")
    assert [s["project"] for s in stale["stale"]] == ["ohara"]

    (projects / "ohara" / ".archdraw" / "system.archdraw").write_text("not archdraw syntax\n")
    commit(projects / "ohara", "break diagram")
    broken = audit.audit("1 hour ago")
    assert [b["file"] for b in broken["broken"]] == ["asaficontact/ohara/.archdraw/system.archdraw"]
    assert broken["stale"] == []
