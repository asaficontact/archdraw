import subprocess
from pathlib import Path

import pytest

from archdraw_studio.library import Library, LibraryError, digest, meta

REPO = Path(__file__).resolve().parents[2]
ENGINE = REPO / "dist" / "cli.js"
GOOD = '// title: Tiny\n// summary: Two boxes.\n\nnode a "A"\nnode b "B" right of a\nedge a -> b\n'


def brain(tmp: Path) -> Path:
    root = tmp / "brain"
    (root / "projects" / "demo" / "archdraw").mkdir(parents=True)
    (root / "projects" / "demo" / "demo.md").write_text("# Demo project\n")
    (root / "projects" / "demo" / "archdraw" / "one.archdraw").write_text(GOOD)
    (root / "projects" / "notes-only").mkdir()
    for cmd in (
        ["init", "-q"],
        ["config", "user.email", "t@t"],
        ["config", "user.name", "t"],
        ["add", "-A"],
        ["commit", "-qm", "seed"],
    ):
        subprocess.run(["git", "-C", str(root), *cmd], check=True)
    return root / "projects"


def test_meta_reads_the_leading_comments_only():
    assert meta(GOOD) == {"title": "Tiny", "summary": "Two boxes."}
    assert meta('node a "A"\n// title: late\n') == {}


def test_projects_are_brain_folders_with_an_archdraw_dir(tmp_path):
    lib = Library(root=brain(tmp_path))
    [p] = lib.projects()
    assert p["slug"] == "demo" and p["title"] == "Demo project" and p["files"] == 1


def test_files_and_read(tmp_path):
    lib = Library(root=brain(tmp_path))
    [f] = lib.files("demo")
    assert f["name"] == "one" and f["title"] == "Tiny" and f["summary"] == "Two boxes."
    d = lib.read("demo", "one")
    assert d["source"] == GOOD and d["version"] == digest(GOOD)


def test_names_are_slugs_so_no_path_escapes(tmp_path):
    lib = Library(root=brain(tmp_path))
    for bad in ("../x", "A", "a/b", "", ".hidden"):
        with pytest.raises(LibraryError):
            lib.read("demo", bad)
        with pytest.raises(LibraryError):
            lib.files(bad)


@pytest.mark.skipif(not ENGINE.is_file(), reason="engine not built (npm run build)")
def test_save_checks_with_the_engine_and_commits_only_that_path(tmp_path):
    root = brain(tmp_path)
    lib = Library(root=root, engine=ENGINE)
    other = root / "demo" / "demo.md"
    other.write_text("# Demo project\nunrelated edit\n")
    subprocess.run(["git", "-C", str(root.parent), "add", str(other)], check=True)  # another writer's staged work
    with pytest.raises(LibraryError) as bad:
        lib.save("demo", "two", 'node a "A" right of b\n', None, "tester")
    assert bad.value.status == 422 and bad.value.message.startswith("diagram:1:")
    out = lib.save("demo", "two", GOOD, None, "tester")
    assert out["commit"]
    shown = subprocess.run(
        ["git", "-C", str(root.parent), "show", "--name-only", "--format=%B", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
    ).stdout
    assert "projects/demo/archdraw/two.archdraw" in shown and "demo.md" not in shown and "Agent: Banna" in shown
    staged = subprocess.run(
        ["git", "-C", str(root.parent), "diff", "--cached", "--name-only"], capture_output=True, text=True, check=False
    ).stdout
    assert "projects/demo/demo.md" in staged  # the other writer's staged file is left as it was


def test_save_refuses_a_stale_base(tmp_path):
    lib = Library(root=brain(tmp_path), commit=False)
    with pytest.raises(LibraryError) as stale:
        lib.save("demo", "one", GOOD + "// more\n", "0000000000000000", "tester")
    assert stale.value.status == 409
    ok = lib.save("demo", "one", GOOD + "// more\n", digest(GOOD), "tester")
    assert ok["version"] != digest(GOOD)


def test_create_project_writes_a_starter_that_renders(tmp_path):
    lib = Library(root=brain(tmp_path), engine=ENGINE if ENGINE.is_file() else None)
    lib.create_project("newthing", "tester")
    [f] = lib.files("newthing")
    assert f["name"] == "overview"
    if ENGINE.is_file():
        assert lib.check(lib.read("newthing", "overview")["source"]) is None
    with pytest.raises(LibraryError) as dup:
        lib.create_project("newthing", "tester")
    assert dup.value.status == 409


def test_a_new_file_never_overwrites_an_existing_one(tmp_path):
    lib = Library(root=brain(tmp_path), commit=False)
    with pytest.raises(LibraryError) as clash:
        lib.save("demo", "one", GOOD + "// overwrite\n", None, "tester")
    assert clash.value.status == 409
    assert lib.read("demo", "one")["source"] == GOOD


def test_a_symlinked_folder_is_refused(tmp_path):
    root = brain(tmp_path)
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    (root / "linked").mkdir()
    (root / "linked" / "archdraw").symlink_to(outside)
    lib = Library(root=root, commit=False)
    with pytest.raises(LibraryError) as bad:
        lib.save("linked", "x", GOOD, None, "tester")
    assert bad.value.status == 400 and not list(outside.iterdir())


@pytest.mark.skipif(not ENGINE.is_file(), reason="engine not built (npm run build)")
def test_a_failed_commit_puts_the_file_back_and_unstages_it(tmp_path):
    root = brain(tmp_path)
    hook = root.parent / ".git" / "hooks" / "pre-commit"
    hook.write_text("#!/bin/sh\nexit 1\n")
    hook.chmod(0o755)
    lib = Library(root=root, engine=ENGINE)
    with pytest.raises(LibraryError) as failed:
        lib.save("demo", "one", GOOD + "// changed\n", digest(GOOD), "tester")
    assert failed.value.status == 500
    assert (root / "demo" / "archdraw" / "one.archdraw").read_text() == GOOD
    staged = subprocess.run(
        ["git", "-C", str(root.parent), "diff", "--cached", "--name-only"], capture_output=True, text=True, check=False
    ).stdout
    assert staged == ""
    with pytest.raises(LibraryError):
        lib.save("demo", "two", GOOD, None, "tester")
    assert not (root / "demo" / "archdraw" / "two.archdraw").exists()


def test_an_engine_that_cannot_run_is_a_503_not_a_crash(tmp_path):
    lib = Library(root=brain(tmp_path), engine=ENGINE, node="/no/such/node", commit=False)
    with pytest.raises(LibraryError) as down:
        lib.save("demo", "one", GOOD + "// x\n", digest(GOOD), "tester")
    assert down.value.status == 503


def test_an_icon_read_from_a_file_is_refused_before_the_engine_runs(tmp_path):
    lib = Library(root=brain(tmp_path), commit=False)
    assert "pasted" in (lib.check('icon x "/etc/hostname"\nnode a "A" icon: x\n') or "")
    pasted = 'icon x """<svg viewBox="0 0 1 1"/>"""\nnode a "A"\n'
    assert "pasted" not in (lib.check(pasted) or "")  # a pasted icon is not refused by this rule


def test_a_held_lock_is_a_503_after_the_wait(tmp_path):
    import fcntl

    root = brain(tmp_path)
    lib = Library(root=root, lock_wait=0.3)
    with open(root.parent / ".git" / "brain-write.lock", "a") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        with pytest.raises(LibraryError) as busy:
            lib.save("demo", "one", GOOD + "// y\n", digest(GOOD), "tester")
    assert busy.value.status == 503
    assert lib.read("demo", "one")["source"] == GOOD
