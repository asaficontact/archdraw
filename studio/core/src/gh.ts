// Pull requests through the `gh` CLI, for the internal build: this machine's GitHub login opens, merges and closes
// the waiting update's pull request. (The product's GitHub App with device flow is a later Forge.)

import { spawn } from "node:child_process"
import { AppError, type Project } from "./config.js"
import type { Forge } from "./library.js"
import { UPDATE_BRANCH } from "./library.js"

function gh(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { cwd, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    let err = ""
    child.stdout.setEncoding("utf8").on("data", d => (out += d))
    child.stderr.setEncoding("utf8").on("data", d => (err += d))
    const t = setTimeout(() => child.kill("SIGTERM"), 120_000)
    child.on("error", e => {
      clearTimeout(t)
      reject(new AppError(501, `gh is not available on this machine (${e.message})`))
    })
    child.on("close", code => {
      clearTimeout(t)
      if (code === 0) resolve(out)
      else reject(new AppError(502, `gh ${args[0]} ${args[1] ?? ""} failed: ${(err || out).trim().slice(0, 300)}`))
    })
  })
}

const repoOf = (p: Project) => (p.source.kind === "github" ? p.source.repo : "")

export class GhForge implements Forge {
  async pullRequest(p: Project, cwd: string) {
    const out = await gh(cwd, ["pr", "list", "-R", repoOf(p), "--head", UPDATE_BRANCH, "--state", "open", "--json", "number,url,state", "--limit", "1"])
    const rows = JSON.parse(out || "[]") as { number: number; url: string; state: string }[]
    return rows[0] ?? null
  }

  async ensurePullRequest(p: Project, cwd: string, title: string, body: string) {
    const open = await this.pullRequest(p, cwd)
    if (open) return open
    const base = p.source.kind === "github" ? p.source.branch : "main"
    const url = (await gh(cwd, ["pr", "create", "-R", repoOf(p), "--head", UPDATE_BRANCH, "--base", base, "--title", title, "--body", body])).trim().split("\n").pop()!
    const number = Number(url.split("/").pop())
    return { number, url, state: "OPEN" }
  }

  async merge(p: Project, cwd: string, number: number, subject: string, head?: string) {
    // only the commit the user reviewed: a branch that moved since is refused by GitHub (review of #2 F3)
    try {
      await gh(cwd, ["pr", "merge", String(number), "-R", repoOf(p), "--squash", "--delete-branch", "--subject", subject, ...(head ? ["--match-head-commit", head] : [])])
    } catch (e) {
      if (!/not mergeable|branch policy|required status|review is required/i.test(String((e as Error).message))) throw e
      throw new AppError(409, await this.whyBlocked(p, cwd, number))
    }
  }

  /** What GitHub is waiting for before it merges: the required checks that failed or are still running. */
  async whyBlocked(p: Project, cwd: string, number: number): Promise<string> {
    const view = await gh(cwd, ["pr", "view", String(number), "-R", repoOf(p), "--json", "statusCheckRollup,reviewDecision"]).catch(() => "")
    return blockedReason(repoOf(p), number, view)
  }

  async close(p: Project, cwd: string, number: number) {
    await gh(cwd, ["pr", "close", String(number), "-R", repoOf(p), "--delete-branch"])
  }
}

type Check = { name?: string; context?: string; state?: string; conclusion?: string; status?: string; description?: string }

/** The plain-language reason a pull request cannot merge, from `gh pr view --json statusCheckRollup,reviewDecision`. */
export function blockedReason(repo: string, number: number, view: string): string {
  const base = `GitHub will not merge pull request #${number} yet: ${repo}'s main branch has rules it does not meet`
  let v: { statusCheckRollup?: Check[]; reviewDecision?: string } = {}
  try {
    v = JSON.parse(view)
  } catch {
    return `${base}. Open the pull request to see what it needs.`
  }
  const checks = v.statusCheckRollup ?? []
  const failed = checks.filter(c => /FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED/.test(c.conclusion || c.state || ""))
  const running = checks.filter(c => (c.status ? c.status !== "COMPLETED" : /PENDING|EXPECTED/.test(c.state ?? "")))
  const name = (c: Check) => `${c.name || c.context}${c.description ? ` (${c.description})` : ""}`
  if (failed.length) return `${base}. Checks failed: ${failed.map(name).join("; ")}. Open the pull request to see why; approve again once they pass.`
  if (running.length) return `${base}. Checks still running: ${running.map(name).join("; ")}. Approve again in a few minutes.`
  if (v.reviewDecision === "REVIEW_REQUIRED" || v.reviewDecision === "CHANGES_REQUESTED") return `${base}: it needs an approving review on GitHub first.`
  return `${base}. Open the pull request to see what it needs.`
}
