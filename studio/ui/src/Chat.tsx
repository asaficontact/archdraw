import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { agentApi, diffCount, hunks, lineDiff, prose, transcript, type AgentEvent, type Proposal, type Summary } from "./agent"
import { ApiError } from "./model"
import { renderSource } from "./render"

/** Follow one conversation: replay its events, then long-poll for more until it ends. Any device, any time. */
export function useConversation(id: string | null) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setEvents([])
    setError(null)
    if (!id) return
    const ctl = new AbortController()
    let after = -1
    let ended = false
    ;(async () => {
      while (!ctl.signal.aborted && !ended) {
        try {
          const r = await agentApi.events(id, after, 25, ctl.signal)
          if (r.items.length) {
            after = r.items[r.items.length - 1].n
            setEvents(e => [...e, ...r.items])
            ended = r.items.some(x => x.type === "closed" || x.type === "ended")
          } else if (r.state === "closed") ended = true
          setError(null)
        } catch (e) {
          if (ctl.signal.aborted) return
          setError(e instanceof ApiError ? e.message : "connection lost; retrying")
          if (e instanceof ApiError && e.status === 404) return
          await new Promise(res => setTimeout(res, 2000))
        }
      }
    })()
    return () => ctl.abort()
  }, [id])
  return { events, error }
}

export type ChatProps = {
  variant: "dock" | "sheet"
  project: string
  id: string | null
  history: Summary[]
  budget: { conversation: number; spentToday: number; day: number }
  existing: Record<string, string> // diagram name → its current source, for the diffs
  staged: { name: string; n: number } | null // the proposal now shown on the canvas
  onSend: (text: string) => Promise<void>
  onNew: () => void
  onPick: (id: string) => void
  onClose: () => void
  onStage: (p: Proposal | null) => void
  onAccept: (p: Proposal) => Promise<void>
  focusKey: number
  onHeight?: (h: number) => void // the sheet tells the canvas how much of it is covered
  onCost?: () => void // a turn was charged: the day's total is fetched again
}

