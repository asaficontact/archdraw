import { useEffect, useRef, useState } from "react"

// The tour (projects/archdraw/archdraw-onboarding.md): five doing-steps on the sample "Bean There", after the one setup
// screen. A step is done when the user does the real thing (the app emits an event), never by a Next button. Each step
// opens the place where its action happens (App's tour effect): the diagram, its text, the chat with the request
// typed, the Inbox. The card sits bottom-left (a bottom sheet on a phone) and a ring follows the control to use next.

export type TourEvent = "drilled" | "source.changed" | "source.saved" | "proposal.accepted" | "proposal.dismissed" | "update.done" | "export.opened"

/** Tell the tour something happened. */
export const tourEvent = (name: TourEvent) => window.dispatchEvent(new CustomEvent("archdraw:ev", { detail: name }))

/** Where the user is, so a step can point at the right control (the canvas, or one diagram flown into). */
export type TourWhere = { file?: string }

type Step = { n: number; title: string; body: string; target: (w: TourWhere) => string[]; done: TourEvent[]; phoneBody?: string }

export const STEPS: Step[] = [
  {
    n: 2,
    title: "Every diagram is a card.",
    body: "The ringed card is the whole system. Double-click it to fly in, then click its Payments box: a box with a link opens the diagram one level deeper.",
    target: w => (w.file === "overview" ? ['[data-card=overview] a[href$="/payments"]'] : ["[data-card=overview]"]),
    done: ["drilled"],
  },
  {
    n: 3,
    title: "The diagram is just text.",
    body: "On the right is the text behind Payments, kept as .archdraw/payments.archdraw in the repo. Change a word, say “Receipts” to “Email receipts”: the card redraws as you type. Then press Save.",
    phoneBody: "On a computer, each diagram opens as text beside it: change a word and the card redraws.",
    target: () => ["[data-testid=save]:not([disabled])", "[data-testid=source]"],
    done: ["source.saved"],
  },
  {
    n: 4,
    title: "Ask for a change.",
    body: "This is archdraw's agent. We typed a request for you: press Send. Its proposal appears beside the original, and nothing changes until you press Accept.",
    target: () => ["[data-testid=ghost-accept]", "[data-testid=proposal] [data-testid=accept]:not([disabled])", "[data-testid=chat-send]:not([disabled])", "[data-testid=chat-input]"],
    done: ["proposal.accepted", "proposal.dismissed"],
  },
  {
    n: 5,
    title: "Review the update.",
    body: "Every change waits here, and every hour archdraw drafts one more when your code moves. Click a diagram to see it in color (green added, amber changed, red removed), then press Approve.",
    target: () => ["[data-testid=inbox-approve]"],
    done: ["update.done"],
  },
  {
    n: 6,
    title: "Hand it to your coding agent.",
    body: "Press Export: ARCHITECTURE.md plus every diagram as text, ready for Claude Code, Cursor or Codex.",
    phoneBody: "On a computer, Export hands ARCHITECTURE.md and every diagram to your coding agent.",
    target: () => ["[data-testid=open-export]"],
    done: ["export.opened"],
  },
]

export type TourState = { status: "new" | "active" | "done" | "skipped"; step: number; chipDismissed?: boolean }

