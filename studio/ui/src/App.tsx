import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { agentApi, diffCount, lineDiff, type Proposal, type Status, type Target } from "./agent"
import { Canvas, type Card } from "./Canvas"
import { ChatPanel } from "./Chat"
import { ConnectDialog, Confirm, ExportDialog, NameDialog, SettingsDialog, TrashDialog } from "./Dialogs"
import { Inbox } from "./Inbox"
import { Menu } from "./Menu"
import { ApiError, api, hashFor, inboxHash, meta, parseHash, type FileMeta, type Project } from "./model"
import { Palette } from "./Palette"
import { renderSource } from "./render"

const DOCK_W = 440
const EDIT_W = 560
const GHOST = "~proposed"

const remember = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k)
    else localStorage.setItem(k, v)
  } catch {
    /* storage blocked: the choice lasts this visit */
  }
}
const recall = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}

/** Light or dark: the Settings theme, where "system" follows the OS. */
const useDark = (theme: "system" | "light" | "dark") => {
  const media = window.matchMedia("(prefers-color-scheme: dark)")
  const [sys, setSys] = useState(media.matches)
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setSys(e.matches)
    media.addEventListener("change", on)
    return () => media.removeEventListener("change", on)
  }, [media])
  const dark = theme === "dark" || (theme === "system" && sys)
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light"
  }, [dark])
  return dark
}

