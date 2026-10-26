import { createLogger, defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const DEFAULT_CHUNK_BUDGET_KB = 500
const GRID_CHUNK_BUDGET_KB = 800
let chunkBudgetsPassed = false
const logger = createLogger()
const warn = logger.warn.bind(logger)
logger.warn = (message, options) => {
  // Vite has one global limit. Replace only its generic size warning after
  // the stricter per-chunk policy below has successfully checked every chunk.
  if (chunkBudgetsPassed && message.includes('Some chunks are larger than')) return
  warn(message, options)
}

const chunkBudgets: Plugin = {
  name: 'lagun-chunk-budgets',
  apply: 'build',
  buildStart() {
    chunkBudgetsPassed = false
  },
  generateBundle(_options, bundle) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type !== 'chunk') continue
      const budget = chunk.name === 'vendor-ag-grid'
        ? GRID_CHUNK_BUDGET_KB
        : DEFAULT_CHUNK_BUDGET_KB
      const size = Buffer.byteLength(chunk.code, 'utf8') / 1000
      if (size > budget) {
        this.error(`${chunk.fileName} exceeds its ${budget} kB chunk budget (${size.toFixed(2)} kB).`)
      }
    }
    chunkBudgetsPassed = true
  },
}

export default defineConfig({
  customLogger: logger,
  plugins: [react(), chunkBudgets],
  define: {
    'import.meta.env.VITE_LAGUN_BULK_WRITE_THRESHOLD': JSON.stringify(
      process.env.VITE_LAGUN_BULK_WRITE_THRESHOLD ?? process.env.LAGUN_BULK_WRITE_THRESHOLD ?? ''
    ),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../lagun/static',
    emptyOutDir: true,
    // Vite's default. The four bundled fonts (3 × JetBrains Mono + the Inter
    // subset, ~330 KB) must be emitted as content-hashed `.woff2` files rather
    // than base64-inlined: at 200_000 they landed inside `index.css`, adding
    // ~441 KB of base64 payload to the render-blocking stylesheet and making
    // the fonts impossible to cache (or revalidate) independently of it.
    assetsInlineLimit: 4096,
    // The lazy AG Grid chunk has an explicit exception, enforced above.
    chunkSizeWarningLimit: DEFAULT_CHUNK_BUDGET_KB,
    rollupOptions: {
      output: {
        // Function form, not the object form: the object form's
        // `'vendor-react': ['react', 'react-dom']` never actually claimed
        // those modules — React was hoisted into vendor-ag-grid /
        // vendor-codemirror and the emitted vendor-react chunk was 1 byte.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
          if (/[\\/]node_modules[\\/]ag-grid-/.test(id)) return 'vendor-ag-grid'
          if (/[\\/]node_modules[\\/](@codemirror|@uiw|@lezer)[\\/]/.test(id)) return 'vendor-codemirror'
          if (/[\\/]node_modules[\\/](lucide-react|clsx)[\\/]/.test(id)) return 'vendor-ui'
          return undefined
        },
      },
    },
  },
})