export function Tour({ state, where, onAdvance, onSkip, onFinish }: { state: TourState; where: TourWhere; onAdvance: (step: number) => void; onSkip: () => void; onFinish: (openRepo: boolean) => void }) {
  const step = STEPS.find(s => s.n === state.step)
  const phone = window.innerWidth < 640
  const [justDid, setJustDid] = useState(false)

  useEffect(() => {
    if (!step) return
    const on = (e: Event) => {
      const name = (e as CustomEvent).detail as TourEvent
      if (!step.done.includes(name)) return
      setJustDid(true)
      setTimeout(() => {
        setJustDid(false)
        onAdvance(step.n + 1)
      }, 900)
    }
    window.addEventListener("archdraw:ev", on)
    return () => window.removeEventListener("archdraw:ev", on)
  }, [step, onAdvance])

  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && e.shiftKey && onSkip()
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  }, [onSkip])

  if (state.status !== "active") return null
  if (!step)
    return (
      <div className={phone ? "ad-tour ad-tour-sheet" : "ad-tour"} role="dialog" aria-label="Your turn" data-testid="tour-finish">
        <div className="ad-tour-step">Done</div>
        <h3 className="ad-tour-title">Your turn.</h3>
        <p className="ad-tour-body">Open your own repo and archdraw keeps its diagrams current from main. The “…” beside a diagram renames, archives or deletes it; keys, models and spending caps live in Settings.</p>
        <div className="mt-3 flex gap-2">
          <button type="button" className="ad-btn ad-btn-primary" onClick={() => onFinish(true)} data-testid="tour-open-repo">
            Open a repo
          </button>
          <button type="button" className="ad-btn" onClick={() => onFinish(false)} data-testid="tour-keep">
            Keep exploring
          </button>
        </div>
      </div>
    )
  return (
    <>
      <Ring selectors={step.target(where)} />
      <div className={phone ? "ad-tour ad-tour-sheet" : "ad-tour"} role="dialog" aria-label={step.title} data-testid="tour-card" data-step={step.n}>
        <div className="ad-tour-step">
          Step {step.n} of 6
          <button type="button" className="ml-auto text-[var(--muted)] hover:text-[var(--text)]" onClick={onSkip} data-testid="tour-skip">
            Skip tour
          </button>
        </div>
        <h3 className="ad-tour-title">{justDid ? "✓ " : ""}{step.title}</h3>
        <p className="ad-tour-body">{phone && step.phoneBody ? step.phoneBody : step.body}</p>
        {phone && step.phoneBody && (
          <button type="button" className="ad-btn mt-2" onClick={() => onAdvance(step.n + 1)}>
            Got it
          </button>
        )}
        <div className="ad-tour-dots" aria-hidden>
          {STEPS.map(s => (
            <span key={s.n} data-on={s.n <= step.n || undefined} />
          ))}
        </div>
      </div>
    </>
  )
}

/** A pulsing ring around the step's target, following it every frame (the canvas moves). */
function Ring({ selectors }: { selectors: string[] }) {
  const el = useRef<HTMLDivElement>(null)
  const key = selectors.join("|")
  useEffect(() => {
    let raf = 0
    const visible = (r?: DOMRect) => !!r && r.width > 0 && r.bottom > 0 && r.top < innerHeight
    const tick = () => {
      // the first control on screen: the ring moves on as the step does (the editor, then Save; Send, then Accept)
      let r: DOMRect | undefined
      for (const s of key.split("|")) {
        const b = document.querySelector(s)?.getBoundingClientRect()
        if (visible(b)) {
          r = b
          break
        }
      }
      const ring = el.current
      if (ring) {
        if (r) {
          ring.style.display = "block"
          ring.style.transform = `translate(${r.left - 6}px, ${r.top - 6}px)`
          ring.style.width = `${r.width + 12}px`
          ring.style.height = `${r.height + 12}px`
        } else ring.style.display = "none"
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [key])
  return <div ref={el} className="ad-ring" aria-hidden data-testid="tour-ring" />
}

/** The first screen when nothing is connected yet: open your code, or just try the sample. */
export function StartScreen({ onConnect, onSample, busy, error }: { onConnect: (v: { repo?: string; folder?: string }) => void; onSample: () => void; busy: boolean; error: string | null }) {
  const [value, setValue] = useState("")
  const looksLikePath = value.trim().startsWith("/") || value.trim().startsWith("~")
  return (
    <div className="grid h-full place-items-center p-6" data-testid="empty">
      <form
        className="w-full max-w-md text-center"
        onSubmit={e => {
          e.preventDefault()
          if (value.trim()) onConnect(looksLikePath ? { folder: value.trim() } : { repo: value.trim() })
        }}
      >
        <h2 className="text-2xl font-semibold tracking-tight">Show me my architecture.</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">Paste a GitHub repo (owner/name or its URL) or a folder. archdraw uses this machine's git login and writes only to .archdraw/, when you approve.</p>
        <div className="mt-5 flex gap-2">
          <input className="ad-input" autoFocus value={value} onChange={e => setValue(e.target.value)} placeholder="owner/name" data-testid="start-input" />
          <button type="submit" className="ad-btn ad-btn-primary" disabled={!value.trim() || busy} data-testid="start-open">
            {busy ? "Opening…" : "Open"}
          </button>
        </div>
        {window.archdraw?.pickFolder && (
          <button type="button" className="ad-btn ad-btn-quiet mt-2" onClick={async () => {
            const f = await window.archdraw!.pickFolder!()
            if (f) onConnect({ folder: f })
          }}>
            Choose a folder…
          </button>
        )}
        <p className="mt-2 min-h-5 text-xs text-[var(--danger)]">{error}</p>
        <button type="button" className="mt-4 text-sm text-[var(--accent)] underline-offset-4 hover:underline" onClick={onSample} data-testid="start-sample">
          Just try the sample (a 2-minute tour)
        </button>
      </form>
    </div>
  )
}