const ago = (t: number) => {
  const s = Date.now() / 1000 - t
  if (s < 90) return "just now"
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

const STATUS_LABEL: Record<string, string> = { added: "new · waiting", changed: "changed · waiting" }

type DialogState =
  | null
  | { kind: "connect" }
  | { kind: "new-diagram" }
  | { kind: "rename"; name: string }
  | { kind: "duplicate"; name: string }
  | { kind: "delete"; name: string }
  | { kind: "export"; name?: string }
  | { kind: "trash" }
  | { kind: "settings" }
  | { kind: "rename-project"; slug: string }
  | { kind: "disconnect"; slug: string }

export default function App() {
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system")
  const dark = useDark(theme)
  const [route, setRoute] = useState(() => parseHash(location.hash))
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [files, setFiles] = useState<FileMeta[]>([])
  const [sources, setSources] = useState<Record<string, { source: string; version: string }>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [menu, setMenu] = useState(false)
  const [focus, setFocus] = useState<{ key?: string; with?: string; n: number }>({ n: 0 })
  const [fitAll, setFitAll] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [palette, setPalette] = useState(false)
  const [targets, setTargets] = useState<Target[]>([])
  const [chat, setChat] = useState(false)
  const [talk, setTalk] = useState<string | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [staged, setStaged] = useState<{ p: Proposal } | null>(null)
  const [chatFocus, setChatFocus] = useState(0)
  const [loaded, setLoaded] = useState<string | null>(null) // the project whose diagrams have arrived

  // switching project drops this project's drafts: ask first, and stay put on no (review L-c)
  const unsavedRef = useRef(false)
  const routeRef = useRef(route)
  routeRef.current = route
  useEffect(() => {
    const on = (e: HashChangeEvent) => {
      const next = parseHash(location.hash)
      if (unsavedRef.current && (next.inbox || next.project !== routeRef.current.project) && !window.confirm("Discard unsaved edits in this project?")) {
        history.replaceState(null, "", new URL(e.oldURL).hash)
        return
      }
      setRoute(next)
      setMenu(false)
    }
    window.addEventListener("hashchange", on)
    return () => window.removeEventListener("hashchange", on)
  }, [])

  useEffect(() => {
    api.settings().then(v => setTheme(v.settings.theme), () => undefined)
  }, [])

  const loadProjects = useCallback(() => {
    api.projects().then(setProjects, e => setError(String(e.message ?? e)))
  }, [])
  useEffect(loadProjects, [loadProjects])

  // default to the first project that is not archived
  useEffect(() => {
    const first = projects?.find(p => !p.archived)
    if (first && !route.project && !route.inbox) location.replace(hashFor(first.slug))
  }, [projects, route.project, route.inbox])

  const project = route.inbox ? undefined : route.project
  const current = projects?.find(p => p.slug === (route.project ?? ""))
  const loadFiles = useCallback(async (p: string) => {
    const list = await api.files(p)
    const docs = await Promise.all(list.map(f => api.read(p, f.name)))
    setFiles(list)
    setSources(Object.fromEntries(docs.map(d => [d.name, { source: d.source, version: d.version }])))
    setLoaded(p)
  }, [])
  const reload = useCallback(async () => {
    loadProjects()
    if (project) await loadFiles(project).catch(e => setError(e instanceof ApiError ? e.message : String(e)))
  }, [project, loadFiles, loadProjects])

  useEffect(() => {
    if (!project) return
    setFiles([])
    setSources({})
    setDrafts({})
    setStaged(null)
    setError(null)
    setLoaded(null)
    setTalk(recall(`archdraw:talk:${project}`))
    loadFiles(project).catch(e => setError(e instanceof ApiError ? e.message : String(e)))
  }, [project, loadFiles])

  // the selected file flies into view
  useEffect(() => {
    setFocus(f => ({ key: route.file, n: f.n + 1 }))
  }, [route.file, project, files.length])

  const accept = useCallback(
    async (p: Proposal) => {
      if (!project) return
      const exists = files.some(f => f.name === p.name)
      try {
        const r = await api.save(project, p.name, p.source, exists ? (sources[p.name]?.version ?? null) : null, p.doc ?? null)
        setSources(s => ({ ...s, [p.name]: { source: p.source, version: r.version } }))
        setDrafts(d => {
          const { [p.name]: _, ...rest } = d
          return rest
        })
        setStaged(null)
        setNotice(current?.source.kind === "github" ? "Accepted · waiting for review in the Inbox" : "Accepted and saved")
        await reload()
        location.hash = hashFor(project, p.name)
      } catch (e) {
        setNotice(e instanceof ApiError ? `Not saved: ${e.message}` : `Not saved: ${String(e)}`)
        throw e
      }
    },
    [project, files, sources, reload, current],
  )

  // a proposal on the canvas: a dashed card beside the diagram it would replace, framed together
  const stage = useCallback(
    (p: Proposal | null) => {
      const exists = (name: string) => files.some(f => f.name === name)
      setStaged(p ? { p } : null)
      if (p && window.innerWidth < 640) setChat(false) // on a phone the dock covers the canvas; the card carries Accept
      if (p) setFocus(f => ({ key: p.name + GHOST, with: exists(p.name) ? p.name : undefined, n: f.n + 1 }))
    },
    [files],
  )

  const cards: Card[] = useMemo(() => {
    const out: Card[] = files.map(f => {
      const source = drafts[f.name] ?? sources[f.name]?.source ?? ""
      const m = meta(source)
      return { key: f.name, title: m.title ?? f.name, summary: m.summary ?? "", r: renderSource(source, dark), badge: STATUS_LABEL[f.status] }
    })
    const p = staged?.p
    if (p) {
      const m = meta(p.source)
      const before = sources[p.name]?.source
      const { added, removed } = diffCount(lineDiff(before ?? "", p.source))
      const ghost: Card = {
        key: p.name + GHOST,
        title: m.title ?? p.name,
        summary: m.summary ?? "",
        r: renderSource(p.source, dark),
        ghost: true,
        badge: before === undefined ? "Proposed · new diagram" : `Proposed · +${added} −${removed}`,
        actions: (
          <>
            <button type="button" className="ad-btn" onClick={() => setStaged(null)}>
              Dismiss
            </button>
            <button type="button" className="ad-btn ad-btn-primary" onClick={() => void accept(p).catch(() => undefined)} data-testid="ghost-accept">
              {before === undefined ? "Create" : "Accept"}
            </button>
          </>
        ),
      }
      const at = out.findIndex(c => c.key === p.name)
      out.splice(at < 0 ? out.length : at + 1, 0, ghost)
    }
    return out
  }, [files, sources, drafts, dark, staged, accept])

  const sel = route.file && files.some(f => f.name === route.file) ? route.file : undefined
  const selSource = sel ? (drafts[sel] ?? sources[sel]?.source ?? "") : ""
  const selCard = cards.find(c => c.key === sel)
  const dirty = !!sel && drafts[sel] !== undefined && drafts[sel] !== sources[sel]?.source

  const save = useCallback(async () => {
    if (!project || !sel || !dirty || saving) return
    if (selCard?.r.error) {
      setNotice("Not saved: the diagram has an error (see the line under the editor)")
      return
    }
    setSaving(true)
    const sent = drafts[sel]
    try {
      const r = await api.save(project, sel, sent, sources[sel]?.version ?? null)
      const saved = sent.endsWith("\n") ? sent : sent + "\n"
      setSources(s => ({ ...s, [sel]: { source: saved, version: r.version } }))
      // only drop the draft if nothing was typed while the save was in flight (review M3)
      setDrafts(d => {
        if (d[sel] !== sent) return d
        const { [sel]: _, ...rest } = d
        return rest
      })
      setNotice(current?.source.kind === "github" ? "Saved · waiting for review in the Inbox" : "Saved")
      api.files(project).then(setFiles)
      loadProjects()
    } catch (e) {
      setNotice(e instanceof ApiError ? `Not saved: ${e.message}` : `Not saved: ${String(e)}`)
    } finally {
      setSaving(false)
    }
  }, [project, sel, dirty, saving, drafts, sources, selCard, current, loadProjects])

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault()
        void save()
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        setPalette(p => !p)
      }
      if (e.key === "Escape" && !dialog) {
        if (palette) setPalette(false)
        else setEditing(false)
      }
    }
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  }, [save, palette, dialog])

  // the palette's targets: every project, and every diagram in each
  useEffect(() => {
    if (!palette || !projects) return
    Promise.all(projects.filter(p => !p.archived).map(p => api.files(p.slug).then(fs => [p, fs] as const)))
      .then(all =>
        setTargets(
          all.flatMap(([p, fs]) => [
            { kind: "project" as const, project: p.slug, title: p.title, hint: `${fs.length} diagrams` },
            ...fs.map(f => ({ kind: "file" as const, project: p.slug, file: f.name, title: f.title, hint: p.title })),
          ]),
        ),
      )
      .catch(() => undefined)
  }, [palette, projects])

  // the agent's budget and this project's conversations, while the chat is open
  const refreshStatus = useCallback(() => {
    agentApi.status().then(setStatus, () => undefined)
  }, [])
  useEffect(() => {
    if (!chat) return
    refreshStatus()
    const t = setInterval(refreshStatus, 20000)
    return () => clearInterval(t)
  }, [chat, refreshStatus])

  // every path that needs a conversation goes through `opening`, so the panel and a ⌘K ask never start two
  const opening = useRef<Promise<string> | null>(null)
  const openTalk = useCallback(
    (forProject?: string) => {
      const p = forProject ?? project
      if (!p) return Promise.reject(new Error("no project"))
      if (!opening.current) {
        opening.current = agentApi
          .open(p)
          .then(c => {
            remember(`archdraw:talk:${p}`, c.id)
            setTalk(c.id)
            return c.id
          })
          .finally(() => (opening.current = null))
      }
      return opening.current
    },
    [project],
  )
  useEffect(() => {
    if (chat && project && !talk) openTalk().catch(e => setNotice(e instanceof ApiError ? e.message : String(e)))
  }, [chat, project, talk, openTalk])

  const openChat = () => {
    setChat(true)
    setEditing(false)
    setChatFocus(n => n + 1)
  }

  const ask = useCallback(
    async (text: string) => {
      if (!project) return
      const send = (id: string) => agentApi.say(id, text, sel, sel ? selSource : undefined)
      try {
        try {
          await send(talk ?? (await openTalk()))
        } catch (e) {
          // the remembered conversation ended (409) or the app restarted (404): one fresh conversation, then send
          if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 409)) throw e
          setTalk(null)
          await send(await openTalk())
        }
      } catch (e) {
        setNotice(e instanceof ApiError ? e.message : String(e))
        throw e
      }
      refreshStatus()
    },
    [project, talk, sel, selSource, refreshStatus, openTalk],
  )

  // asking from the inbox: go to the project, open the chat, send
  const pendingAsk = useRef<string | null>(null)
  const askAbout = (p: string, text: string) => {
    pendingAsk.current = text
    location.hash = hashFor(p)
    openChat()
  }
  useEffect(() => {
    if (project && pendingAsk.current && files.length) {
      const t = pendingAsk.current
      pendingAsk.current = null
      void ask(t).catch(() => undefined)
    }
  }, [project, files.length, ask])

  // unsaved edits survive nothing: warn before the tab closes or reloads (review L5)
  const unsaved = Object.entries(drafts).some(([k, v]) => v !== sources[k]?.source)
  unsavedRef.current = unsaved
  useEffect(() => {
    if (!unsaved) return
    const on = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener("beforeunload", on)
    return () => window.removeEventListener("beforeunload", on)
  }, [unsaved])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 4500)
    return () => clearTimeout(t)
  }, [notice])

  const waitingCount = projects?.filter(p => p.pending && !p.archived).length ?? 0
  const panelW = editing && sel ? Math.min(EDIT_W, window.innerWidth) : chat && !route.inbox ? Math.min(DOCK_W, window.innerWidth) : 0
  const live = projects?.filter(p => !p.archived) ?? []
  const shelved = projects?.filter(p => p.archived) ?? []

  const diagramMenu = (name: string) => [
    { label: "Rename…", onSelect: () => setDialog({ kind: "rename", name }) },
    { label: "Duplicate…", onSelect: () => setDialog({ kind: "duplicate", name }) },
    { label: "Export…", onSelect: () => setDialog({ kind: "export", name }) },
    {
      label: "Copy link",
      onSelect: () => {
        const url = `${location.origin}${location.pathname}${hashFor(project, name)}`
        navigator.clipboard?.writeText(url).then(() => setNotice("Link copied"), () => setNotice(url))
      },
    },
    "separator" as const,
    {
      label: "Archive",
      onSelect: async () => {
        try {
          await api.archive(project!, name)
          setNotice(`${name} archived · restore it from Archive and trash`)
          if (route.file === name) location.hash = hashFor(project)
          await reload()
        } catch (e) {
          setNotice(e instanceof ApiError ? e.message : String(e))
        }
      },
    },
    { label: "Delete…", danger: true, onSelect: () => setDialog({ kind: "delete", name }) },
  ]

  const projectMenu = (p: Project) => [
    { label: "Rename…", onSelect: () => setDialog({ kind: "rename-project", slug: p.slug }) },
    ...(p.source.kind === "github"
      ? [
          {
            label: "Sync now",
            onSelect: async () => {
              setNotice(`Checking ${p.title}…`)
              try {
                const r = await api.sync(p.slug)
                setNotice(r.outcome === "drafted" ? `${p.title}: an update is waiting in the Inbox` : r.outcome === "skipped" ? `${p.title}: ${r.reason}` : `${p.title}: up to date`)
                await reload()
              } catch (e) {
                setNotice(e instanceof ApiError ? e.message : String(e))
              }
            },
          },
        ]
      : []),
    { label: "Export…", onSelect: () => (location.hash = hashFor(p.slug), setDialog({ kind: "export" })) },
    { label: "Settings…", onSelect: () => (location.hash = hashFor(p.slug), setDialog({ kind: "settings" })) },
    "separator" as const,
    {
      label: p.archived ? "Unarchive" : "Archive",
      onSelect: async () => {
        await api.updateProject(p.slug, { archived: !p.archived })
        loadProjects()
      },
    },
    { label: "Remove from archdraw…", danger: true, onSelect: () => setDialog({ kind: "disconnect", slug: p.slug }) },
  ]

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-[var(--page)] text-[var(--text)]">
      <aside
        className={`ad-side z-20 flex w-72 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--panel)] max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:shadow-2xl ${menu ? "" : "max-md:-translate-x-full"} transition-transform`}
        data-tour="sidebar"
      >
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">archdraw</span>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <a href={inboxHash()} className={`ad-item ${route.inbox ? "ad-item-on" : ""}`} data-testid="nav-inbox" data-tour="inbox">
            <span>Inbox</span>
            {waitingCount > 0 && <span className="ad-count">{waitingCount}</span>}
          </a>
          <div className="ad-label mt-2">Projects</div>
          {live.map(p => (
            <div key={p.slug} className={`ad-item ad-row-hover ${p.slug === route.project && !route.inbox ? "ad-item-on" : ""}`}>
              <a href={hashFor(p.slug)} className="flex min-w-0 flex-1 items-center gap-2" data-testid={`project-${p.slug}`}>
                <span className="truncate">{p.title}</span>
                {p.pending && <span className="ad-pip" title="changes waiting" />}
              </a>
              <span className="text-xs text-[var(--muted)]">{p.files}</span>
              <Menu label={`${p.title} menu`} items={projectMenu(p)} testid={`project-menu-${p.slug}`} />
            </div>
          ))}
          {projects?.length === 0 && <p className="px-3 py-2 text-sm text-[var(--muted)]">No projects yet.</p>}
          <button type="button" className="ad-item text-[var(--muted)]" onClick={() => setDialog({ kind: "connect" })} data-testid="add-project">
            + Add project
          </button>
          {project && (
            <>
              <div className="ad-label mt-4">Diagrams</div>
              {files.map(f => {
                const m = meta(drafts[f.name] ?? sources[f.name]?.source ?? "")
                return (
                  <div key={f.name} className={`ad-item ad-file ad-row-hover ${f.name === sel ? "ad-item-on" : ""}`}>
                    <a href={hashFor(project, f.name)} className="block min-w-0 flex-1" data-testid={`file-${f.name}`}>
                      <span className="block truncate font-medium">{m.title ?? f.title}</span>
                      <span className="block truncate text-xs text-[var(--muted)]">{m.summary ?? f.summary}</span>
                      <span className="block text-[11px] text-[var(--muted)]">
                        {f.name} · {ago(f.updated)}
                        {f.status !== "same" ? ` · ${STATUS_LABEL[f.status]}` : ""}
                        {drafts[f.name] !== undefined && drafts[f.name] !== sources[f.name]?.source ? " · unsaved" : ""}
                      </span>
                    </a>
                    <Menu label={`${f.name} menu`} items={diagramMenu(f.name)} testid={`file-menu-${f.name}`} />
                  </div>
                )
              })}
              <button type="button" className="ad-item text-[var(--muted)]" onClick={() => setDialog({ kind: "new-diagram" })} data-testid="new-diagram">
                + New diagram
              </button>
            </>
          )}
          {shelved.length > 0 && (
            <details className="mt-4">
              <summary className="ad-label cursor-pointer">Archived projects ({shelved.length})</summary>
              {shelved.map(p => (
                <div key={p.slug} className="ad-item ad-row-hover text-[var(--muted)]">
                  <span className="min-w-0 flex-1 truncate">{p.title}</span>
                  <Menu label={`${p.title} menu`} items={projectMenu(p)} />
                </div>
              ))}
            </details>
          )}
        </nav>
        <div className="flex items-center gap-1 border-t border-[var(--line)] px-2 py-2">
          {project && (
            <button type="button" className="ad-btn ad-btn-quiet" onClick={() => setDialog({ kind: "trash" })} data-testid="open-trash">
              Archive and trash
            </button>
          )}
          <span className="ml-auto" />
          <button type="button" className="ad-btn ad-btn-quiet" onClick={() => setDialog({ kind: "settings" })} data-testid="open-settings" aria-label="Settings">
            ⚙ Settings
          </button>
        </div>
      </aside>
      {menu && <div className="fixed inset-0 z-10 bg-black/30 md:hidden" onClick={() => setMenu(false)} />}

      <main className="relative min-w-0 flex-1">
        {route.inbox ? (
          <div className="h-full overflow-y-auto">
            <div className="flex items-center gap-2 px-3 py-2 md:hidden">
              <button type="button" className="ad-btn" aria-label="Menu" onClick={() => setMenu(true)}>
                ☰
              </button>
            </div>
            <Inbox dark={dark} focusProject={route.project} onAsk={askAbout} onOpen={(p, f) => (location.hash = hashFor(p, f))} onChanged={loadProjects} />
          </div>
        ) : (
          <>
            <header className="ad-top absolute left-0 top-0 z-10 flex items-center gap-2 px-3 py-2" style={{ right: panelW }}>
              <button type="button" className="ad-btn md:hidden" aria-label="Menu" onClick={() => setMenu(true)}>
                ☰
              </button>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{selCard?.title ?? current?.title ?? "archdraw"}</div>
                <div className="truncate text-xs text-[var(--muted)]">{selCard ? selCard.summary : current ? `${files.length} diagrams` : ""}</div>
              </div>
              <div className="ml-auto flex items-center gap-1">
                {sel && (
                  <button type="button" className="ad-btn max-sm:hidden" onClick={() => (setEditing(e => !e), setChat(false))} data-testid="toggle-source">
                    {editing ? "Close source" : "Source"}
                  </button>
                )}
                {project && (
                  <button type="button" className="ad-btn ad-btn-ask" onClick={() => (chat ? setChat(false) : openChat())} data-testid="open-chat" data-tour="ask" title="The archdraw agent (⌘K to jump or ask)">
                    ✦ Ask<kbd className="max-sm:hidden">⌘K</kbd>
                  </button>
                )}
                {project && files.length > 0 && (
                  <button type="button" className="ad-btn max-sm:hidden" onClick={() => setDialog({ kind: "export", name: sel })} data-testid="open-export">
                    Export
                  </button>
                )}
                <button type="button" className="ad-btn" onClick={() => setFitAll(n => n + 1)} title="Fit every diagram">
                  All
                </button>
              </div>
            </header>

            {current?.pending && (
              <a href={inboxHash(current.slug)} className="ad-banner" style={{ right: panelW + 16 }} data-testid="waiting-banner">
                <span className="ad-dot" data-busy />
                Changes waiting for review
                <span className="font-semibold">Review →</span>
              </a>
            )}

            {error ? (
              <div className="grid h-full place-items-center p-6 text-center text-sm text-[var(--muted)]">{error}</div>
            ) : projects && projects.length === 0 ? (
              <Empty onAdd={() => setDialog({ kind: "connect" })} />
            ) : project && loaded !== project ? (
              <div className="grid h-full place-items-center text-sm text-[var(--muted)]" data-testid="loading">
                Loading {current?.title ?? project}…
              </div>
            ) : project && files.length === 0 && !staged ? (
              <div className="grid h-full place-items-center p-6 text-center">
                <div className="max-w-sm">
                  <p className="text-sm text-[var(--muted)]">No diagrams in this project yet.</p>
                  <div className="mt-3 flex justify-center gap-2">
                    <button type="button" className="ad-btn ad-btn-primary" onClick={() => (openChat(), void ask("Draw this project's system overview: read the code first, then propose the diagram and its explanation.").catch(() => undefined))} data-testid="draft-first">
                      ✦ Draw it for me
                    </button>
                    <button type="button" className="ad-btn" onClick={() => setDialog({ kind: "new-diagram" })}>
                      Start from a blank diagram
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <Canvas cards={cards} selected={sel} onSelect={k => (location.hash = hashFor(project, k))} focus={focus} fitAll={fitAll} dark={dark} insetRight={panelW} />
            )}

            {editing && sel && (
              <section className="ad-editor absolute bottom-0 right-0 top-0 z-20 flex w-[min(560px,100%)] flex-col" data-testid="editor">
                <div className="flex items-center gap-2 border-b border-[var(--line)] px-3 py-2">
                  <span className="truncate font-mono text-xs text-[var(--muted)]">.archdraw/{sel}.archdraw</span>
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
                  {selCard?.r.error ?? (current?.source.kind === "github" ? "Renders. ⌘/Ctrl-S saves it as a change waiting for review; the card updates as you type." : "Renders. ⌘/Ctrl-S saves it; the card updates as you type.")}
                </div>
              </section>
            )}

            {chat && project && (
              <ChatPanel
                variant="dock"
                project={project}
                id={talk}
                history={(status?.conversations ?? []).filter(c => c.project === project)}
                budget={{ conversation: status?.conversation_budget ?? 1, spentToday: status?.spent_today ?? 0, day: status?.day_budget ?? 10 }}
                existing={Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.source]))}
                staged={staged ? { name: staged.p.name, n: staged.p.n } : null}
                onSend={ask}
                onNew={() => {
                  remember(`archdraw:talk:${project}`, null)
                  if (talk) void agentApi.close(talk).catch(() => undefined)
                  setTalk(null)
                  setStaged(null)
                  setChatFocus(n => n + 1)
                }}
                onPick={id => {
                  remember(`archdraw:talk:${project}`, id)
                  setTalk(id)
                }}
                onClose={() => setChat(false)}
                onStage={stage}
                onAccept={accept}
                focusKey={chatFocus}
                onCost={refreshStatus}
              />
            )}
          </>
        )}

        {palette && (
          <Palette
            targets={targets}
            project={route.project}
            onClose={() => setPalette(false)}
            onGo={t => {
              setPalette(false)
              location.hash = hashFor(t.project, t.file)
            }}
            onAsk={text => {
              setPalette(false)
              if (!project) return setNotice("Open a project first, then ask about it")
              openChat()
              void ask(text).catch(() => undefined)
            }}
          />
        )}
        {notice && (
          <div className="ad-toast absolute bottom-16 left-1/2 z-30 -translate-x-1/2" role="status" data-testid="toast">
            {notice}
          </div>
        )}
      </main>

      {dialog?.kind === "connect" && (
        <ConnectDialog
          onClose={() => setDialog(null)}
          onConnected={p => {
            setDialog(null)
            loadProjects()
            location.hash = hashFor(p.slug)
          }}
        />
      )}
      {dialog?.kind === "new-diagram" && project && (
        <NameDialog
          title="New diagram"
          action="Create"
          withTitle
          taken={files.map(f => f.name)}
          onClose={() => setDialog(null)}
          onSubmit={async (name, title) => {
            const src = `// title: ${title || name}\n// summary: One sentence on what this diagram shows.\n\nnode app "App"\nnode store "Store"  right of app\nedge app -> store  "reads"  from: right  to: left\n`
            await api.save(project, name, src, null)
            setDialog(null)
            await reload()
            location.hash = hashFor(project, name)
            setEditing(true)
          }}
        />
      )}
      {(dialog?.kind === "rename" || dialog?.kind === "duplicate") && project && (
        <NameDialog
          title={dialog.kind === "rename" ? `Rename ${dialog.name}` : `Duplicate ${dialog.name}`}
          initial={dialog.kind === "rename" ? dialog.name : `${dialog.name}-copy`}
          action={dialog.kind === "rename" ? "Rename" : "Duplicate"}
          taken={files.map(f => f.name)}
          onClose={() => setDialog(null)}
          onSubmit={async name => {
            if (dialog.kind === "rename") await api.rename(project, dialog.name, name)
            else await api.duplicate(project, dialog.name, name)
            setDialog(null)
            await reload()
            location.hash = hashFor(project, name)
          }}
        />
      )}
      {dialog?.kind === "delete" && project && (
        <Confirm
          title={`Delete ${dialog.name}?`}
          body={<p>It goes to the trash: Archive and trash brings it back for 30 days.</p>}
          action="Delete"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.remove(project, dialog.name)
            setDialog(null)
            if (route.file === dialog.name) location.hash = hashFor(project)
            await reload()
            setNotice(`${dialog.name} deleted`)
          }}
        />
      )}
      {dialog?.kind === "rename-project" && (
        <ProjectTitleDialog
          project={projects!.find(p => p.slug === dialog.slug)!}
          onClose={() => setDialog(null)}
          onSaved={() => (setDialog(null), loadProjects())}
        />
      )}
      {dialog?.kind === "disconnect" && (
        <Confirm
          title="Remove this project from archdraw?"
          body={<p>archdraw forgets it and deletes its own copy on this machine. The repo and its diagrams are not touched; add it again any time.</p>}
          action="Remove"
          danger
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.disconnect(dialog.slug)
            setDialog(null)
            location.hash = "#/"
            loadProjects()
          }}
        />
      )}
      {dialog?.kind === "export" && project && (
        <ExportDialog project={project} diagram={dialog.name} source={dialog.name ? (drafts[dialog.name] ?? sources[dialog.name]?.source) : undefined} svg={dialog.name ? cards.find(c => c.key === dialog.name)?.r.svg : undefined} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === "trash" && project && <TrashDialog project={project} onClose={() => setDialog(null)} onRestored={name => (setNotice(`${name} restored`), void reload())} />}
      {dialog?.kind === "settings" && (
        <SettingsDialog
          project={current}
          onClose={() => setDialog(null)}
          onSaved={() => {
            api.settings().then(v => setTheme(v.settings.theme), () => undefined)
            loadProjects()
          }}
        />
      )}
    </div>
  )
}

