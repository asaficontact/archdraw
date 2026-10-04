import json
import sys
import time
from pathlib import Path

import pytest

from archdraw_studio import agent

FAKE = Path(__file__).parent / "fixtures" / "fake_piray.py"
GOOD = '```archdraw file=system\n// title: S\nnode a "A"\n```'
BAD = '```archdraw file=system\nnode a "A" right of nowhere\n```'


@pytest.fixture
def fake(tmp_path, monkeypatch):
    wrapper = tmp_path / "piray"
    wrapper.write_text(f"#!/bin/sh\nexec {sys.executable} {FAKE}\n")
    wrapper.chmod(0o755)
    monkeypatch.setattr(agent, "PIRAY", str(wrapper))
    monkeypatch.setattr(agent, "SECRETS", tmp_path / "no-secrets")
    log = tmp_path / "commands.jsonl"
    monkeypatch.setenv("FAKE_PIRAY_LOG", str(log))

    def answers(*texts: str) -> Path:
        monkeypatch.setenv("FAKE_PIRAY_ANSWERS", json.dumps(list(texts)))
        return log

    return answers


def check(source: str) -> str | None:
    return "line 1: no node `nowhere`" if "nowhere" in source else None


def until(c: agent.Conversation, kind: str, timeout: float = 10) -> list[dict]:
    end = time.time() + timeout
    while time.time() < end:
        if any(e["type"] == kind for e in c.events):
            return c.events
        c.wait(len(c.events) - 1, 0.5)
    raise AssertionError(f"no {kind} event in {[e['type'] for e in c.events]}")


def test_fenced_files_are_found_whole():
    text = f"Here it is.\n{GOOD}\nand the record:\n```markdown file=decisions\n# D\n- one\n```"
    found = agent.proposals(text)
    assert [(p["kind"], p["name"]) for p in found] == [("archdraw", "system"), ("markdown", "decisions")]
    assert found[0]["source"] == '// title: S\nnode a "A"\n'
    assert agent.proposals("```archdraw\nno name\n```") == []
    assert agent.proposals("```archdraw file=../etc\nx\n```") == []


def test_a_message_becomes_a_checked_proposal_and_the_cost_is_counted(fake, tmp_path):
    log = fake(GOOD)
    c = agent.Conversation(project="demo", repo=tmp_path, check=check)
    c.start()
    c.say("draw it", context="[studio] context")
    events = until(c, "proposal")
    prop = next(e for e in events if e["type"] == "proposal")
    assert prop["name"] == "system" and prop["error"] is None
    until(c, "cost")
    assert c.cost == pytest.approx(0.01)
    c.close()
    sent = [json.loads(line) for line in log.read_text().splitlines()]
    assert sent[0]["type"] == "prompt" and sent[0]["payload"]["message"].startswith("[studio] context")
    assert all(s["type"] != "follow_up" for s in sent)


def test_an_engine_refusal_goes_back_to_the_agent_before_tawab_sees_it(fake, tmp_path):
    log = fake(BAD, GOOD)
    c = agent.Conversation(project="demo", repo=tmp_path, check=check)
    c.start()
    c.say("draw it")
    until(c, "proposal")
    kinds = [e["type"] for e in c.events]
    assert kinds.index("fixing") < kinds.index("proposal")
    assert next(e for e in c.events if e["type"] == "proposal")["error"] is None
    c.close()
    prompts = [json.loads(line) for line in log.read_text().splitlines() if '"prompt"' in line]
    assert len(prompts) == 2 and "engine refused" in prompts[1]["payload"]["message"]


def test_a_file_still_refused_after_the_fixes_is_shown_with_its_error(fake, tmp_path):
    fake(BAD)
    c = agent.Conversation(project="demo", repo=tmp_path, check=check)
    c.start()
    c.say("draw it")
    until(c, "proposal")
    prop = next(e for e in c.events if e["type"] == "proposal")
    assert "nowhere" in prop["error"]
    assert sum(e["type"] == "fixing" for e in c.events) == agent.MAX_FIXES
    c.close()


def test_a_slash_message_is_not_sent_as_a_command(fake, tmp_path):
    log = fake("ok")
    c = agent.Conversation(project="demo", repo=tmp_path, check=check)
    c.start()
    c.say("/help me")
    until(c, "assistant")
    c.close()
    first = json.loads(log.read_text().splitlines()[0])
    assert not first["payload"]["message"].lstrip().startswith("/")


def test_conversations_are_saved_and_come_back_read_only(fake, tmp_path):
    fake(GOOD)
    talks = agent.Conversations(state_dir=tmp_path / "talks")
    c = talks.open("demo", tmp_path, check)
    c.say("draw it")
    until(c, "proposal")
    c.close()
    until(c, "ended")  # the reader saves once more when the worker's output ends
    time.sleep(0.2)
    assert (tmp_path / "talks" / f"{c.id}.json").exists()
    again = agent.Conversations(state_dir=tmp_path / "talks")
    back = again.get(c.id)
    assert back is not None and back.state == "closed" and back.title == "draw it"
    assert [e["type"] for e in back.events] == [e["type"] for e in c.events]
    assert again.spent_today() == pytest.approx(c.cost)


def test_the_day_budget_refuses_a_new_conversation(fake, tmp_path, monkeypatch):
    talks = agent.Conversations()
    monkeypatch.setattr(talks, "spent_today", lambda: agent.DAY_BUDGET_USD)
    with pytest.raises(RuntimeError, match="spent"):
        talks.open("demo", tmp_path, check)


def test_keys_come_only_from_an_owner_only_file(tmp_path, monkeypatch):
    f = tmp_path / "providers.env"
    f.write_text("export OPENAI_API_KEY='sk-test'\nOTHER=x\n")
    monkeypatch.setattr(agent, "SECRETS", f)
    f.chmod(0o644)
    env: dict[str, str] = {}
    agent.load_keys(env)
    assert env == {}
    f.chmod(0o600)
    agent.load_keys(env)
    assert env == {"OPENAI_API_KEY": "sk-test"}


def test_a_new_conversation_ends_the_live_one_on_the_same_project(fake, tmp_path):
    fake("ok")
    talks = agent.Conversations()
    first = talks.open("demo", tmp_path, check)
    other = talks.open("elsewhere", tmp_path / "x", check)
    second = talks.open("demo", tmp_path, check)
    assert first.state == "closed" and any(e.get("why", "").startswith("a new conversation") for e in first.events)
    assert second.state != "closed" and other.state != "closed"
    talks.close_all()
