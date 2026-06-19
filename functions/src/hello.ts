// Example function: greets the caller. Try:
//   GET  /functions/hello
//   GET  /functions/hello?jina=Asha
// Returns a bare JSON value → 200 application/json.
//
// A function default-exports an async handler `(ctx) => result`. See README.md.

export default async function hello(ctx) {
  const jina = typeof ctx.query.jina === 'string' ? ctx.query.jina : 'Dunia';
  return { message: 'Habari, ' + jina };
}
