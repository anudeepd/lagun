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
  managed?: boolean
  is_default?: boolean
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

export interface QueryTimings {
  pool_wait_ms: number
  setup_ms: number
  execute_ms: number
  fetch_ms: number
  value_serialize_ms: number
  total_ms: number
  metadata_ms?: number | null
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  row_count: number
  exec_time_ms: number
  error?: string
  affected_rows?: number
  insert_id?: number
  execution_id?: string | null
  timings?: QueryTimings | null
}

export interface ScriptQueryError {
  code: string
  problem: string
  cause: string
  fix: string
  docs_url: string
}

export interface ScriptQueryResult {
  ok: boolean
  execution_id: string
  statements_executed: number
  affected_rows: number
  exec_time_ms: number
  failed_statement_index?: number | null
  failed_statement_preview?: string | null
  rolled_back: boolean
  error?: ScriptQueryError | null
}

export interface ScriptQueryValidationResult {
  ok: boolean
  statement_count: number
  operation_counts: Record<string, number>
  rejected_statement_index?: number | null
  rejected_statement_preview?: string | null
  error?: ScriptQueryError | null
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

export interface ColumnDef {
  name: string
  type: string
  nullable: boolean
  primary_key: boolean
  auto_increment: boolean
  default?: string
}

export interface CreateTableRequest {
  name: string
  columns: ColumnDef[]
  engine: string
  charset: string
  collation: string
}

export interface CreateIndexRequest {
  name: string
  columns: string[]
  is_unique: boolean
  index_type: string
}

export type TabType = 'query' | 'table'

export interface DataTabState {
  view?: 'schema' | 'data'
  globalSearch?: string
  whereFilter?: string
  appliedWhere?: string
  showFilterBar?: boolean
  limit?: number
}

export interface Tab {
  id: string
  label: string
  type: TabType
  sessionId: string
  database?: string
  table?: string
  sql?: string
  dataState?: DataTabState
  dirty?: boolean
}


export interface AdminOverview {
  connection_count: number
  managed_connection_count: number
  private_connection_count: number
  audit_event_count: number
  audit_user_count: number
  live_user_count: number
  active_query_count: number
  window_hours: number
  observed_at: number
}

export interface AdminConnection {
  id: string
  name: string
  host: string
  port: number
  username: string
  default_db: string | null
  query_limit: number
  ssl_enabled: boolean
  created_at: string
  updated_at: string
  selected_databases: string[]
  managed: boolean
  is_default: boolean
  owner_username: string | null
  config_key: string | null
  shared_user_count: number
}

export interface AdminConnectionsResponse {
  items: AdminConnection[]
  observed_at: number
}

export interface AdminUser {
  username: string
  active_clients: number
  active_tabs: number
  policy_state: 'allowed' | 'observed'
}

export interface AdminUsersResponse {
  items: AdminUser[]
  fingerprint: string
  observed_at: number
}
export interface AdminQuery {
  session_id: string
  execution_id: string
  username: string
  session_name?: string
  host?: string
  port?: number
  database: string | null
  tab_id: string | null
  sql: string
  started_at: string
  elapsed_ms: number
  state: 'queued' | 'running'
  kind: 'query' | 'bulk'
}

export interface AdminQueriesResponse {
  items: AdminQuery[]
  observed_at: number
}

export interface PresenceTab {
  id: string
  type: string
  label: string
  session_id: string
  database: string | null
  table: string | null
}

export interface AdminPresence {
  username: string
  client_id: string
  active_tab_id: string | null
  tabs: PresenceTab[]
  seen_at: string
  age_seconds: number
}

export interface AdminPresenceResponse {
  items: AdminPresence[]
  stale_after_seconds: number
  observed_at: number
}

export interface PresenceUpdate {
  client_id: string
  active_tab_id: string | null
  tabs: PresenceTab[]
}

export interface AdminActivityEvent {
  occurred_at: string
  username: string
  method: string
  path: string
  session_id: string | null
  details: string | null
  status_code: number
  duration_ms: number
}

export interface AdminActivityFilters {
  username?: string
  path?: string
  since?: string
  statusCode?: number
}

export interface AdminActivityResponse {
  items: AdminActivityEvent[]
  observed_at: number
}

export interface AdminRetention {
  older_than_days: number
  minimum_age_days: number
  eligible_count: number
  observed_at: number
}