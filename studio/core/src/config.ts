// The app's own state: which projects are connected and how archdraw behaves. One JSON file in the app's home
// directory, written atomically. Diagrams are never here: they live in each project's repo, in `.archdraw/`.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
export const DIAGRAM_DIR = ".archdraw"

/** Every setting Tawab may change; a project may override any of the per-project ones. */
export type Settings = {
  provider: string // the LLM provider of the user's key: openai | anthropic | google | openrouter | ...
  chatModel: string // the model the chat agent and drafts use ("" = the provider's default)
  triageModel: string // the cheap model that decides whether a range of commits changed the architecture
  syncEveryMinutes: number // 0 turns the background sync off
  dayBudgetUsd: number // all agent spending in a day, across projects
  projectDayBudgetUsd: number // one project's agent spending in a day
  conversationBudgetUsd: number // one chat conversation
  publish: "pull-request" | "direct" // how an approved update reaches the repo: a merged PR (default) or a commit on the branch
  ignore: string[] // paths the agent never reads (added to .gitignore and the built-in secret patterns)
  theme: "system" | "light" | "dark"
}

export type ProjectSettings = Partial<Pick<Settings, "chatModel" | "triageModel" | "syncEveryMinutes" | "projectDayBudgetUsd" | "publish" | "ignore">>

export type Source =
  | { kind: "github"; repo: string; url: string; branch: string } // repo = owner/name
  | { kind: "folder"; path: string } // a local folder; diagrams are written straight into it

export type Project = {
  slug: string
  title: string
  source: Source
  addedAt: number
  archived?: boolean
  settings?: ProjectSettings
  checkedThrough?: string // the last commit of the branch the sync has looked at
}

export type Config = { version: 1; projects: Project[]; settings: Settings; onboarded?: boolean }

export const DEFAULTS: Settings = {
  provider: "openai",
  chatModel: "",
  triageModel: "",
  syncEveryMinutes: 60,
  dayBudgetUsd: 10,
  projectDayBudgetUsd: 3,
  conversationBudgetUsd: 1,
  publish: "pull-request",
  ignore: [],
  theme: "system",
}

/** The app's home: ARCHDRAW_HOME, else ~/.local/share/archdraw (the Electron shell passes its userData path). */
export function appHome(): string {
  return process.env.ARCHDRAW_HOME || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "archdraw")
}

export class Store {
  readonly file: string
  private cache: Config | null = null

  constructor(readonly home: string = appHome()) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    this.file = join(home, "config.json")
  }

  read(): Config {
    if (this.cache) return this.cache
    let raw: Partial<Config> = {}
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"))
    } catch {
      /* first run */
    }
    this.cache = { version: 1, projects: raw.projects ?? [], settings: { ...DEFAULTS, ...(raw.settings ?? {}) }, onboarded: raw.onboarded }
    return this.cache
  }

  write(next: Config): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
    this.cache = next
  }

  update(fn: (c: Config) => Config | void): Config {
    const draft = structuredClone(this.read())
    const out = fn(draft) ?? draft
    this.write(out)
    return out
  }

  project(slug: string): Project | undefined {
    return this.read().projects.find(p => p.slug === slug)
  }

  /** A project's effective settings: its overrides over the global ones. */
  settingsFor(slug: string): Settings {
    const s = this.read().settings
    return { ...s, ...(this.project(slug)?.settings ?? {}) }
  }
}

export function checkSlug(value: string, what = "name"): string {
  if (!SLUG.test(value ?? "")) throw new AppError(400, `${what} must be lowercase letters, digits and dashes (got ${JSON.stringify(value)})`)
  return value
}

/** A refusal the API answers with `status`. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** A slug from a repo or folder name: "asaficontact/Ohara_App" → "ohara-app". */
export function slugFrom(name: string): string {
  const s = name.split("/").pop()!.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63)
  return s || "project"
}
