import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
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
    // Vite's default. The previous 1200 sat just above the ~1.15 MB AG Grid
    // chunk, so the warning was structurally unable to fire. AG Grid is the
    // one chunk intentionally over budget; the warning is the reminder.
    chunkSizeWarningLimit: 500,
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
