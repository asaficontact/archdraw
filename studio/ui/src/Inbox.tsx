import { useCallback, useEffect, useMemo, useState } from "react"
import { Confirm } from "./Dialogs"
import { highlighted, marks } from "./diffview"
import { ApiError, api, type Change, type DiagramDiff, type InboxItem } from "./model"

const ago = (t: number) => {
  const s = Date.now() / 1000 - t
  if (s < 90) return "just now"
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

const KIND: Record<string, string> = { added: "Added", removed: "Removed", changed: "Changed", moved: "Moved", restyled: "Restyled" }

function describe(c: Change): string {
  if (c.on === "node") return `${c.label}${c.what ? ` (${c.what})` : ""}`
  return `${c.from} → ${c.to}${c.label ? `: ${c.label}` : ""}${c.what ? ` (${c.what})` : ""}`
}

/**
 * The inbox: every project with changes waiting, one card each. A card opens to the colored diff of each changed
 * diagram (after, with a before toggle), the list of changes (hover one to find it), the commits it came from, and
 * Approve / Discard / ask the agent.
 */
export function Inbox({ dark, focusProject, onAsk, onOpen, onChanged }: { dark: boolean; focusProject?: string; onAsk: (project: string, text: string) => void; onOpen: (project: string, file?: string) => void; onChanged: () => void }) {
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [open, setOpen] = useState<string | undefined>(focusProject)
  const [err, setErr] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)
  const load = useCallback(() => {
    api.inbox().then(
      list => {
        setItems(list)
        setOpen(o => o ?? list.find(i => i.pending)?.project)
      },
      e => setErr(e instanceof ApiError ? e.message : String(e)),
    )
  }, [])
  useEffect(load, [load])
  useEffect(() => setOpen(focusProject), [focusProject])

  const waiting = items?.filter(i => i.pending) ?? []
  const calm = items?.filter(i => !i.pending) ?? []
  return (
    <div className="ad-inbox" data-testid="inbox">
      <div className="ad-inbox-head">
        <h2 className="text-lg font-semibold">Inbox</h2>
        <span className="text-sm text-[var(--muted)]">{items === null ? "" : waiting.length ? `${waiting.length} project${waiting.length > 1 ? "s" : ""} with changes to review` : "All caught up"}</span>
      </div>
      {err && <p className="text-sm text-[var(--danger)]">{err}</p>}
      {waiting.map(i => (
        <Item key={i.project} item={i} dark={dark} open={open === i.project} onToggle={() => setOpen(o => (o === i.project ? undefined : i.project))} onAsk={onAsk} onOpen={onOpen} onDone={() => (load(), onChanged())} />
      ))}
      {calm.length > 0 && (
        <div className="mt-6">
          <div className="ad-label px-0">Up to date</div>
          {calm.map(i => (
            <div key={i.project} className="ad-row" data-testid={`inbox-calm-${i.project}`}>
              <span className="font-medium">{i.title}</span>
              <span className="text-xs text-[var(--muted)]">
                {i.last ? (i.last.outcome === "no-architecture-change" ? `checked ${ago((i.last.at ?? 0) / 1000)}: ${i.last.commits} commit(s), no architecture change` : i.last.outcome === "skipped" ? `last check skipped: ${i.last.reason}` : `checked ${ago((i.last.at ?? 0) / 1000)}`) : i.checkedThrough ? `checked through ${i.checkedThrough.slice(0, 7)}` : "not checked yet"}
              </span>
              <button
                type="button"
                className="ad-btn ml-auto"
                disabled={syncing === i.project}
                data-testid={`sync-${i.project}`}
                onClick={async () => {
                  setSyncing(i.project)
                  try {
                    await api.sync(i.project)
                  } catch (e) {
                    setErr(e instanceof ApiError ? e.message : String(e))
                  } finally {
                    setSyncing(null)
                    load()
                    onChanged()
                  }
                }}
              >
                {syncing === i.project ? "Checking…" : "Sync now"}
              </button>
            </div>
          ))}
        </div>
      )}
      {items?.length === 0 && <p className="mt-4 text-sm text-[var(--muted)]">Connect a GitHub project and archdraw checks it every hour; changes to review land here.</p>}
    </div>
  )
}

