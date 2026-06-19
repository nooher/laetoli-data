// Types mirroring the Laetoli Data admin API contract.

export interface HealthResponse {
  status?: string;
  [key: string]: unknown;
}

export interface Column {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  is_pk: boolean;
}

export interface TableInfo {
  name: string;
  kind?: 'table' | 'view' | string;
  columns: Column[];
}

export interface SchemaInfo {
  name: string;
  tables: TableInfo[];
}

export interface SchemaResponse {
  schemas: SchemaInfo[];
}

export type Row = Record<string, unknown>;

export interface TableRows {
  rows: Row[];
  count: number;
}

export interface SqlResult {
  rows: Row[];
  rowCount: number;
  fields: string[];
}

export interface Policy {
  schema: string;
  table: string;
  name: string;
  command: string; // ALL | SELECT | INSERT | UPDATE | DELETE
  roles: string[];
  using: string | null;
  with_check: string | null;
  permissive?: boolean;
}

export interface PoliciesResponse {
  policies: Policy[];
  rls_enabled?: { schema: string; table: string; enabled: boolean }[];
}

export interface Role {
  name: string;
  can_login?: boolean;
  is_superuser?: boolean;
  member_of?: string[];
}

export interface AuthUser {
  id: string;
  username?: string | null;
  role?: string | null;
  is_anonymous?: boolean;
  created_at?: string | null;
  last_sign_in_at?: string | null;
  [key: string]: unknown;
}

export interface AuthUsersResponse {
  users: AuthUser[];
  count?: number;
}

export interface Bucket {
  id?: string;
  name: string;
  public?: boolean;
  created_at?: string | null;
  object_count?: number;
}

export interface StorageObject {
  path: string;
  name?: string;
  size?: number | null;
  mime?: string | null;
  mime_type?: string | null;
  owner?: string | null;
  created_at?: string | null;
}

export interface Stats {
  users: number;
  tables: number;
  buckets: number;
  objects: number;
  db_size_pretty: string;
}

export type ScreenId =
  | 'dashboard'
  | 'tables'
  | 'sql'
  | 'auth'
  | 'storage'
  | 'policies';
