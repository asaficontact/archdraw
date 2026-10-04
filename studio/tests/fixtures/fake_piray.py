"""A stand-in for `piray rpc run`: speaks protocol v1 JSONL with scripted answers, for the bridge's tests.

Each prompt is answered with the next entry of FAKE_PIRAY_ANSWERS (a JSON list of strings), costing $0.01 a turn.
A prompt that arrives while a turn is open is rejected with INVALID_STATE, as the real worker does."""

import json
import os
import sys

answers = json.loads(os.environ.get("FAKE_PIRAY_ANSWERS", '["ok"]'))
seq, turn, cost = 0, 0, 0.0
prompts_log = os.environ.get("FAKE_PIRAY_LOG")


def emit(kind, payload):
    global seq
    seq += 1
    print(json.dumps({"schema_version": 1, "sequence": seq, "type": kind, "payload": payload}), flush=True)


emit("run_started", {"model": "fake/model", "state": {"phase": "ready", "activity": "idle"}})
for line in sys.stdin:
    cmd = json.loads(line)
    kind, cid = cmd["type"], cmd["id"]
    if prompts_log:
        with open(prompts_log, "a") as f:
            f.write(json.dumps(cmd) + "\n")
    if kind == "prompt":
        emit("command_result", {"command_id": cid, "command_type": "prompt", "status": "accepted"})
        emit("state_changed", {"phase": "ready", "activity": "busy", "streaming": True})
        text = answers[min(turn, len(answers) - 1)]
        mid = f"message-{turn}"
        emit("message_started", {"message_id": mid, "role": "assistant"})
        emit("message_delta", {"message_id": mid, "content_index": 0, "text": text})
        emit("message_completed", {"message_id": mid, "text": text, "stop_reason": "stop"})
        turn += 1
        cost += 0.01
        emit("state_changed", {"phase": "ready", "activity": "idle", "streaming": False})
        emit("agent_settled", {"cycle": turn})
    elif kind == "get_usage":
        emit(
            "command_result",
            {
                "command_id": cid,
                "command_type": "get_usage",
                "status": "ok",
                "result": {"kind": "usage", "usage": {"cost": cost}},
            },
        )
    elif kind == "close":
        emit("command_result", {"command_id": cid, "command_type": "close", "status": "accepted"})
        emit("run_ended", {"exit_reason": "closed", "exit_code": 0})
        break
