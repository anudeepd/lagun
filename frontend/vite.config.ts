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
    assetsInlineLimit: 200_000,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-ag-grid': ['ag-grid-react', 'ag-grid-community'],
          'vendor-codemirror': [
            '@codemirror/lang-sql',
            '@codemirror/theme-one-dark',
            '@uiw/react-codemirror',
          ],
          'vendor-react': ['react', 'react-dom'],
          'vendor-ui': ['lucide-react', 'clsx'],
        },
      },
    },
  },
})
