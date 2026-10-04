import { useEffect, useState } from "react"

/**
 * What the app is doing right now, in words, with the seconds it has taken: nobody is left wondering whether it is
 * stuck (Tawab, 10-04). After `slowAfter` seconds a second line says why it can take a while, and `onRetry` (if
 * given) offers a way out.
 */
export function Working({ label, slowNote, slowAfter = 8, onRetry, testid = "working" }: { label: string; slowNote?: string; slowAfter?: number; onRetry?: () => void; testid?: string }) {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const t0 = Date.now()
    const t = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 500)
    return () => clearInterval(t)
  }, [label])
  return (
    <div className="ad-working" role="status" aria-live="polite" data-testid={testid}>
      <div className="flex items-center justify-center gap-2">
        <span className="ad-spin" aria-hidden />
        <span>
          {label}
          {secs >= 2 ? <span className="text-[var(--muted)]"> · {secs} s</span> : null}
        </span>
      </div>
      {secs >= slowAfter && (slowNote || onRetry) && (
        <div className="mt-2 text-xs text-[var(--muted)]">
          {slowNote}
          {onRetry && (
            <button type="button" className="ml-2 text-[var(--accent)] underline-offset-4 hover:underline" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  )
}
