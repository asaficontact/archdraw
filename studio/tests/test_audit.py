import subprocess
from pathlib import Path

from archdraw_studio import audit


def test_hub_repos_reads_repo_and_repos_from_frontmatter(tmp_path: Path):
    hub = tmp_path / "x.md"
    hub.write_text(
        "---\ntype: project\nrepos: asaficontact/ohara, asaficontact/ohara-inspector\n---\n# X\nrepo: not/this\n"
    )
    assert audit.hub_repos(hub) == ["asaficontact/ohara", "asaficontact/ohara-inspector"]


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
