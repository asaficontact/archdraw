// "Bean There", the sample project the tour teaches on. It is a real git project (a local repo and its own "origin"),
// built from the bundled files every time the tour starts, so everything in it is real — the canvas, the editor, the
// waiting update and its colored diff, Approve — except the agent's replies, which are scripted and say so, and the
// hourly sync, which is off. Nothing about it reaches GitHub or an AI provider.

import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, createModels } from "@earendil-works/pi-ai"
import { assetsDir } from "./agent.js"
import { DIAGRAM_DIR, type Project } from "./config.js"
import type { Library } from "./library.js"

export const SAMPLE = "bean-there"

function sh(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "archdraw", GIT_AUTHOR_EMAIL: "archdraw@users.noreply.github.com", GIT_COMMITTER_NAME: "archdraw", GIT_COMMITTER_EMAIL: "archdraw@users.noreply.github.com" },
  })
}

function copyDiagrams(from: string, to: string) {
  mkdirSync(join(to, DIAGRAM_DIR), { recursive: true })
  for (const f of readdirSync(from)) {
    if (f === "README.md") cpSync(join(from, f), join(to, DIAGRAM_DIR, "README.md"))
    else cpSync(join(from, f), join(to, DIAGRAM_DIR, f))
  }
}

/** Build the sample from the bundle (replacing any previous one) and connect it. */
export async function installSample(lib: Library): Promise<Project> {
  const src = join(assetsDir(), "sample", SAMPLE)
  if (!existsSync(src)) throw new Error("this build has no sample project")
  const existing = lib.store.project(SAMPLE)
  if (existing && !existing.sample) throw new Error(`a project called ${SAMPLE} is not the sample; rename it to replay the tour`) // review of #2 F8
  if (existing) await lib.disconnect(SAMPLE)
  const dir = join(lib.store.home, "sample")
  rmSync(dir, { recursive: true, force: true })
  const seed = join(dir, "seed")
  mkdirSync(join(seed, "src"), { recursive: true })
  copyDiagrams(join(src, "main"), seed)
  writeFileSync(join(seed, "src", "orders.ts"), "// the Orders API (sample)\nexport async function placeOrder(order) { await charge(order); await queue.push(order) }\n")
  writeFileSync(join(seed, "README.md"), "# Bean There\n\nA sample project that ships with archdraw.\n")
  sh(seed, "init", "-q", "-b", "main")
  sh(seed, "add", "-A")
  sh(seed, "commit", "-q", "-m", "Bean There: the first diagrams")
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: seed, encoding: "utf8" }).trim()
  // the waiting update: the hourly check "found" a delivery partner (scripted for the tour)
  sh(seed, "checkout", "-q", "-b", "archdraw/update")
  copyDiagrams(join(src, "update"), seed)
  sh(seed, "add", "-A")
  sh(seed, "commit", "-q", "-m", `archdraw: delivery orders now come from a delivery partner\n\nSample: drafted for the tour, not by a real check.\n\nArchdraw-Base: ${base}\nAgent: archdraw`)
  sh(seed, "checkout", "-q", "main")
  sh(dir, "clone", "-q", "--bare", seed, join(dir, "origin.git"))
  const p = await lib.addRepo(join(dir, "origin.git"), { slug: SAMPLE, title: "Bean There", reserved: true })
  lib.store.update(c => {
    const x = c.projects.find(q => q.slug === p.slug)!
    x.sample = true
    x.settings = { syncEveryMinutes: 0, publish: "direct" }
  })
  await lib.refresh(SAMPLE)
  return lib.store.project(SAMPLE)!
}

/** The scripted agent for the sample: a few honest, labelled answers, never a model call. */
export function demoAgent() {
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const loyalty = readFileSync(join(assetsDir(), "sample", SAMPLE, "loyalty.archdraw"), "utf8")
  const note = "\n\n_Demo · scripted reply, no AI used. Add your key in Settings to talk to the real agent about your own projects._"
  return {
    models,
    model: faux.getModel(),
    /** Queue the replies for one user message. */
    script(text: string) {
      const t = text.toLowerCase()
      if (t.includes("loyal")) {
        faux.setResponses([
          fauxAssistantMessage([fauxToolCall("read_diagram", { name: "overview" })], { stopReason: "toolUse" }),
          fauxAssistantMessage(
            [
              fauxToolCall("propose_diagram", {
                name: "overview",
                source: loyalty,
                explanation: "# Bean There, the whole system\n\n## Purpose\n\nThe one picture of where everything runs, now with loyalty points.\n\n## Key flow\n\n1. An order is paid.\n2. The Orders API tells the Loyalty service.\n3. The Loyalty service adds points in the Points DB.\n",
              }),
            ],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage([fauxText(`- Added a **Loyalty service** that hears about every paid order.\n- Added a **Points DB** where it keeps each customer's points.\n\nIt is beside the current overview on the canvas: Accept saves it.${note}`)]),
        ])
      } else if (/explain|what|how|walk/.test(t)) {
        faux.setResponses([
          fauxAssistantMessage([
            fauxText(
              `- A customer orders in the **Customer app**, which calls the **Orders API**.\n- The API charges the card through **Payments**, then puts the order on the **Barista queue**.\n- Fax orders are still typed in by hand.\n\nWant me to add something, like a loyalty program?${note}`,
            ),
          ]),
        ])
      } else {
        faux.setResponses([fauxAssistantMessage([fauxText(`The demo only knows a few answers. Try “Add a loyalty program” or “Explain this diagram”.${note}`)])])
      }
    },
  }
}
