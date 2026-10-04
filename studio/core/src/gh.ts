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
    await gh(cwd, ["pr", "merge", String(number), "-R", repoOf(p), "--squash", "--delete-branch", "--subject", subject, ...(head ? ["--match-head-commit", head] : [])])
  }

  async close(p: Project, cwd: string, number: number) {
    await gh(cwd, ["pr", "close", String(number), "-R", repoOf(p), "--delete-branch"])
  }
}
