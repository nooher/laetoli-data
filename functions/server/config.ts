// Configuration loaded from environment. Mirrors auth/storage config style so
// every Laetoli Data service shares the same JWT_SECRET + conventions.
//
// JWT_SECRET is OPTIONAL here: functions don't require auth (each function
// decides). If JWT_SECRET is set, a valid Bearer token populates ctx.user;
// if absent, ctx.user is always null. We still warn loudly so an operator who
// meant to enable auth isn't surprised.

export interface FunctionsConfig {
  /** Shared HS256 secret — same value as auth/PostgREST. May be undefined. */
  jwtSecret?: string;
  port: number;
  /** Directory under which function modules live (the "functions root"). */
  functionsRoot: string;
  /** Per-invocation timeout (ms); the runner aborts + returns 504 past this. */
  timeoutMs: number;
  /** Max JSON request body size accepted by express. */
  bodyLimit: string;
  /** When true, never leak error messages/stacks to the client. */
  production: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): FunctionsConfig {
  const jwtSecret = env.JWT_SECRET && env.JWT_SECRET.trim().length > 0 ? env.JWT_SECRET : undefined;
  if (jwtSecret && jwtSecret.length < 32) {
    throw new Error(
      'FATAL: JWT_SECRET ni fupi mno (inahitaji angalau herufi 32). ' +
        '(JWT_SECRET, if set, must be at least 32 characters and match the auth service.)'
    );
  }

  const port = Number.parseInt(env.FUNCTIONS_PORT ?? env.PORT ?? '9995', 10);

  const timeoutMs = Number.parseInt(env.FUNCTION_TIMEOUT_MS ?? '10000', 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('FATAL: FUNCTION_TIMEOUT_MS si sahihi (lazima iwe milisekunde chanya).');
  }

  return {
    jwtSecret,
    port,
    functionsRoot: env.FUNCTIONS_ROOT ?? '/functions',
    timeoutMs,
    bodyLimit: env.FUNCTIONS_BODY_LIMIT ?? '1mb',
    production: (env.NODE_ENV ?? '') === 'production',
  };
}
