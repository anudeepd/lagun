interface LogoProps {
  size?: 'sm' | 'md' | 'lg'
  showText?: boolean
  className?: string
}

const sizeMap = {
  sm: 'w-7 h-7',
  md: 'w-9 h-9',
  lg: 'w-14 h-14',
}

const textSizeMap = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-xl',
}

export default function Logo({ size = 'md', showText = true, className = '' }: LogoProps) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <svg
        viewBox="0 0 128 128"
        xmlns="http://www.w3.org/2000/svg"
        className={`${sizeMap[size]} flex-shrink-0`}
      >
        {/* Rounded square background */}
        <rect x="4" y="4" width="120" height="120" rx="24" fill="#f0f9ff" />

        {/* Water waves */}
        <g fill="none" stroke="#2563eb" strokeWidth="3" strokeLinecap="round">
          <path d="M 28 34 Q 38 26 48 34 T 68 34 T 88 34 T 100 34" />
          <path d="M 28 50 Q 38 42 48 50 T 68 50 T 88 50 T 100 50" />
          <path d="M 28 66 Q 38 58 48 66 T 68 66 T 88 66 T 100 66" />
        </g>

        {/* Database grid */}
        <g fill="none" stroke="#0891b2" strokeWidth="2.5" strokeLinecap="round">
          <line x1="28" y1="82" x2="100" y2="82" />
          <line x1="28" y1="94" x2="100" y2="94" />
          <line x1="52" y1="82" x2="52" y2="94" />
          <line x1="76" y1="82" x2="76" y2="94" />
        </g>

        {/* Accent node */}
        <circle cx="64" cy="74" r="3" fill="#0284c7" />
      </svg>

      {showText && (
        <span className={`font-semibold text-slate-100 ${textSizeMap[size]} tracking-tight`}>
          Lagun
        </span>
      )}
    </div>
  )
}
