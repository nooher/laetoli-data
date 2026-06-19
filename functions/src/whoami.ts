// Example function: returns the authenticated user, or 401 if anonymous.
// Demonstrates ctx.user (populated from a valid `Authorization: Bearer <jwt>`
// when JWT_SECRET is configured) and a Response-like `{ status, body }`.
//
//   GET /functions/whoami                      -> 401
//   GET /functions/whoami  (with Bearer token) -> 200 { sub, role }

export default async function whoami(ctx) {
  if (!ctx.user) {
    return { status: 401, body: { error: 'Hujaingia. (Not authenticated.)' } };
  }
  return ctx.user;
}
