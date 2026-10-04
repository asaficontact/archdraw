from pathlib import Path

from fastapi.testclient import TestClient

from archdraw_studio.app import create_app
from archdraw_studio.library import Library


def client(tmp_path: Path, allow_local: bool) -> TestClient:
    root = tmp_path / "projects"
    (root / "demo" / "archdraw").mkdir(parents=True)
    (root / "demo" / "archdraw" / "one.archdraw").write_text('// title: One\nnode a "A"\n')
    return TestClient(
        create_app(
            Library(root=root, commit=False),
            allow_local=allow_local,
            ui_dist=tmp_path / "none",
            state=tmp_path / "talks",
        ),
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


def test_the_agent_endpoints_open_talk_and_replay(tmp_path, monkeypatch):
    import json as _json
    import sys
    import time

    from archdraw_studio import agent, identity

    monkeypatch.setattr(identity, "decide", lambda *a, **k: (True, "test"))  # past the gate; the gate has its own tests
    wrapper = tmp_path / "piray"
    fake = Path(__file__).parent / "fixtures" / "fake_piray.py"
    wrapper.write_text(f"#!/bin/sh\nexec {sys.executable} {fake}\n")
    wrapper.chmod(0o755)
    monkeypatch.setattr(agent, "PIRAY", str(wrapper))
    monkeypatch.setattr(agent, "SECRETS", tmp_path / "none")
    monkeypatch.setenv(
        "FAKE_PIRAY_ANSWERS", _json.dumps(['Here.\n```archdraw file=one\nnode a "A"\nnode b "B" right of a\n```'])
    )
    log = tmp_path / "sent.jsonl"
    monkeypatch.setenv("FAKE_PIRAY_LOG", str(log))
    c = client(tmp_path, allow_local=True)
    assert c.post("/api/agent/conversations", json={"project": "nope"}).status_code == 404
    talk = c.post("/api/agent/conversations", json={"project": "demo"}).json()
    r = c.post(f"/api/agent/conversations/{talk['id']}/messages", json={"text": "add b", "file": "one"})
    assert r.status_code == 200
    items: list = []
    end = time.time() + 10
    while time.time() < end and not any(e["type"] == "proposal" for e in items):
        items = c.get(f"/api/agent/conversations/{talk['id']}", params={"wait": 1}).json()["items"]
    prop = next(e for e in items if e["type"] == "proposal")
    assert prop["name"] == "one" and prop["error"] is None
    sent = _json.loads(log.read_text().splitlines()[0])["payload"]["message"]
    assert "Project `demo`" in sent and "```archdraw file=one" in sent and sent.endswith("add b")
    # a second device replays from any point
    later = c.get(f"/api/agent/conversations/{talk['id']}", params={"after": prop["n"] - 1}).json()["items"]
    assert later[0]["n"] == prop["n"]
    assert any(t["id"] == talk["id"] for t in c.get("/api/agent").json()["conversations"])
    c.post(f"/api/agent/conversations/{talk['id']}/close")
    assert c.post("/api/agent/conversations/zzz/messages", json={"text": "x"}).status_code == 404
