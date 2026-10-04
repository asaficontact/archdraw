import { useEffect, useRef, useState } from "react"

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean; hint?: string } | "separator"

/** The "…" button and its menu: click or Enter opens it, Esc or a click elsewhere closes it, arrows move. */
export function Menu({ items, label, testid }: { items: MenuItem[]; label: string; testid?: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener("mousedown", off)
    list.current?.querySelector<HTMLButtonElement>("button")?.focus()
    return () => window.removeEventListener("mousedown", off)
  }, [open])
  return (
    <div className="relative" ref={box} onClick={e => e.stopPropagation()}>
      <button
        type="button"
        className="ad-dots"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testid}
        onClick={e => {
          e.preventDefault()
          setOpen(o => !o)
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          ref={list}
          role="menu"
          className="ad-menu"
          onKeyDown={e => {
            const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
            const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
            if (e.key === "Escape") setOpen(false)
            else if (e.key === "ArrowDown") buttons[(i + 1) % buttons.length]?.focus()
            else if (e.key === "ArrowUp") buttons[(i - 1 + buttons.length) % buttons.length]?.focus()
            else return
            e.preventDefault()
          }}
        >
          {items.map((it, i) =>
            it === "separator" ? (
              <div key={i} className="ad-menu-sep" />
            ) : (
              <button
                type="button"
                role="menuitem"
                key={i}
                className={`ad-menu-item ${it.danger ? "text-[var(--danger)]" : ""}`}
                onClick={e => {
                  e.preventDefault()
                  setOpen(false)
                  it.onSelect()
                }}
              >
                <span>{it.label}</span>
                {it.hint && <span className="ml-auto text-[11px] text-[var(--muted)]">{it.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  )
}
