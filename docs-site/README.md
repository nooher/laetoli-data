# Laetoli Data — documentation site

A polished, **pure-static** docs site for Laetoli Data. No runtime, no server —
deploys to Vercel exactly like `site/` (the landing page). On-brand with the
Tanzania palette (warm sand, deep green, gold; solid fills, no gradients).

## What's here

- `*.html` — the 11 built pages (the deployable output).
- `styles.css` · `docs.js` — shared stylesheet + tiny interactivity (mobile
  drawer, copy buttons, active-link highlight). Zero dependencies.
- `content.js` · `build.js` — the page **source**. Each page's prose/code lives
  in `content.js`; `build.js` wraps it in the shared layout (sidebar / header /
  footer / prev-next) and writes the `.html` files. These two are dev-only and
  are not linked from any page.
- `vercel.json` — static deploy config (`outputDirectory: "."`) + the same
  security headers as the repo-root `vercel.json`.

## Develop

Edit `content.js` (or the layout in `build.js`), then regenerate the pages:

```bash
node build.js        # rebuilds all *.html in place — no npm install needed
```

There is no build toolchain to install; Node (any modern version) is the only
requirement, and only for regenerating HTML. The site itself is plain
HTML/CSS/JS.

## Deploy (Vercel, as a separate project)

Point a Vercel project at this `docs-site/` directory:

- **Framework preset:** Other (no build).
- **Root Directory:** `docs-site`
- **Build Command:** none (leave empty).
- **Output Directory:** `.` (already set in `vercel.json`).

`cleanUrls` is on, so `/auth` serves `auth.html`, etc.

Apache-2.0 · © 2026 Laetoli Ltd · part of the Laetoli sovereign stack.
