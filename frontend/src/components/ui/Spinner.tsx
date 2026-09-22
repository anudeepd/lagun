import clsx from 'clsx'

export default function Spinner({ size = 'md', className }: { size?: 'sm' | 'md' | 'lg'; className?: string }) {
  return (
    <svg
      // The spinner is purely decorative: every loading state announces itself
      // through the label of the surrounding `LoadingState`/status region, so
      // exposing the graphic too would announce the same state twice.
      aria-hidden="true"
      focusable="false"
      className={clsx(
        'animate-spin text-brand-500',
        { 'h-3 w-3': size === 'sm', 'h-5 w-5': size === 'md', 'h-8 w-8': size === 'lg' },
        className
      )}
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  )
}

export function LoadingState({ label, compact = false, className }: { label: string; compact?: boolean; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={clsx(
        'flex items-center justify-center text-muted',
        compact ? 'gap-2 text-xs' : 'h-full flex-col gap-3 text-sm',
        className,
      )}
    >
      <Spinner size={compact ? 'sm' : 'md'} />
      <span>{label}</span>
    </div>
  )
}
