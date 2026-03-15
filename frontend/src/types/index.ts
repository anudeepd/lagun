export interface Session {
  id: string
  name: string
  host: string
  port: number
  username: string
  default_db: string | null
  query_limit: number
  ssl_enabled: boolean
  selected_databases: string[]
  created_at: string
  updated_at: string
}

export interface SessionCreate {
  name: string
  host: string
  port: number
  username: string
  password: string
  default_db?: string
  query_limit: number
  ssl_enabled: boolean
  selected_databases?: string[]
}

export interface SessionUpdate extends Partial<SessionCreate> {}

export interface TestResult {
  ok: boolean
  server_version?: string
  latency_ms?: number
  databases?: string[]
  error?: string
}

export interface ProbeRequest {
  host: string
  port: number
  username: string
  password: string
  ssl_enabled?: boolean
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  row_count: number
  exec_time_ms: number
  error?: string
  affected_rows?: number
  insert_id?: number
}

export interface ColumnInfo {
  name: string
  data_type: string
  column_type: string
  is_nullable: boolean
  column_default: string | null
  is_primary_key: boolean
  is_auto_increment: boolean
  extra: string
  comment: string
}

export interface IndexInfo {
  name: string
  columns: string[]
  is_unique: boolean
  index_type: string
}

export interface TableInfo {
  name: string
  table_type: string
  engine: string | null
  row_count: number | null
  data_length: number | null
  comment: string
}

export type TabType = 'query' | 'table'

export interface Tab {
  id: string
  label: string
  type: TabType
  sessionId: string
  database?: string
  table?: string
  sql?: string
}
