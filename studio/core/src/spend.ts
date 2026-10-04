// What the agent has spent, per day and per project, against the caps in Settings. Costs come from the provider's
// usage on every assistant message (pi-ai prices it per model), so the ledger is in dollars, not tokens.

import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Store } from "./config.js"

type Day = { total: number; projects: Record<string, number> }

export class Spend {
  private file: string
  constructor(private store: Store) {
    this.file = join(store.home, "spend.json")
  }

  private all(): Record<string, Day> {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"))
    } catch {
      return {}
    }
  }

  static today(now = new Date()): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`
  }

  day(date = Spend.today()): Day {
    return this.all()[date] ?? { total: 0, projects: {} }
  }

  add(project: string, usd: number): void {
    if (!(usd > 0)) return
    const all = this.all()
    const key = Spend.today()
    const d = all[key] ?? { total: 0, projects: {} }
    d.total += usd
    d.projects[project] = (d.projects[project] ?? 0) + usd
    all[key] = d
    // keep 60 days
    for (const k of Object.keys(all).sort().slice(0, -60)) delete all[k]
    const tmp = this.file + ".tmp"
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /** Why the agent may not spend more on this project today, or null when it may. */
  refusal(project: string): string | null {
    const s = this.store.settingsFor(project)
    const d = this.day()
    if (d.total >= s.dayBudgetUsd) return `today's $${s.dayBudgetUsd.toFixed(2)} for the agent is spent (Settings → Budget)`
    if ((d.projects[project] ?? 0) >= s.projectDayBudgetUsd) return `today's $${s.projectDayBudgetUsd.toFixed(2)} for this project is spent (Settings → Budget)`
    return null
  }
}
