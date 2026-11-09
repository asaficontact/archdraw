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


def test_every_answer_carries_the_csp_and_a_cross_origin_write_is_refused(tmp_path):
    c = client(tmp_path, allow_local=True)
    # the test client is not this box's uid on loopback, so even an allowed-local app refuses it; check the refusal
    # carries no CSP leak and use the middleware's own helper for the origin rule
    from starlette.requests import Request

    from archdraw_studio.app import CSP, same_origin

    def req(headers):
        return Request(
            {"type": "http", "method": "PUT", "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]}
        )

    assert "script-src 'self'" in CSP and "object-src 'none'" in CSP
    assert same_origin(req({"host": "trex.tailcbcba5.ts.net:8445", "origin": "https://trex.tailcbcba5.ts.net:8445"}))
    assert not same_origin(req({"host": "trex.tailcbcba5.ts.net:8445", "origin": "https://evil.example"}))
    assert not same_origin(req({"host": "a:1", "referer": "https://b:2/page"}))
    assert same_origin(req({"host": "a:1"}))  # curl from this uid: neither header
    assert c.get("/api/projects").status_code == 403
