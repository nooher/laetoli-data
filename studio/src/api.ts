// Typed admin-API client. ALL network logic lives here — components never fetch.
//
// Auth: the operator pastes the ADMIN_API_KEY ("service role key") on the Login
// screen. We keep it (and the base URL) in sessionStorage — more ephemeral than
// localStorage, so closing the tab signs out — and send it as
//   Authorization: Bearer <key>
// on every admin request. `/health` is the only unauthenticated endpoint.

import { joinUrl, normalizeBaseUrl } from './lib';
import type {
  ApiKey,
  ApiKeyRole,
  AuthUsersResponse,
  Bucket,
  CreatedApiKey,
  HealthResponse,
  PoliciesResponse,
  Project,
  Role,
  SchemaResponse,
  SqlResult,
  Stats,
  StorageObject,
  TableRows,
  UsageResponse,
} from './types';

const KEY_STORAGE = 'laetoli.studio.adminKey';
const BASE_STORAGE = 'laetoli.studio.baseUrl';

export interface Credentials {
  baseUrl: string; // normalized
  key: string;
}

/** Read persisted credentials from sessionStorage, or null when signed out. */
export function loadCredentials(): Credentials | null {
  try {
    const key = sessionStorage.getItem(KEY_STORAGE);
    if (!key) return null;
    const baseUrl = normalizeBaseUrl(sessionStorage.getItem(BASE_STORAGE));
    return { key, baseUrl };
  } catch {
    return null;
  }
}

export function saveCredentials(c: Credentials): void {
  sessionStorage.setItem(KEY_STORAGE, c.key);
  sessionStorage.setItem(BASE_STORAGE, c.baseUrl);
}

export function clearCredentials(): void {
  sessionStorage.removeItem(KEY_STORAGE);
  sessionStorage.removeItem(BASE_STORAGE);
}

/** Build-time default base; falls back to same-origin '/admin' (preferred). */
export function defaultBaseUrl(): string {
  const fromEnv = import.meta.env?.VITE_ADMIN_API_BASE as string | undefined;
  return normalizeBaseUrl(fromEnv || '/admin');
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class AdminApi {
  constructor(private readonly creds: Credentials) {}

  private async request<T>(
    path: string,
    init: RequestInit = {},
    auth = true,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (init.body) headers.set('Content-Type', 'application/json');
    if (auth) headers.set('Authorization', `Bearer ${this.creds.key}`);

    let res: Response;
    try {
      res = await fetch(joinUrl(this.creds.baseUrl, path), { ...init, headers });
    } catch (e) {
      throw new ApiError(
        `Cannot reach the admin API at ${this.creds.baseUrl}. Is the backend running?`,
        0,
        e instanceof Error ? e.message : String(e),
      );
    }

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new ApiError('Unauthorized — the admin key was rejected.', res.status);
      }
      const msg =
        (body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : null) ??
        (body && typeof body === 'object' && 'message' in body
          ? String((body as { message: unknown }).message)
          : null) ??
        (typeof body === 'string' && body ? body : `Request failed (${res.status})`);
      throw new ApiError(msg, res.status);
    }

    return body as T;
  }

  // ---- endpoints ----
  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health', {}, false);
  }

  /** A keyed call used to validate the admin key during login. */
  stats(): Promise<Stats> {
    return this.request<Stats>('/stats');
  }

  schema(): Promise<SchemaResponse> {
    return this.request<SchemaResponse>('/schema');
  }

  tableRows(
    schema: string,
    name: string,
    opts: { limit?: number; offset?: number; order?: string } = {},
  ): Promise<TableRows> {
    const q = new URLSearchParams();
    if (opts.limit != null) q.set('limit', String(opts.limit));
    if (opts.offset != null) q.set('offset', String(opts.offset));
    if (opts.order) q.set('order', opts.order);
    const qs = q.toString();
    return this.request<TableRows>(
      `/table/${enc(schema)}/${enc(name)}${qs ? `?${qs}` : ''}`,
    );
  }

  insertRow(schema: string, name: string, values: Record<string, unknown>) {
    return this.request<unknown>(`/table/${enc(schema)}/${enc(name)}`, {
      method: 'POST',
      body: JSON.stringify(values),
    });
  }

  updateRow(
    schema: string,
    name: string,
    where: Record<string, unknown>,
    set: Record<string, unknown>,
  ) {
    return this.request<unknown>(`/table/${enc(schema)}/${enc(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ where, set }),
    });
  }

  deleteRow(schema: string, name: string, where: Record<string, unknown>) {
    return this.request<unknown>(`/table/${enc(schema)}/${enc(name)}`, {
      method: 'DELETE',
      body: JSON.stringify({ where }),
    });
  }

  sql(query: string): Promise<SqlResult> {
    return this.request<SqlResult>('/sql', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
  }

  policies(): Promise<PoliciesResponse> {
    return this.request<PoliciesResponse>('/policies');
  }

  roles(): Promise<{ roles: Role[] }> {
    return this.request<{ roles: Role[] }>('/roles');
  }

  authUsers(opts: { limit?: number; offset?: number } = {}): Promise<AuthUsersResponse> {
    const q = new URLSearchParams();
    if (opts.limit != null) q.set('limit', String(opts.limit));
    if (opts.offset != null) q.set('offset', String(opts.offset));
    const qs = q.toString();
    return this.request<AuthUsersResponse>(`/auth/users${qs ? `?${qs}` : ''}`);
  }

  deleteAuthUser(id: string) {
    return this.request<unknown>(`/auth/users/${enc(id)}`, { method: 'DELETE' });
  }

  storageBuckets(): Promise<{ buckets: Bucket[] }> {
    return this.request<{ buckets: Bucket[] }>('/storage/buckets');
  }

  storageObjects(
    bucket: string,
    opts: { limit?: number } = {},
  ): Promise<{ objects: StorageObject[] }> {
    const q = new URLSearchParams();
    q.set('bucket', bucket);
    if (opts.limit != null) q.set('limit', String(opts.limit));
    return this.request<{ objects: StorageObject[] }>(`/storage/objects?${q.toString()}`);
  }

  // ---- API keys & projects ----
  projects(): Promise<Project[]> {
    return this.request<Project[]>('/projects');
  }

  createProject(name: string): Promise<Project> {
    return this.request<Project>('/projects', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
  }

  deleteProject(id: string) {
    return this.request<unknown>(`/projects/${enc(id)}`, { method: 'DELETE' });
  }

  projectKeys(projectId: string): Promise<ApiKey[]> {
    return this.request<ApiKey[]>(`/projects/${enc(projectId)}/keys`);
  }

  createKey(
    projectId: string,
    body: { name: string; role: ApiKeyRole; rate_limit_per_min?: number },
  ): Promise<CreatedApiKey> {
    return this.request<CreatedApiKey>(`/projects/${enc(projectId)}/keys`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  revokeKey(id: string) {
    return this.request<unknown>(`/keys/${enc(id)}`, { method: 'DELETE' });
  }

  usage(projectId: string): Promise<UsageResponse> {
    const q = new URLSearchParams();
    q.set('project_id', projectId);
    return this.request<UsageResponse>(`/usage?${q.toString()}`);
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

/**
 * Validate credentials by probing /health (unauthenticated) and then a keyed
 * call (/stats). Resolves to true on success; throws ApiError otherwise.
 */
export async function validateCredentials(creds: Credentials): Promise<void> {
  const api = new AdminApi(creds);
  await api.health();
  await api.stats();
}
