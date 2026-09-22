/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          50:  '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          700: '#334155',
          800: '#1e293b',
          900: '#0f172a',
          950: '#020617',
        },
        brand: {
          400: '#60a5fa',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
        },
        // Informational secondary text. slate-500 (#64748b) measured 3.75:1 on
        // surface-900 and 4.24:1 on surface-950 — below AA — while this value is
        // 6.96:1 and 7.87:1, and matches --lagun-muted-text.
        muted: '#94a3b8',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'ui-monospace', 'monospace'],
        data: ['var(--lagun-data-font)'],
      },
      zIndex: {
        base: '0',
        raised: '10',
        navigation: '30',
        popover: '40',
        modal: '50',
        toast: '60',
        critical: '70',
      },
    },
  },
  plugins: [],
}