function Item({ item, dark, open, onToggle, onAsk, onOpen, onDone }: { item: InboxItem; dark: boolean; open: boolean; onToggle: () => void; onAsk: (p: string, t: string) => void; onOpen: (p: string, f?: string) => void; onDone: () => void }) {
  const p = item.pending!
  const [diffs, setDiffs] = useState<DiagramDiff[] | null>(null)
  const [confirm, setConfirm] = useState<null | "approve" | "discard">(null)
  useEffect(() => {
    if (!open || diffs) return
    Promise.all(p.files.map(f => api.diff(item.project, f.name))).then(setDiffs, () => setDiffs([]))
  }, [open, diffs, p.files, item.project])
  const count = p.files.length
  return (
    <section className={`ad-inbox-card ${open ? "ad-inbox-on" : ""}`} data-testid={`inbox-${item.project}`}>
      <button type="button" className="ad-inbox-summary" onClick={onToggle}>
        <span className="ad-dot" data-busy />
        <span className="min-w-0 flex-1 text-left">
          <span className="block truncate font-semibold">
            {item.title}: {item.headline}
          </span>
          <span className="block truncate text-xs text-[var(--muted)]">
            {count} diagram{count > 1 ? "s" : ""} · {item.commits?.length ?? 0} change{(item.commits?.length ?? 0) === 1 ? "" : "s"} waiting{p.behind ? ` · main moved ${p.behind} commit(s) since` : ""}
          </span>
        </span>
        <span className="text-[var(--muted)]">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <div className="ad-inbox-body">
          {diffs === null && <p className="text-sm text-[var(--muted)]">Loading the diff…</p>}
          {diffs?.map(d => <DiffView key={d.name} d={d} dark={dark} project={item.project} onAsk={onAsk} onOpen={onOpen} />)}
          {item.commits && item.commits.length > 0 && (
            <details className="mt-2 text-xs text-[var(--muted)]">
              <summary>What happened</summary>
              <ul className="mt-1 list-disc pl-5">
                {item.commits.map((c, i) => (
                  <li key={i}>
                    {c.subject} · {ago(c.at)}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="ad-inbox-actions">
            {p.pr && (
              <a className="ad-btn ad-btn-quiet" href={p.pr.url} target="_blank" rel="noopener noreferrer">
                Pull request #{p.pr.number}
              </a>
            )}
            <span className="ml-auto" />
            <button type="button" className="ad-btn" onClick={() => setConfirm("discard")} data-testid="inbox-discard">
              Discard
            </button>
            <button type="button" className="ad-btn ad-btn-primary" onClick={() => setConfirm("approve")} data-testid="inbox-approve">
              Approve
            </button>
          </div>
        </div>
      )}
      {confirm === "approve" && (
        <Confirm
          title={`Approve ${item.title}'s update?`}
          body={<p>The {count} changed diagram{count > 1 ? "s" : ""} go into the repo's main branch.</p>}
          action="Approve"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await api.approve(item.project, p.head)
            setConfirm(null)
            onDone()
          }}
        />
      )}
      {confirm === "discard" && (
        <Confirm
          title="Discard these changes?"
          body={<p>The waiting update is thrown away; main stays as it is. The next check drafts again only if the code changes again.</p>}
          action="Discard"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await api.discard(item.project, p.head)
            setConfirm(null)
            onDone()
          }}
        />
      )}
    </section>
  )
}

function DiffView({ d, dark, project, onAsk, onOpen }: { d: DiagramDiff; dark: boolean; project: string; onAsk: (p: string, t: string) => void; onOpen: (p: string, f?: string) => void }) {
  const [side, setSide] = useState<"after" | "before">(d.after ? "after" : "before")
  const [focus, setFocus] = useState<string | undefined>()
  const m = useMemo(() => marks(d.diff.changes), [d])
  const svg = useMemo(() => {
    const src = side === "after" ? d.after : d.before
    if (!src) return null
    try {
      return highlighted(src, dark, side === "after" ? m.after : m.before, focus)
    } catch (e) {
      return `<p>${String((e as Error).message)}</p>`
    }
  }, [side, d, dark, m, focus])
  const title = /^\s*\/\/\s*title\s*:\s*(.+)$/m.exec(d.after ?? d.before ?? "")?.[1] ?? d.name
  return (
    <div className="ad-diff-block" data-testid={`diff-${d.name}`}>
      <div className="flex items-center gap-2">
        <span className="font-medium">{title}</span>
        <span className="text-xs">
          <span className="ad-add">+{d.diff.added}</span> <span className="ad-chg">~{d.diff.changed}</span> <span className="ad-del">−{d.diff.removed}</span>
        </span>
        <span className="ml-auto" />
        {d.before && d.after && (
          <div className="ad-tabs ad-tabs-sm">
            <button type="button" className={side === "before" ? "ad-tab-on" : ""} onClick={() => setSide("before")} data-testid="side-before">
              Before
            </button>
            <button type="button" className={side === "after" ? "ad-tab-on" : ""} onClick={() => setSide("after")} data-testid="side-after">
              After
            </button>
          </div>
        )}
        <button type="button" className="ad-btn ad-btn-quiet" onClick={() => onOpen(project, d.name)}>
          Open
        </button>
      </div>
      {svg ? <div className="ad-diff-svg" dangerouslySetInnerHTML={{ __html: svg }} /> : <p className="text-sm text-[var(--muted)]">{side === "after" ? "This diagram is deleted by the update." : "This diagram is new."}</p>}
      <ul className="ad-changes">
        {d.diff.changes.map((c, i) => (
          <li
            key={i}
            className={`ad-change ad-change-${c.kind}`}
            onMouseEnter={() => {
              const id = c.on === "node" ? c.id : c.to
              setSide(c.kind === "removed" ? "before" : "after")
              setFocus(id)
            }}
            onMouseLeave={() => setFocus(undefined)}
          >
            <span className="ad-change-kind">{KIND[c.kind]}</span>
            <span className="min-w-0 flex-1 truncate">{describe(c)}</span>
            <button type="button" className="ad-btn ad-btn-quiet" onClick={() => onAsk(project, `In ${d.name}: why was "${describe(c)}" ${c.kind}? What in the code does it come from?`)}>
              Ask
            </button>
          </li>
        ))}
        {d.diff.changes.length === 0 && <li className="text-xs text-[var(--muted)]">Only the explanation or layout changed.</li>}
      </ul>
    </div>
  )
}
