import clsx from 'clsx'

interface ProgressProps {
  /**
   * Completion in percent (0–100, clamped). Omit it — or pass `null` — when no
   * honest total exists: the bar then sweeps indefinitely instead of showing a
   * number nobody can back up.
   */
  value?: number | null
  /** Accessible name; the bar carries no visible label of its own. */
  label?: string
  className?: string
}

export default function Progress({ value, label, className }: ProgressProps) {
  const determinate = typeof value === 'number' && Number.isFinite(value)
  const percent = determinate ? Math.min(100, Math.max(0, value)) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? percent : undefined}
      aria-valuetext={determinate ? undefined : 'In progress'}
      className={clsx('h-1.5 w-full overflow-hidden rounded-full bg-surface-700', className)}
    >
      {determinate ? (
        <div
          data-testid="progress-fill"
          // A transition, not a keyframe: progress arrives as a stream of new
          // values, and each one must retarget from where the fill already is
          // instead of restarting from zero.
          className="h-full origin-left rounded-full bg-brand-500 transition-transform duration-[var(--motion-duration-surface)] ease-[var(--motion-ease-move)]"
          style={{ transform: `scaleX(${percent / 100})` }}
        />
      ) : (
        <div
          data-testid="progress-fill"
          // No value to animate towards, so this one sweep is keyframed
          // (`lagun-progress-indeterminate` in index.css). It loops, so it gets
          // its own steady period and a symmetric curve: the one-shot motion
          // tokens (380ms, strong ease-out) flung the fill off the track almost
          // at once and left it invisible for most of each cycle — a flicker.
          // Reduced motion gets no sweep at all, so the fill spans the track at
          // reduced strength instead of parking as a static third that reads as
          // "33% done".
          className="h-full w-1/3 rounded-full bg-brand-500 motion-safe:animate-[lagun-progress-indeterminate_1.5s_ease-in-out_infinite] motion-reduce:w-full motion-reduce:opacity-50"
        />
      )}
    </div>
  )
}
