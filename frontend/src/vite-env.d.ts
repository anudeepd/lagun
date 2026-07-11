/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LAGUN_BULK_WRITE_THRESHOLD?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
