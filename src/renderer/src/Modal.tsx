import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react'

export function Modal({ children, className, onCancel, title, active = true }: { children: ReactNode; className?: string; onCancel(): void; title: string; active?: boolean }): JSX.Element {
  const dialogRef = useRef<HTMLElement>(null)
  const headingId = useId()
  useLayoutEffect(() => {
    if (!active) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [active])
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, onCancel])
  return (
    <div className="modal-backdrop" role="presentation" style={active ? undefined : { display: 'none' }}>
      <section ref={dialogRef} tabIndex={-1} aria-labelledby={headingId} aria-modal="true" className={`modal ${className ?? ''}`} role="dialog" onKeyDown={(event) => {
        if (event.key === 'Tab') {
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]')].filter((element) => element.getClientRects().length > 0 && element.tabIndex >= 0)
          const first = focusable[0]
          const last = focusable.at(-1)
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }
        if (event.key === 'Escape') {
          event.stopPropagation()
          onCancel()
        }
      }}>
        <header><h2 id={headingId}>{title}</h2><button aria-label={`Close ${title}`} className="icon-button" type="button" onClick={onCancel}>x</button></header>
        {children}
      </section>
    </div>
  )
}
