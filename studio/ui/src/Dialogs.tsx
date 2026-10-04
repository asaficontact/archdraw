import { useEffect, useState, type ReactNode } from "react"
import { ApiError, SLUG, api, type Project, type Settings, type SettingsView, type TrashItem } from "./model"

declare global {
  interface Window {
    archdraw?: { pickFolder?: () => Promise<string | null>; saveFile?: (name: string, url: string) => Promise<boolean> }
  }
}

const msg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e))

export function Dialog({ title, children, onClose, wide, testid }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; testid?: string }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  }, [onClose])
  return (
    <div className="ad-scrim" onMouseDown={onClose}>
      <div className={`ad-dialog ${wide ? "max-w-xl" : "max-w-md"} w-full`} role="dialog" aria-label={title} onMouseDown={e => e.stopPropagation()} data-testid={testid}>
        <div className="mb-3 flex items-center">
          <h3 className="text-base font-semibold">{title}</h3>
          <button type="button" className="ad-btn ad-btn-quiet ml-auto" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Connect a project: a GitHub repo (owner/name or its URL) or a folder on this machine. */
export function ConnectDialog({ onClose, onConnected }: { onClose: () => void; onConnected: (p: Project) => void }) {
  const [tab, setTab] = useState<"github" | "folder">("github")
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async () => {
    if (!value.trim() || busy) return
    setBusy(true)
    setErr(null)
    try {
      onConnected(await api.connect(tab === "github" ? { repo: value.trim() } : { folder: value.trim() }))
    } catch (e) {
      setErr(msg(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title="Add a project" onClose={onClose} testid="connect-dialog">
      <div className="ad-tabs mb-3">
        <button type="button" className={tab === "github" ? "ad-tab-on" : ""} onClick={() => setTab("github")}>
          GitHub repo
        </button>
        <button type="button" className={tab === "folder" ? "ad-tab-on" : ""} onClick={() => setTab("folder")}>
          Folder on this machine
        </button>
      </div>
      <form
        onSubmit={e => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="flex gap-2">
          <input
            autoFocus
            className="ad-input"
            value={value}
            data-testid="connect-input"
            placeholder={tab === "github" ? "owner/name or https://github.com/owner/name" : "/home/you/code/project"}
            onChange={e => setValue(e.target.value)}
          />
          {tab === "folder" && window.archdraw?.pickFolder && (
            <button type="button" className="ad-btn" onClick={async () => setValue((await window.archdraw!.pickFolder!()) ?? value)}>
              Choose…
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-[var(--muted)]">
          {tab === "github"
            ? "archdraw keeps its own copy and works on main. Diagrams live in the repo's .archdraw/ folder; changes reach the repo only when you approve them."
            : "Diagrams are read and written in this folder's .archdraw/."}
        </p>
        <p className="mt-2 min-h-5 text-xs text-[var(--danger)]">{err}</p>
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" className="ad-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="ad-btn ad-btn-primary" disabled={!value.trim() || busy} data-testid="connect-submit">
            {busy ? (tab === "github" ? "Cloning…" : "Adding…") : "Add project"}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/** One name: a new diagram, a rename, a copy. */
export function NameDialog({ title, initial = "", taken, action, onClose, onSubmit, withTitle }: { title: string; initial?: string; taken: string[]; action: string; onClose: () => void; onSubmit: (name: string, title: string) => Promise<void>; withTitle?: boolean }) {
  const [name, setName] = useState(initial)
  const [label, setLabel] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const bad = name && !SLUG.test(name) ? "lowercase letters, digits and dashes" : name !== initial && taken.includes(name) ? "that name is taken" : null
  return (
    <Dialog title={title} onClose={onClose} testid="name-dialog">
      <form
        onSubmit={async e => {
          e.preventDefault()
          if (!name || bad || busy) return
          setBusy(true)
          try {
            await onSubmit(name, label)
          } catch (x) {
            setErr(msg(x))
            setBusy(false)
          }
        }}
      >
        <label className="mb-1 block text-xs text-[var(--muted)]">File name</label>
        <input autoFocus className="ad-input" value={name} data-testid="name-input" onChange={e => setName(e.target.value.trim().toLowerCase())} placeholder="data-flow" />
        {withTitle && (
          <>
            <label className="mt-3 mb-1 block text-xs text-[var(--muted)]">Title</label>
            <input className="ad-input" value={label} onChange={e => setLabel(e.target.value)} placeholder="Data flow" />
          </>
        )}
        <p className="mt-2 min-h-5 text-xs text-[var(--danger)]">{bad ?? err}</p>
        <div className="mt-1 flex justify-end gap-2">
          <button type="button" className="ad-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="ad-btn ad-btn-primary" disabled={!name || !!bad || busy} data-testid="name-submit">
            {busy ? "Working…" : action}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function Confirm({ title, body, action, danger, onClose, onConfirm }: { title: string; body: ReactNode; action: string; danger?: boolean; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <Dialog title={title} onClose={onClose} testid="confirm-dialog">
      <div className="text-sm">{body}</div>
      <p className="mt-2 min-h-5 text-xs text-[var(--danger)]">{err}</p>
      <div className="mt-1 flex justify-end gap-2">
        <button type="button" className="ad-btn" onClick={onClose}>
          Keep it
        </button>
        <button
          type="button"
          className={`ad-btn ${danger ? "ad-btn-danger" : "ad-btn-primary"}`}
          disabled={busy}
          data-testid="confirm-submit"
          onClick={async () => {
            setBusy(true)
            try {
              await onConfirm()
            } catch (e) {
              setErr(msg(e))
              setBusy(false)
            }
          }}
        >
          {busy ? "Working…" : action}
        </button>
      </div>
    </Dialog>
  )
}

/** Export: the agent bundle (the whole project or one diagram), or this diagram's SVG or source. */
export function ExportDialog({ project, diagram, svg, source, onClose }: { project: string; diagram?: string; svg?: string; source?: string; onClose: () => void }) {
  const [scope, setScope] = useState<"project" | "diagram">(diagram ? "diagram" : "project")
  const [files, setFiles] = useState<string[] | null>(null)
  useEffect(() => {
    setFiles(null)
    fetch(api.exportUrl(project, scope === "diagram" ? diagram : undefined) + "&format=json")
      .then(r => r.json())
      .then(b => setFiles(Object.keys(b.files ?? {}).sort()))
      .catch(() => setFiles([]))
  }, [project, diagram, scope])
  const download = (name: string, href: string) => {
    const a = document.createElement("a")
    a.href = href
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
  const blobUrl = (text: string, type: string) => URL.createObjectURL(new Blob([text], { type }))
  return (
    <Dialog title="Export" onClose={onClose} wide testid="export-dialog">
      {diagram && (
        <div className="ad-tabs mb-3">
          <button type="button" className={scope === "diagram" ? "ad-tab-on" : ""} onClick={() => setScope("diagram")}>
            This diagram
          </button>
          <button type="button" className={scope === "project" ? "ad-tab-on" : ""} onClick={() => setScope("project")}>
            Whole project
          </button>
        </div>
      )}
      <div className="ad-export-card">
        <div className="text-sm font-semibold">Agent bundle (.zip)</div>
        <p className="mt-1 text-xs text-[var(--muted)]">Hand it to any coding agent: ARCHITECTURE.md to read first, then each diagram as text (every part and connection), its explanation, the source and the picture.</p>
        <pre className="ad-export-files" data-testid="export-files">{files === null ? "…" : files.join("\n")}</pre>
        <button type="button" className="ad-btn ad-btn-primary mt-2" data-testid="export-zip" onClick={() => download(`${project}${scope === "diagram" && diagram ? "-" + diagram : ""}.zip`, api.exportUrl(project, scope === "diagram" ? diagram : undefined))}>
          Download bundle
        </button>
      </div>
      {scope === "diagram" && diagram && (
        <div className="mt-3 flex gap-2">
          {svg && (
            <button type="button" className="ad-btn" onClick={() => download(`${diagram}.svg`, blobUrl(svg, "image/svg+xml"))}>
              Picture (.svg)
            </button>
          )}
          {source && (
            <button type="button" className="ad-btn" onClick={() => download(`${diagram}.archdraw`, blobUrl(source, "text/plain"))}>
              Source (.archdraw)
            </button>
          )}
        </div>
      )}
    </Dialog>
  )
}

/** Archived and deleted diagrams, each one click from coming back. */
export function TrashDialog({ project, onClose, onRestored }: { project: string; onClose: () => void; onRestored: (name: string) => void }) {
  const [archived, setArchived] = useState<string[] | null>(null)
  const [trash, setTrash] = useState<TrashItem[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api.archived(project).then(setArchived, e => setErr(msg(e)))
    api.trash(project).then(setTrash, () => setTrash([]))
  }, [project])
  const row = (name: string, note: string, act: () => Promise<unknown>) => (
    <div key={name + note} className="ad-row">
      <span className="font-mono text-sm">{name}</span>
      <span className="text-xs text-[var(--muted)]">{note}</span>
      <button
        type="button"
        className="ad-btn ml-auto"
        onClick={async () => {
          try {
            await act()
            onRestored(name)
          } catch (e) {
            setErr(msg(e))
          }
        }}
      >
        Restore
      </button>
    </div>
  )
  return (
    <Dialog title="Archive and trash" onClose={onClose} testid="trash-dialog">
      <div className="ad-label px-0">Archived</div>
      {archived?.length ? archived.map(n => row(n, "archived", () => api.unarchive(project, n))) : <p className="py-1 text-sm text-[var(--muted)]">Nothing archived.</p>}
      <div className="ad-label mt-3 px-0">Deleted in the last 30 days</div>
      {trash?.length ? trash.map(t => row(t.name, new Date(t.deletedAt * 1000).toLocaleDateString(), () => api.restore(project, t.name))) : <p className="py-1 text-sm text-[var(--muted)]">The trash is empty.</p>}
      <p className="mt-2 min-h-5 text-xs text-[var(--danger)]">{err}</p>
    </Dialog>
  )
}

/** Every setting, global and (when a project is open) its own overrides. */
export function SettingsDialog({ project, onClose, onSaved }: { project?: Project; onClose: () => void; onSaved: () => void }) {
  const [view, setView] = useState<SettingsView | null>(null)
  const [s, setS] = useState<Settings | null>(null)
  const [own, setOwn] = useState<Partial<Settings>>(project?.settings ?? {})
  const [key, setKey] = useState("")
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api.settings().then(v => {
      setView(v)
      setS(v.settings)
    }, e => setErr(msg(e)))
  }, [])
  if (!view || !s) return <Dialog title="Settings" onClose={onClose}>{err ?? "Loading…"}</Dialog>
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v })
  const prov = view.providers[s.provider]
  const num = (v: string) => (v === "" ? 0 : Number(v))
  const save = async () => {
    try {
      await api.saveSettings(s)
      if (project) await api.updateProject(project.slug, { settings: own })
      if (key.trim()) await api.setKey(key.trim(), s.provider)
      setNote("Saved")
      onSaved()
      setTimeout(onClose, 400)
    } catch (e) {
      setErr(msg(e))
    }
  }
  return (
    <Dialog title="Settings" onClose={onClose} wide testid="settings-dialog">
      <div className="ad-settings">
        <section>
          <h4>AI</h4>
          <label>
            Provider
            <select className="ad-input" value={s.provider} onChange={e => set("provider", e.target.value)} data-testid="set-provider">
              {Object.entries(view.providers).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.name}
                  {view.keys[id] ? " ✓" : ""}
                </option>
              ))}
            </select>
          </label>
          {view.keysEditable ? (
            <label>
              Key {view.keys[s.provider] ? <span className="text-[var(--muted)]">(saved; paste to replace)</span> : null}
              <input className="ad-input" type="password" value={key} placeholder={prov ? `${prov.prefix}…` : "key"} onChange={e => setKey(e.target.value)} data-testid="set-key" autoComplete="off" />
              {view.keysWeak && <span className="text-xs text-[var(--chg)]">This machine has no system keyring, so the key is kept with basic protection only.</span>}
              {prov && (
                <a className="text-xs text-[var(--accent)]" href={prov.keyUrl} target="_blank" rel="noopener noreferrer">
                  Get a {prov.name} key
                </a>
              )}
            </label>
          ) : (
            <p className="text-xs text-[var(--muted)]">{view.keys[s.provider] ? `Your ${prov?.name ?? s.provider} key is set on this machine.` : `No ${prov?.name ?? s.provider} key on this machine (${prov?.env}).`}</p>
          )}
          <label>
            Chat model
            <input className="ad-input" value={s.chatModel} placeholder={prov?.chat} onChange={e => set("chatModel", e.target.value)} />
          </label>
          <label>
            Change-check model (cheap)
            <input className="ad-input" value={s.triageModel} placeholder={prov?.triage} onChange={e => set("triageModel", e.target.value)} />
          </label>
        </section>
        <section>
          <h4>Sync and publishing</h4>
          <label>
            Check every (minutes, 0 = off)
            <input className="ad-input" type="number" min={0} value={s.syncEveryMinutes} onChange={e => set("syncEveryMinutes", num(e.target.value))} data-testid="set-sync" />
          </label>
          <label>
            Approving an update
            <select className="ad-input" value={s.publish} onChange={e => set("publish", e.target.value as Settings["publish"])}>
              <option value="pull-request">merges a pull request (recommended)</option>
              <option value="direct">pushes straight to the branch (with a merge commit when it moved meanwhile)</option>
            </select>
          </label>
          <label>
            Paths the agent never reads (one per line)
            <textarea className="ad-input ad-textarea" value={s.ignore.join("\n")} onChange={e => set("ignore", e.target.value.split("\n").map(x => x.trim()).filter(Boolean))} placeholder="vendor/**" />
          </label>
        </section>
        <section>
          <h4>Budget</h4>
          <label>
            All projects, per day ($)
            <input className="ad-input" type="number" min={0} step="0.5" value={s.dayBudgetUsd} onChange={e => set("dayBudgetUsd", num(e.target.value))} data-testid="set-day" />
          </label>
          <label>
            One project, per day ($)
            <input className="ad-input" type="number" min={0} step="0.5" value={s.projectDayBudgetUsd} onChange={e => set("projectDayBudgetUsd", num(e.target.value))} />
          </label>
          <label>
            One conversation ($)
            <input className="ad-input" type="number" min={0} step="0.25" value={s.conversationBudgetUsd} onChange={e => set("conversationBudgetUsd", num(e.target.value))} />
          </label>
          <p className="text-xs text-[var(--muted)]">Spent today: ${view.spentToday.total.toFixed(2)}</p>
        </section>
        {project && (
          <section>
            <h4>{project.title} only</h4>
            <label>
              Check every (minutes; empty = as above)
              <input className="ad-input" type="number" min={0} value={own.syncEveryMinutes ?? ""} onChange={e => setOwn({ ...own, syncEveryMinutes: e.target.value === "" ? undefined : num(e.target.value) })} data-testid="set-project-sync" />
            </label>
            <label>
              Per day ($; empty = as above)
              <input className="ad-input" type="number" min={0} step="0.5" value={own.projectDayBudgetUsd ?? ""} onChange={e => setOwn({ ...own, projectDayBudgetUsd: e.target.value === "" ? undefined : num(e.target.value) })} />
            </label>
          </section>
        )}
        <section>
          <h4>Look</h4>
          <label>
            Theme
            <select className="ad-input" value={s.theme} onChange={e => set("theme", e.target.value as Settings["theme"])}>
              <option value="system">Follow the system</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </section>
      </div>
      <p className="mt-2 min-h-5 text-xs text-[var(--danger)]">{err ?? <span className="text-[var(--muted)]">{note}</span>}</p>
      <div className="flex justify-end gap-2">
        <button type="button" className="ad-btn" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="ad-btn ad-btn-primary" onClick={() => void save()} data-testid="settings-save">
          Save
        </button>
      </div>
    </Dialog>
  )
}