function ProjectTitleDialog({ project, onClose, onSaved }: { project: Project; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(project.title)
  return (
    <div className="ad-scrim" onMouseDown={onClose}>
      <form
        className="ad-dialog w-full max-w-sm"
        onMouseDown={e => e.stopPropagation()}
        onSubmit={async e => {
          e.preventDefault()
          await api.updateProject(project.slug, { title })
          onSaved()
        }}
      >
        <h3 className="mb-3 text-base font-semibold">Rename project</h3>
        <input autoFocus className="ad-input" value={title} onChange={e => setTitle(e.target.value)} data-testid="project-title" />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="ad-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="ad-btn ad-btn-primary" disabled={!title.trim()}>
            Rename
          </button>
        </div>
      </form>
    </div>
  )
}

function Empty({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center" data-testid="empty">
      <div className="max-w-sm">
        <h2 className="text-xl font-semibold">Show me my architecture.</h2>
        <p className="mt-2 text-sm text-[var(--muted)]">Add a GitHub repo or a folder. archdraw keeps its diagrams in the repo's .archdraw/ folder and checks main every hour.</p>
        <button type="button" className="ad-btn ad-btn-primary mt-4" onClick={onAdd} data-testid="empty-add">
          Add a project
        </button>
      </div>
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

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
      <rect x="3" y="7" width="11" height="8" rx="2" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      <rect x="18" y="17" width="11" height="8" rx="2" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      <path d="M14 11h4v10" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
    </svg>
  )
}
