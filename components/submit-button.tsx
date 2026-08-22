'use client'

import { useFormStatus } from 'react-dom'

/**
 * A submit button that shows a spinner + pending label while its server action runs, and
 * disables itself so a form can't be double-submitted. Uses React 19's useFormStatus, so it
 * must live INSIDE the <form> whose action it reports on. The `.spinner` class is global
 * (app/globals.css).
 */
export function SubmitButton({
  className,
  children,
  pendingLabel,
}: {
  className?: string
  children: React.ReactNode
  pendingLabel: string
}) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className={className} disabled={pending} aria-busy={pending}>
      {pending ? (
        <>
          <span className="spinner" aria-hidden="true" /> {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  )
}