export function ChatPanel(props: ChatProps) {
  const { variant, id, budget } = props
  const { events, error } = useConversation(id)
  const t = useMemo(() => transcript(events), [events])
  const { onCost } = props
  useEffect(() => {
    if (t.cost > 0) onCost?.()
  }, [t.cost, onCost])
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)

  // follow the newest line: a jump when the history replays, a glide for each new event after that
  const seen = useRef(0)
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: events.length - seen.current > 3 ? "auto" : "smooth" })
    seen.current = events.length
  }, [events.length])
  useEffect(() => {
    input.current?.focus()
  }, [props.focusKey])
  const panel = useRef<HTMLElement>(null)
  const { onHeight } = props
  useEffect(() => {
    const el = panel.current
    if (!el || !onHeight) return
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight + 16))
    ro.observe(el)
    return () => {
      ro.disconnect()
      onHeight(0)
    }
  }, [onHeight])

  const send = async () => {
    const msg = text.trim()
    if (!msg || sending) return
    setSending(true)
    try {
      await props.onSend(msg)
      setText("")
    } finally {
      setSending(false)
    }
  }

  const sheet = variant === "sheet"
  const empty = !id || (!t.turns.length && !t.busy)
  // the sheet steps aside while a proposal is tried on the canvas: one bar, Undo or Accept
  const trying = sheet && props.staged ? t.turns.find(x => x.kind === "proposal" && x.p.n === props.staged?.n) : undefined
  if (trying && trying.kind === "proposal")
    return (
      <section ref={panel} className="ad-chat ad-chat-sheet ad-chat-bar" data-testid="chat" data-variant={variant}>
        <TryBar p={trying.p} before={props.existing[trying.p.name]} onUndo={() => props.onStage(null)} onAccept={props.onAccept} />
      </section>
    )
  return (
    <section ref={panel} className={sheet ? "ad-chat ad-chat-sheet" : "ad-chat ad-chat-dock"} data-testid="chat" data-variant={variant}>
      <div className="ad-chat-head">
        <span className="ad-dot" data-busy={t.busy || undefined} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">archdraw agent</div>
          <div className="truncate text-[11px] text-[var(--muted)]" data-testid="chat-meta">
            {props.project} · ${t.cost.toFixed(2)} of ${budget.conversation.toFixed(2)}
            {t.model ? ` · ${t.model.split("/").pop()}` : ""}
          </div>
        </div>
        <span className="ml-auto" />
        <button type="button" className="ad-btn ad-btn-quiet" onClick={() => setShowHistory(h => !h)} title="Earlier conversations">
          History
        </button>
        <button type="button" className="ad-btn ad-btn-quiet" onClick={props.onNew} title="Start over" data-testid="chat-new">
          New
        </button>
        <button type="button" className="ad-btn ad-btn-quiet" onClick={props.onClose} aria-label="Close chat">
          ✕
        </button>
      </div>

      {showHistory && (
        <div className="ad-chat-history">
          {props.history.length === 0 && <p className="px-3 py-2 text-xs text-[var(--muted)]">No conversations yet.</p>}
          {props.history.map(h => (
            <button
              type="button"
              key={h.id}
              className={`ad-item ${h.id === id ? "ad-item-on" : ""}`}
              onClick={() => {
                props.onPick(h.id)
                setShowHistory(false)
              }}
            >
              <span className="min-w-0 flex-1 truncate">{h.title || "(no message yet)"}</span>
              <span className="text-[11px] text-[var(--muted)]">{h.state === "closed" ? "ended" : "live"}</span>
            </button>
          ))}
        </div>
      )}

      <div ref={box} className="ad-chat-log" data-testid="chat-log">
        {empty && <Intro project={props.project} onPick={s => setText(s)} />}
        {t.turns.map((turn, i) => {
          switch (turn.kind) {
            case "user":
              return (
                <div key={turn.n} className="ad-msg ad-msg-user">
                  {turn.text}
                </div>
              )
            case "agent": {
              const words = turn.done ? prose(turn.text) : prose(turn.text.replace(/```(archdraw|markdown)[\s\S]*$/, "")) // a half-written file is not shown as text
              const drafting = !turn.done && /```(archdraw|markdown)\s+file=/.test(turn.text)
              return (
                <div key={turn.n} className="ad-msg ad-msg-agent" data-testid="agent-msg">
                  {words && <Rich text={words} />}
                  {drafting && <div className="ad-drafting">drawing…</div>}
                </div>
              )
            }
            case "tool": {
              // a run of tool calls reads as one line: what the agent looked at
              const prev = t.turns[i - 1]
              if (prev?.kind === "tool") return null
              const run: string[] = []
              for (let j = i; j < t.turns.length; j++) {
                const x = t.turns[j]
                if (x.kind !== "tool") break
                const arg = toolArg(x.args)
                if (x.name === "read" && arg) run.push(arg.split("/").pop() ?? arg)
              }
              const n = t.turns.slice(i).findIndex(x => x.kind !== "tool")
              const count = n < 0 ? t.turns.length - i : n
              return (
                <div key={turn.n} className="ad-tool" title={run.join("\n")}>
                  looked at {run.length ? run.slice(0, 3).join(", ") : `${count} places`}
                  {run.length > 3 ? ` and ${run.length - 3} more` : ""}
                </div>
              )
            }
            case "fixing":
              return (
                <div key={turn.n} className="ad-tool">
                  the engine refused a line; the agent is fixing it
                </div>
              )
            case "proposal":
              return (
                <ProposalCard
                  key={turn.n}
                  p={turn.p}
                  before={props.existing[turn.p.name]}
                  staged={props.staged?.n === turn.p.n}
                  variant={variant}
                  onStage={props.onStage}
                  onAccept={props.onAccept}
                />
              )
            case "note":
              return (
                <div key={turn.n} className={`ad-note ${turn.tone === "error" ? "text-[var(--danger)]" : ""}`}>
                  {turn.text}
                </div>
              )
          }
          return null
        })}
        {t.busy && !t.turns.some(x => x.kind === "agent" && !x.done) && <div className="ad-thinking">thinking…</div>}
        {error && <div className="ad-note text-[var(--danger)]">{error}</div>}
      </div>

      <form
        className="ad-chat-input"
        onSubmit={e => {
          e.preventDefault()
          void send()
        }}
      >
        <textarea
          ref={input}
          rows={sheet ? 1 : 2}
          value={text}
          placeholder={t.ended ? "This conversation ended; what you send starts a new one" : "Describe what to build, or what to change…"}
          data-testid="chat-input"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {t.busy && id ? (
          <button type="button" className="ad-btn" onClick={() => void agentApi.interrupt(id)}>
            Stop
          </button>
        ) : (
          <button type="submit" className="ad-btn ad-btn-primary" disabled={!text.trim() || sending} data-testid="chat-send">
            Send
          </button>
        )}
      </form>
      <div className="ad-chat-foot">
        Read-only agent · nothing is saved until you accept · today ${budget.spentToday.toFixed(2)} of ${budget.day.toFixed(0)}
      </div>
    </section>
  )
}

function TryBar({ p, before, onUndo, onAccept }: { p: Proposal; before?: string; onUndo: () => void; onAccept: (p: Proposal) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const { added, removed } = diffCount(lineDiff(before ?? "", p.source))
  return (
    <div className="flex items-center gap-2 px-3 py-2.5">
      <span className="ad-dot" data-busy />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">Trying the agent's {p.name}.archdraw</div>
        <div className="text-[11px] text-[var(--muted)]">
          <span className="ad-add">+{added}</span> <span className="ad-del">−{removed}</span> · not saved until you accept
        </div>
      </div>
      <button type="button" className="ad-btn" onClick={onUndo} data-testid="undo">
        Undo
      </button>
      <button
        type="button"
        className="ad-btn ad-btn-primary"
        disabled={busy}
        data-testid="bar-accept"
        onClick={async () => {
          setBusy(true)
          try {
            await onAccept(p)
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? "Saving…" : "Accept"}
      </button>
    </div>
  )
}

const STARTERS = [
  "Walk me through this diagram: what is missing?",
  "I want to build something new. Ask me what you need to know.",
  "Make this diagram simpler without losing anything.",
]

function Intro({ project, onPick }: { project: string; onPick: (s: string) => void }) {
  return (
    <div className="ad-intro">
      <p className="text-sm">
        I draw and keep the architecture of <b>{project}</b>. Tell me what you want to build or change; I ask what I need, one theme at a time, and propose whole diagrams you can accept.
      </p>
      <div className="mt-3 flex flex-col gap-1.5">
        {STARTERS.map(s => (
          <button type="button" key={s} className="ad-starter" onClick={() => onPick(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

function toolArg(args: string): string {
  try {
    const a = JSON.parse(args) as Record<string, unknown>
    const v = String(a.path ?? a.pattern ?? a.query ?? "")
    return v.replace(/^.*\/(work\/brain\/projects|skills)\//, "")
  } catch {
    return ""
  }
}

/** Plain text with `code`, **bold** and bullet lines; built as elements, never as markup. */
function Rich({ text }: { text: string }) {
  const lines = text.split("\n")
  return (
    <>
      {lines.map((line, i) => {
        const bullet = /^\s*[-*]\s+/.test(line)
        const body = inline(line.replace(/^\s*[-*]\s+/, ""))
        if (!line.trim()) return <div key={i} className="h-2" />
        return bullet ? (
          <div key={i} className="ad-bullet">
            {body}
          </div>
        ) : (
          <p key={i}>{body}</p>
        )
      })}
    </>
  )
}

function inline(s: string): ReactNode[] {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
      <code key={i}>{part.slice(1, -1)}</code>
    ) : part.startsWith("**") && part.endsWith("**") && part.length > 3 ? (
      <b key={i}>{part.slice(2, -2)}</b>
    ) : (
      part
    ),
  )
}

function ProposalCard({
  p,
  before,
  staged,
  variant,
  onStage,
  onAccept,
}: {
  p: Proposal
  before: string | undefined
  staged: boolean
  variant: "dock" | "sheet"
  onStage: (p: Proposal | null) => void
  onAccept: (p: Proposal) => Promise<void>
}) {
  const [showDiff, setShowDiff] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const diff = useMemo(() => lineDiff(before ?? "", p.source), [before, p.source])
  const { added, removed } = diffCount(diff)
  const preview = useMemo(() => (p.kind === "archdraw" ? renderSource(p.source, document.documentElement.dataset.theme === "dark") : null), [p])
  const isNew = before === undefined
  const same = !isNew && added === 0 && removed === 0
  if (p.kind === "markdown")
    return (
      <div className="ad-prop">
        <div className="ad-prop-head">
          <span className="font-mono text-xs">{p.name}.md</span>
          <span className="ml-auto text-[11px] text-[var(--muted)]">a note for the project</span>
        </div>
        <pre className="ad-prop-md">{p.source}</pre>
      </div>
    )
  return (
    <div className={`ad-prop ${staged ? "ad-prop-on" : ""}`} data-testid="proposal" data-name={p.name}>
      <div className="ad-prop-head">
        <span className="font-mono text-xs">{p.name}.archdraw</span>
        <span className="ml-auto text-[11px]">
          {isNew ? <span className="text-[var(--accent)]">new diagram</span> : same ? <span className="text-[var(--muted)]">no change</span> : <><span className="ad-add">+{added}</span> <span className="ad-del">−{removed}</span></>}
        </span>
      </div>
      {preview?.svg ? (
        <button type="button" className="ad-prop-mini" onClick={() => onStage(staged ? null : p)} title={variant === "dock" ? "Show beside the current diagram on the canvas" : "Try it on the canvas"} dangerouslySetInnerHTML={{ __html: preview.svg }} />
      ) : (
        <pre className="ad-card-error px-3 py-2">{p.error ?? preview?.error}</pre>
      )}
      {showDiff && !isNew && (
        <pre className="ad-diff" data-testid="diff">
          {hunks(diff).map((l, i) => (l ? <div key={i} className={l.op === "+" ? "ad-add" : l.op === "-" ? "ad-del" : ""}>{l.op} {l.text}</div> : <div key={i} className="text-[var(--muted)]">⋯</div>))}
        </pre>
      )}
      <div className="ad-prop-actions">
        {!isNew && !same && (
          <button type="button" className="ad-btn ad-btn-quiet" onClick={() => setShowDiff(d => !d)}>
            {showDiff ? "Hide diff" : "Diff"}
          </button>
        )}
        {preview?.svg && (
          <button type="button" className="ad-btn ad-btn-quiet" onClick={() => onStage(staged ? null : p)} data-testid="stage">
            {staged ? (variant === "dock" ? "Hide from canvas" : "Undo") : variant === "dock" ? "Show on canvas" : "Try on canvas"}
          </button>
        )}
        <span className="ml-auto" />
        <button
          type="button"
          className="ad-btn ad-btn-primary"
          disabled={!!p.error || !!preview?.error || same || busy || done}
          data-testid="accept"
          onClick={async () => {
            setBusy(true)
            try {
              await onAccept(p)
              setDone(true)
            } finally {
              setBusy(false)
            }
          }}
        >
          {done ? "Saved ✓" : busy ? "Saving…" : isNew ? "Create" : "Accept"}
        </button>
      </div>
    </div>
  )
}
