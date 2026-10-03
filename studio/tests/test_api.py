from pathlib import Path

from fastapi.testclient import TestClient

from archdraw_studio.app import create_app
from archdraw_studio.library import Library


def client(tmp_path: Path, allow_local: bool) -> TestClient:
    root = tmp_path / "projects"
    (root / "demo" / "archdraw").mkdir(parents=True)
    (root / "demo" / "archdraw" / "one.archdraw").write_text('// title: One\nnode a "A"\n')
    return TestClient(
        create_app(Library(root=root, commit=False), allow_local=allow_local, ui_dist=tmp_path / "none"),
        client=("10.1.2.3", 5555),
    )


def test_a_request_without_a_verified_identity_is_refused(tmp_path):
    c = client(tmp_path, allow_local=False)
    r = c.get("/api/projects")
    assert r.status_code == 403 and "refused" in r.json()["detail"]
    assert c.put("/api/projects/demo/files/one", json={"source": "x"}).status_code == 403


def test_forged_tailscale_headers_from_off_box_are_refused(tmp_path):
    c = client(tmp_path, allow_local=True)
    r = c.get("/api/projects", headers={"Tailscale-User-Login": "asaficontact@gmail.com", "X-Forwarded-Host": "x"})
    assert r.status_code == 403
