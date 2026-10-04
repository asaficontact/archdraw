// Who may use this server. Three modes:
//
//   tailnet  the trex deployment: every request is Tawab's, through Tailscale Serve, from one of his own devices
//            (ported from studio/server/archdraw_studio/identity.py, itself from ael and banna_dashboard); a loopback
//            request from this box's own uid may read /api/health, and everything when ARCHDRAW_ALLOW_LOCAL=1
//   token    the desktop app: the Electron shell starts this server on 127.0.0.1 with a per-launch secret, opens its
//            window at /?token=<secret>, and every request must carry the cookie that sets; the Host header must be
//            the loopback address (no DNS rebinding)
//   local    tests and development only: same-uid loopback

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

export const PRINCIPAL = process.env.ARCHDRAW_PRINCIPAL || "asaficontact@gmail.com"
const AGENT_NODES = new Set(["hetzner-dev", "trex"])
const TAILSCALE_HEADERS = ["tailscale-user-login", "tailscale-user-name", "x-forwarded-for", "x-forwarded-host"]

export type Headers = { get(name: string): string | null | undefined }

export function isVerified(login: string, node: string, viaServe: boolean): boolean {
  return viaServe && login === PRINCIPAL && node !== "" && !AGENT_NODES.has(node)
}

/** The LAST X-Forwarded-For hop: Serve appends the real client; earlier entries are client-supplied. */
export function forwardedClient(xff: string, fallback: string): string {
  const hops = xff.split(",").map(h => h.trim()).filter(Boolean)
  return hops.length ? hops[hops.length - 1] : fallback
}

/** The uid owning the ESTABLISHED loopback socket 127.0.0.1:port -> 127.0.0.1:serverPort (tailscaled's is 0). */
export function peerUid(port: number, serverPort: number, table = "/proc/net/tcp"): number | null {
  if (!port || !serverPort) return null
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0")
  const local = `0100007F:${hex(port)}`
  const remote = `0100007F:${hex(serverPort)}`
  try {
    for (const line of readFileSync(table, "utf8").split("\n").slice(1)) {
      const f = line.trim().split(/\s+/)
      if (f[1] === local && f[2] === remote && f[3] === "01") return Number(f[7])
    }
  } catch {
    /* not Linux, or no /proc */
  }
  return null
}

const whoisCache = new Map<string, [number, string]>()

function whois(ip: string): Promise<string> {
  return new Promise(resolve => {
    const child = spawn("tailscale", ["whois", "--json", ip], { stdio: ["ignore", "pipe", "ignore"] })
    let out = ""
    const t = setTimeout(() => child.kill(), 5000)
    child.stdout.setEncoding("utf8").on("data", d => (out += d))
    child.on("error", () => resolve(""))
    child.on("close", () => {
      clearTimeout(t)
      try {
        const node = JSON.parse(out || "{}").Node ?? {}
        resolve(node.ComputedName || String(node.Name ?? "").split(".")[0] || "")
      } catch {
        resolve("")
      }
    })
  })
}

/** whois is a subprocess: a resolved node is remembered for five minutes; a failure is never cached. */
export async function cachedWhois(ip: string, lookup = whois): Promise<string> {
  const hit = whoisCache.get(ip)
  if (hit && performance.now() - hit[0] < 300_000) return hit[1]
  const node = await lookup(ip)
  if (node) whoisCache.set(ip, [performance.now(), node])
  return node
}

export type Peer = { address: string; port: number; serverPort: number }

export async function verifiedSender(h: Headers, peer: Peer, lookup = whois): Promise<{ ok: boolean; login: string; node: string; reason: string }> {
  const login = h.get("tailscale-user-login") ?? ""
  const loopbackPeer = peer.address === "127.0.0.1" && peer.port > 0
  const viaServe = loopbackPeer && peerUid(peer.port, peer.serverPort) === 0 && !!h.get("x-forwarded-host")
  let node = ""
  if (viaServe) node = await cachedWhois(forwardedClient(h.get("x-forwarded-for") ?? "", peer.address), lookup)
  if (isVerified(login, node, viaServe)) return { ok: true, login, node, reason: "" }
  const reason = !viaServe ? "not via Serve" : !node ? "whois failed" : AGENT_NODES.has(node) ? "node is an agent box" : "wrong login"
  return { ok: false, login, node, reason }
}

export function localSameUid(h: Headers, peer: Peer): boolean {
  if (peer.address !== "127.0.0.1") return false
  if (TAILSCALE_HEADERS.some(k => h.get(k))) return false
  return peerUid(peer.port, peer.serverPort) === process.getuid?.()
}

export type Gate = { mode: "tailnet"; allowLocal: boolean } | { mode: "token"; token: string } | { mode: "local" }

/** Allowed, and who; or refused, and why. `cookie` is the request's archdraw cookie (token mode). */
export async function decide(gate: Gate, path: string, h: Headers, peer: Peer, cookie: string | undefined, query: string | null): Promise<{ ok: boolean; who: string; reason: string }> {
  if (gate.mode === "token") {
    const host = (h.get("host") ?? "").split(":")[0]
    if (host !== "127.0.0.1" && host !== "localhost") return { ok: false, who: "", reason: "wrong host" }
    if (cookie === gate.token || query === gate.token) return { ok: true, who: "you", reason: "" }
    return { ok: false, who: "", reason: "no session" }
  }
  // local: this machine's own user on loopback, never a request that came through Tailscale Serve (review of #2 F7)
  if (gate.mode === "local") return localSameUid(h, peer) ? { ok: true, who: "local", reason: "" } : { ok: false, who: "", reason: "not this machine's user" }
  const v = await verifiedSender(h, peer)
  if (v.ok) return { ok: true, who: v.login, reason: "" }
  if (localSameUid(h, peer) && (path === "/api/health" || gate.allowLocal)) return { ok: true, who: "archdraw (local)", reason: "" }
  return { ok: false, who: "", reason: v.reason }
}

/** A write must come from the app's own page: when the browser names an Origin (or Referer), its host must match. */
export function sameOrigin(h: Headers): boolean {
  const host = h.get("x-forwarded-host") || h.get("host") || ""
  let origin = h.get("origin") || ""
  if (!origin) {
    const ref = h.get("referer") || ""
    origin = ref ? ref.split("/").slice(0, 3).join("/") : ""
  }
  if (!origin || origin === "null") return !origin
  return origin.split("://").pop()!.replace(/\/$/, "") === host
}
