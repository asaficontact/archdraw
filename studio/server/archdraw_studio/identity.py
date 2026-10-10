"""The tailnet identity gate (archdraw studio): every request is Tawab's, through Tailscale Serve, from one of his own devices.

`is_verified`, `forwarded_client`, `peer_uid`, `whois` and `verified_sender` are copied from
~/work/projects/ael/ael/identity.py (itself from banna_dashboard/server.py, 2026-09-18); keep in sync. Adapted here:
`verified_sender` takes a plain header mapping (Starlette's) and the peer (host, port) and resolves the forwarded
hop through `cached_whois`; `local_same_uid` and `decide`
are new: a loopback request from this box's own uid that carries no Tailscale headers may read `/api/health` (the unit
check), and everything else only when ARCHDRAW_ALLOW_LOCAL=1 (screenshot and recording runs). Anything else without
a verified identity is refused.
"""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import time
from collections.abc import Mapping

PRINCIPAL = "asaficontact@gmail.com"
AGENT_NODES = {"hetzner-dev", "trex"}
LOOPBACK = {"127.0.0.1"}  # peer_uid reads the IPv4 table only; an IPv6 or named peer fails closed
TAILSCALE_HEADERS = ("tailscale-user-login", "tailscale-user-name", "x-forwarded-for", "x-forwarded-host")


def is_verified(login: str, node: str, via_serve: bool = True) -> bool:
    return via_serve and login == PRINCIPAL and node != "" and node not in AGENT_NODES


def forwarded_client(xff: str, fallback: str) -> str:
    """The LAST X-Forwarded-For hop: Serve (Go's ReverseProxy) appends the real client; earlier
    entries are client-supplied."""
    hops = [h.strip() for h in xff.split(",") if h.strip()]
    return hops[-1] if hops else fallback


def peer_uid(port: int, server_port: int, table: str = "/proc/net/tcp") -> int | None:
    """The uid owning the ESTABLISHED loopback TCP socket `127.0.0.1:port -> 127.0.0.1:server_port` (from
    /proc/net/tcp); tailscaled's is 0. Both ends are matched: two connections may share a local ephemeral port when
    their destinations differ, so the local port alone could name another process's socket (review B1). Only state 01
    counts: a closed connection on the same port lingers in TIME_WAIT listed with uid 0."""
    if not port or not server_port:
        return None
    local, remote = f"0100007F:{port:04X}", f"0100007F:{server_port:04X}"
    try:
        for line in pathlib.Path(table).read_text().splitlines()[1:]:
            fields = line.split()
            if fields[1] == local and fields[2] == remote and fields[3] == "01":
                return int(fields[7])
    except (OSError, ValueError, IndexError):
        pass
    return None


def whois(ip: str) -> str:
    try:
        result = subprocess.run(
            ["tailscale", "whois", "--json", ip], capture_output=True, text=True, timeout=5, check=False
        )
        payload = json.loads(result.stdout or "{}")
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        return ""
    node = payload.get("Node") or {}
    return node.get("ComputedName") or str(node.get("Name", "")).split(".")[0] or ""


_WHOIS_TTL = 300.0
_whois_cache: dict[str, tuple[float, str]] = {}


def cached_whois(ip: str) -> str:
    """`whois` is a subprocess; the artifact viewer makes many requests a minute. A resolved node is remembered for
    five minutes per address; a failure is never cached."""
    now = time.monotonic()
    hit = _whois_cache.get(ip)
    if hit is not None and now - hit[0] < _WHOIS_TTL:
        return hit[1]
    node = whois(ip)
    if node:
        _whois_cache[ip] = (now, node)
    return node


def clear_cache() -> None:
    _whois_cache.clear()


def verified_sender(
    headers: Mapping[str, str], client_address: tuple[str, int], server_port: int
) -> tuple[bool, str, str, str]:
    """(ok, login, node, reason). `reason` is "not via Serve", "whois failed", "node is an agent box" or
    "wrong login"; empty when ok. Header lookups are case-insensitive in Starlette's mapping."""
    login = headers.get("Tailscale-User-Login", "") or ""
    # The peer must be a real loopback socket: a forwarded or synthetic address (proxy headers, port 0) fails closed.
    loopback_peer = client_address[0] == "127.0.0.1" and client_address[1] > 0
    via_serve = (
        loopback_peer and peer_uid(client_address[1], server_port) == 0 and bool(headers.get("X-Forwarded-Host"))
    )
    node = ""
    if via_serve:
        forwarded = forwarded_client(headers.get("X-Forwarded-For", "") or "", client_address[0])
        node = cached_whois(forwarded)

    if is_verified(login, node, via_serve):
        return True, login, node, ""
    if not via_serve:
        reason = "not via Serve"
    elif not node:
        reason = "whois failed"
    elif node in AGENT_NODES:
        reason = "node is an agent box"
    else:
        reason = "wrong login"
    return False, login, node, reason


def local_same_uid(headers: Mapping[str, str], client_address: tuple[str, int], server_port: int) -> bool:
    """A loopback request from a process of this box's own uid carrying none of Serve's headers."""
    host, port = client_address
    if host not in LOOPBACK:
        return False
    if any(headers.get(h) for h in TAILSCALE_HEADERS):
        return False
    return peer_uid(port, server_port) == os.getuid()


def decide(
    path: str, headers: Mapping[str, str], client_address: tuple[str, int], server_port: int, *, allow_local: bool
) -> tuple[bool, str]:
    """(allowed, reason) for one request; `path` is after the public prefix is stripped."""
    ok, _, _, reason = verified_sender(headers, client_address, server_port)
    if ok:
        return True, ""
    if local_same_uid(headers, client_address, server_port) and (path == "/api/health" or allow_local):
        return True, ""
    return False, reason
