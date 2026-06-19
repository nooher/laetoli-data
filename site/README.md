# Laetoli Data — landing site

Zero-build static site for **Laetoli Data**. No framework, no bundler — just
`index.html`, `styles.css`, and a tiny `main.js` (copy-to-clipboard only; the
site works fully without JS).

## Files
- `index.html` — the page (Kiswahili-first, English secondary).
- `styles.css` — Tanzania-tasteful palette, solid fills only (no gradients).
- `main.js` — progressive enhancement: copy buttons on code blocks.
- `vercel.json` — clean URLs + basic security headers.

The only external runtime dependency is a single Google Fonts `<link>`
(Fraunces / Inter / JetBrains Mono). Remove it to fall back to system fonts.

## Deploy (static — no build step)

**Vercel** — set the project **Root Directory** to `site/`, framework preset
**Other**, leave the build command empty (output is the directory itself).

**Netlify** — publish directory `site/`, no build command.

**Caddy** (e.g. on the same VPS as the backend):
```
data-site.example.tz {
    root * /srv/laetoli-data/site
    file_server
    encode zstd gzip
}
```

**Any static host / local preview:**
```bash
cd site
python3 -m http.server 8000   # or: npx serve .
```
