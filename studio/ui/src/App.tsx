import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Canvas, type Card } from "./Canvas"
import { ApiError, SLUG, api, hashFor, meta, parseHash, type FileMeta, type Project } from "./model"
import { renderSource } from "./render"

const useDark = () => {
  const media = window.matchMedia("(prefers-color-scheme: dark)")
  const stored = () => localStorage.getItem("archdraw:theme")
  const [mode, setMode] = useState<string>(() => stored() ?? "system")
  const [sys, setSys] = useState(media.matches)
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setSys(e.matches)
    media.addEventListener("change", on)
    return () => media.removeEventListener("change", on)
  }, [media])
  const dark = mode === "dark" || (mode === "system" && sys)
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light"
  }, [dark])
  const cycle = () => {
    const next = mode === "system" ? (sys ? "light" : "dark") : mode === "dark" ? "light" : "dark"
    try {
      localStorage.setItem("archdraw:theme", next)
    } catch {
      /* storage blocked: the choice lasts this visit */
    }
    setMode(next)
  }
  return { dark, cycle }
}

const ago = (t: number) => {
  const s = Date.now() / 1000 - t
  if (s < 90) return "just now"
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export default function App() {
  const { dark, cycle } = useDark()
  const [route, setRoute] = useState(() => parseHash(location.hash))
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [files, setFiles] = useState<FileMeta[]>([])
  const [sources, setSources] = useState<Record<string, { source: string; version: string }>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState(false)
  const [focus, setFocus] = useState<{ key?: string; n: number }>({ n: 0 })
  const [fitAll, setFitAll] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState<null | "project" | "file">(null)

  useEffect(() => {
    const on = () => setRoute(parseHash(location.hash))
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])

  const loadProjects = useCallback(() => {
    api.projects().then(setProjects, e => setError(String(e.message ?? e)))
  }, [])
  useEffect(loadProjects, [loadProjects])

  // default to the first project
  useEffect(() => {
    if (projects?.length && !route.project) location.replace(hashFor(projects[0].slug))
  }, [projects, route.project])

  // a project's files and their sources
  const project = route.project
  const loadFiles = useCallback(async (p: string) => {
    const list = await api.files(p)
    const docs = await Promise.all(list.map(f => api.read(p, f.name)))
    setFiles(list)
    setSources(Object.fromEntries(docs.map(d => [d.name, { source: d.source, version: d.version }])))
  }, [])
  useEffect(() => {
    if (!project) return
    setFiles([])
    setSources({})
    setDrafts({})
    loadFiles(project).catch(e => setError(e instanceof ApiError ? e.message : String(e)))
  }, [project, loadFiles])

  // the selected file flies into view
  useEffect(() => {
    setFocus(f => ({ key: route.file, n: f.n + 1 }))
    setMenu(false)
  }, [route.file, project, files.length])

  const cards: Card[] = useMemo(
    () =>
      files.map(f => {
        const source = drafts[f.name] ?? sources[f.name]?.source ?? ""
        const m = meta(source)
        return { key: f.name, title: m.title ?? f.name, summary: m.summary ?? "", r: renderSource(source, dark) }
      }),
    [files, sources, drafts, dark],
  )

  const sel = route.file && files.some(f => f.name === route.file) ? route.file : undefined
  const selSource = sel ? (drafts[sel] ?? sources[sel]?.source ?? "") : ""
  const selCard = cards.find(c => c.key === sel)
  const dirty = !!sel && drafts[sel] !== undefined && drafts[sel] !== sources[sel]?.source

  const save = useCallback(async () => {
    if (!project || !sel || !dirty || saving) return
    setSaving(true)
    try {
      const r = await api.save(project, sel, drafts[sel], sources[sel]?.version ?? null)
      setSources(s => ({ ...s, [sel]: { source: drafts[sel].endsWith("\n") ? drafts[sel] : drafts[sel] + "\n", version: r.version } }))
      setDrafts(d => {
        const { [sel]: _, ...rest } = d
        return rest
      })
      setNotice(r.commit ? `Saved and committed to the brain (${r.commit})` : "Saved")
      api.files(project).then(setFiles)
    } catch (e) {
      setNotice(e instanceof ApiError ? `Not saved: ${e.message}` : `Not saved: ${String(e)}`)
    } finally {
      setSaving(false)
    }
  }, [project, sel, dirty, saving, drafts, sources])

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault()
        void save()
      }
      if (e.key === "Escape") setEditing(false)
    }
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  }, [save])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(t)
  }, [notice])

  const current = projects?.find(p => p.slug === project)

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-[var(--page)] text-[var(--text)]">
      {/* sidebar: projects, then the selected project's diagrams */}
      <aside
        className={`ad-side z-20 flex w-72 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--panel)] max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:shadow-2xl ${menu ? "" : "max-md:-translate-x-full"} transition-transform`}
      >
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">archdraw</span>
          <span className="ml-auto text-xs text-[var(--muted)]">studio</span>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <div className="ad-label">Projects</div>
          {projects?.map(p => (
            <a key={p.slug} href={hashFor(p.slug)} className={`ad-item ${p.slug === project ? "ad-item-on" : ""}`} data-testid={`project-${p.slug}`}>
              <span className="truncate">{p.title}</span>
              <span className="ml-auto text-xs text-[var(--muted)]">{p.files}</span>
            </a>
          ))}
          {projects?.length === 0 && <p className="px-3 py-2 text-sm text-[var(--muted)]">No projects yet.</p>}
          <button type="button" className="ad-item text-[var(--muted)]" onClick={() => setCreating("project")}>
            + New project
          </button>
          {project && (
            <>
              <div className="ad-label mt-4">Diagrams</div>
              {files.map(f => {
                const m = meta(drafts[f.name] ?? sources[f.name]?.source ?? "")
                return (
                  <a key={f.name} href={hashFor(project, f.name)} className={`ad-item ad-file ${f.name === sel ? "ad-item-on" : ""}`} data-testid={`file-${f.name}`}>
                    <span className="block truncate font-medium">{m.title ?? f.title}</span>
                    <span className="block truncate text-xs text-[var(--muted)]">{m.summary ?? f.summary}</span>
                    <span className="block text-[11px] text-[var(--muted)]">
                      {f.name}.archdraw · {ago(f.updated)}
                      {drafts[f.name] !== undefined && drafts[f.name] !== sources[f.name]?.source ? " · unsaved" : ""}
                    </span>
                  </a>
                )
              })}
              <button type="button" className="ad-item text-[var(--muted)]" onClick={() => setCreating("file")}>
                + New diagram
              </button>
            </>
          )}
        </nav>
      </aside>
      {menu && <div className="fixed inset-0 z-10 bg-black/30 md:hidden" onClick={() => setMenu(false)} />}

      <main className="relative min-w-0 flex-1">
        <header
          className="ad-top absolute left-0 top-0 z-10 flex items-center gap-2 px-3 py-2"
          style={{ right: editing && sel ? Math.min(560, window.innerWidth) : 0 }}
        >
          <button type="button" className="ad-btn md:hidden" aria-label="Menu" onClick={() => setMenu(true)}>
            ☰
          </button>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{selCard?.title ?? current?.title ?? "archdraw"}</div>
            <div className="truncate text-xs text-[var(--muted)]">{selCard ? selCard.summary : current ? `${files.length} diagrams` : ""}</div>
          </div>
          <div className="ml-auto flex items-center gap-1">
            {sel && (
              <button type="button" className="ad-btn" onClick={() => setEditing(e => !e)} data-testid="toggle-source">
                {editing ? "Close source" : "Source"}
              </button>
            )}
            <button type="button" className="ad-btn" onClick={() => setFitAll(n => n + 1)} title="Fit every diagram">
              All
            </button>
            <button type="button" className="ad-btn" onClick={cycle} aria-label="Toggle theme" title="Light / dark">
              {dark ? "☾" : "☀"}
            </button>
          </div>
        </header>

        {error ? (
          <div className="grid h-full place-items-center p-6 text-center text-sm text-[var(--muted)]">{error}</div>
        ) : (
          <Canvas
            cards={cards}
            selected={sel}
            onSelect={k => (location.hash = hashFor(project, k))}
            focus={focus}
            fitAll={fitAll}
            dark={dark}
            insetRight={editing && sel ? Math.min(560, window.innerWidth) : 0}
          />
        )}

        {editing && sel && (
          <section className="ad-editor absolute bottom-0 right-0 top-0 z-20 flex w-[min(560px,100%)] flex-col" data-testid="editor">
            <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2">
              <span className="truncate font-mono text-xs text-[var(--muted)]">
                {project}/{sel}.archdraw
              </span>
              <span className="ml-auto" />
              {dirty && <span className="text-xs text-[var(--accent)]">unsaved</span>}
              <button type="button" className="ad-btn ad-btn-primary" disabled={!dirty || saving || !!selCard?.r.error} onClick={() => void save()} data-testid="save">
                {saving ? "Saving…" : "Save"}
              </button>
              <button type="button" className="ad-btn" onClick={() => setEditing(false)} aria-label="Close">
                ✕
              </button>
            </div>
            <Editor value={selSource} onChange={v => setDrafts(d => ({ ...d, [sel]: v }))} />
            <div className={`border-t border-[var(--line)] px-3 py-2 text-xs ${selCard?.r.error ? "text-[var(--danger)]" : "text-[var(--muted)]"}`} data-testid="status">
              {selCard?.r.error ?? "Renders. ⌘/Ctrl-S saves and commits to the brain; the card on the canvas updates as you type."}
            </div>
          </section>
        )}

        {notice && (
          <div className="ad-toast absolute bottom-16 left-1/2 z-30 -translate-x-1/2" role="status">
            {notice}
          </div>
        )}
        {creating && (
          <CreateDialog
            kind={creating}
            existing={creating === "project" ? (projects ?? []).map(p => p.slug) : files.map(f => f.name)}
            onCancel={() => setCreating(null)}
            onCreate={async (slug, title) => {
              if (creating === "project") {
                await api.createProject(slug)
                setCreating(null)
                loadProjects()
                location.hash = hashFor(slug, "overview")
              } else if (project) {
                const src = `// title: ${title || slug}\n// summary: One sentence on what this diagram shows.\n\nnode app "App"\nnode store "Store"  right of app\nedge app -> store  "reads"  from: right  to: left\n`
                await api.save(project, slug, src, null)
                setCreating(null)
                await loadFiles(project)
                location.hash = hashFor(project, slug)
                setEditing(true)
              }
            }}
          />
        )}
      </main>
    </div>
  )
}

