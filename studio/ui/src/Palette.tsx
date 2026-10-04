import { useEffect, useMemo, useRef, useState } from "react"
import { looksLikeAsk, rank, type Target } from "./agent"

type Item = { kind: "ask"; text: string } | { kind: "go"; t: Target }

/**
 * ⌘K: one box that jumps to any project or diagram by name, or hands the words to the archdraw agent. A query that
 * reads like a request (three words or more, or a question) puts "Ask" first; a name puts the matches first.
 */
export function Palette({ targets, project, onGo, onAsk, onClose }: { targets: Target[]; project?: string; onGo: (t: Target) => void; onAsk: (text: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("")
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  const items: Item[] = useMemo(() => {
    const matches = rank(q, targets).map(t => ({ kind: "go" as const, t }))
    if (!q.trim()) return matches
    const ask = { kind: "ask" as const, text: q.trim() }
    return looksLikeAsk(q) || !matches.length ? [ask, ...matches] : [...matches, ask]
  }, [q, targets])
  useEffect(() => setAt(0), [q])

  const choose = (it: Item | undefined) => {
    if (!it) return
    if (it.kind === "ask") onAsk(it.text)
    else onGo(it.t)
  }

  return (
    <div className="ad-palette-scrim" onClick={onClose} data-testid="palette">
      <div className="ad-palette" onClick={e => e.stopPropagation()} role="dialog" aria-label="Jump or ask">
        <div className="flex items-center gap-2 border-b border-[var(--line)] px-4">
          <span className="text-[var(--muted)]">⌘K</span>
          <input
            ref={input}
            autoFocus
            value={q}
            data-testid="palette-input"
            placeholder={project ? `Jump to a diagram, or ask the agent about ${project}…` : "Jump to a project…"}
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none"
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                setAt(a => Math.min(items.length - 1, a + 1))
              } else if (e.key === "ArrowUp") {
                e.preventDefault()
                setAt(a => Math.max(0, a - 1))
              } else if (e.key === "Enter") {
                e.preventDefault()
                choose(items[at])
              } else if (e.key === "Escape") onClose()
            }}
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {items.map((it, i) => (
            <button
              type="button"
              key={it.kind === "ask" ? "ask" : `${it.t.project}/${it.t.file ?? ""}`}
              className={`ad-palette-item ${i === at ? "ad-palette-on" : ""}`}
              onMouseMove={() => setAt(i)}
              onClick={() => choose(it)}
              data-testid={it.kind === "ask" ? "palette-ask" : "palette-go"}
            >
              {it.kind === "ask" ? (
                <>
                  <span className="ad-palette-icon">✦</span>
                  <span className="min-w-0 flex-1 truncate">
                    Ask the archdraw agent: <b>{it.text}</b>
                  </span>
                  <kbd>↵</kbd>
                </>
              ) : (
                <>
                  <span className="ad-palette-icon">{it.t.kind === "project" ? "▦" : "◇"}</span>
                  <span className="min-w-0 flex-1 truncate">{it.t.title}</span>
                  <span className="truncate text-xs text-[var(--muted)]">{it.t.hint}</span>
                </>
              )}
            </button>
          ))}
          {!items.length && <p className="px-3 py-3 text-sm text-[var(--muted)]">Type a name, or a sentence for the agent.</p>}
        </div>
      </div>
    </div>
  )
}
