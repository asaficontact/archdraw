// Git, run as the user's own `git` binary so their SSH keys and credential helpers work (as GitButler does). Every
// call is a fixed argument list, never a shell string, and turns off the repo-local settings that can run code
// (fsmonitor, external diff, textconv, hooks), because the repos are other people's code.

import { spawn } from "node:child_process"

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.filter(a => !a.startsWith("-c")).slice(0, 3).join(" ")} failed (${code}): ${stderr.trim().slice(0, 400)}`)
  }
}

const SAFE = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "diff.external=",
  "-c", "core.pager=cat",
  "-c", "color.ui=false",
  "-c", "protocol.file.allow=user",
]

export type GitResult = { stdout: string; stderr: string; code: number }

/** Run git in `cwd`. Rejects with GitError on a non-zero exit unless `ok` lists that code. */
export function git(cwd: string, args: string[], opts: { input?: string; ok?: number[]; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...SAFE, ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0", // never wait for a password prompt nobody can see
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
        ...opts.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8").on("data", d => (stdout += d))
    child.stderr.setEncoding("utf8").on("data", d => (stderr += d))
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 120_000)
    child.on("error", e => {
      clearTimeout(timer)
      reject(new GitError(args, null, String(e)))
    })
    child.on("close", code => {
      clearTimeout(timer)
      const c = code ?? -1
      if (c === 0 || opts.ok?.includes(c)) resolve({ stdout, stderr, code: c })
      else reject(new GitError(args, c, stderr || stdout))
    })
    child.stdin.end(opts.input ?? "")
  })
}

/** A file's content at a commit-ish, or null when it is not there. */
export async function show(cwd: string, rev: string, path: string): Promise<string | null> {
  const r = await git(cwd, ["show", `${rev}:${path}`], { ok: [128] })
  return r.code === 0 ? r.stdout : null
}

/** Names of the files under `dir` at `rev` (not recursive), or [] when the folder is not there. */
export async function lsTree(cwd: string, rev: string, dir: string): Promise<string[]> {
  const r = await git(cwd, ["ls-tree", "--name-only", `${rev}:${dir}`], { ok: [128] })
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : []
}

export async function revParse(cwd: string, rev: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { ok: [1, 128] })
  return r.code === 0 ? r.stdout.trim() : null
}

/** Unix time of the last commit at `rev` touching `path`, or 0. */
export async function lastChange(cwd: string, rev: string, path: string): Promise<number> {
  const r = await git(cwd, ["log", "-1", "--format=%ct", rev, "--", path], { ok: [128] })
  return Number(r.stdout.trim()) || 0
}