function Editor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ta = useRef<HTMLTextAreaElement>(null)
  const gutter = useRef<HTMLDivElement>(null)
  const lines = value.split("\n").length
  return (
    <div className="relative flex min-h-0 flex-1 font-mono text-[13px] leading-[1.6]">
      <div ref={gutter} className="ad-gutter overflow-hidden py-3 pr-2 pl-3 text-right" aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={ta}
        value={value}
        spellCheck={false}
        data-testid="source"
        onScroll={e => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop
        }}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Tab") {
            e.preventDefault()
            const t = e.currentTarget
            const { selectionStart: a, selectionEnd: b } = t
            onChange(t.value.slice(0, a) + "  " + t.value.slice(b))
            requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2))
          }
        }}
        className="min-h-0 flex-1 resize-none bg-transparent py-3 pr-3 pl-2 whitespace-pre outline-none"
      />
    </div>
  )
}

function CreateDialog({
  kind,
  existing,
  onCancel,
  onCreate,
}: {
  kind: "project" | "file"
  existing: string[]
  onCancel: () => void
  onCreate: (slug: string, title: string) => Promise<void>
}) {
  const [slug, setSlug] = useState("")
  const [title, setTitle] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const bad = slug && !SLUG.test(slug) ? "lowercase letters, digits and dashes" : existing.includes(slug) ? "that name is taken" : null
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/40 p-4" onClick={onCancel}>
      <form
        className="ad-dialog w-full max-w-sm"
        onClick={e => e.stopPropagation()}
        onSubmit={async e => {
          e.preventDefault()
          if (!slug || bad) return
          try {
            await onCreate(slug, title)
          } catch (x) {
            setErr(x instanceof Error ? x.message : String(x))
          }
        }}
      >
        <h3 className="mb-3 text-base font-semibold">{kind === "project" ? "New project" : "New diagram"}</h3>
        <label className="mb-1 block text-xs text-[var(--muted)]">{kind === "project" ? "Project name (the brain folder)" : "File name"}</label>
        <input autoFocus className="ad-input" value={slug} onChange={e => setSlug(e.target.value.trim())} placeholder={kind === "project" ? "my-project" : "data-flow"} />
        {kind === "file" && (
          <>
            <label className="mt-3 mb-1 block text-xs text-[var(--muted)]">Title</label>
            <input className="ad-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="Data flow" />
          </>
        )}
        <p className="mt-2 min-h-5 text-xs text-[var(--danger)]">{bad ?? err}</p>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" className="ad-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="ad-btn ad-btn-primary" disabled={!slug || !!bad}>
            Create
          </button>
        </div>
      </form>
    </div>
  )
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
      <rect x="3" y="7" width="11" height="8" rx="2" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      <rect x="18" y="17" width="11" height="8" rx="2" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      <path d="M14 11h4v10" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
    </svg>
  )
}
