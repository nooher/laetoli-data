// =============================================================================
// Daftari — the Laetoli Data worked example (plain Vite + TypeScript, no framework).
// -----------------------------------------------------------------------------
// One small app that exercises the whole sovereign stack through @laetoli/data:
//
//   AUTH      db.auth.signUp / signInWithPassword / signOut / onAuthStateChange
//   CRUD      db.from('daftari_notes').insert / select / update / delete
//   RLS       every read/write is scoped to the signed-in user by the node —
//             the app never sends a user_id; the JWT decides what you can touch.
//   STORAGE   db.storage.from('daftari').upload(...) + createSignedUrl(...)
//   REALTIME  db.channel('daftari_notes').on('*', ...).subscribe() — changes
//             from this tab (or another device) update the list live.
//
// The code is intentionally plain DOM so the teaching is about the SDK, not a
// framework. Each section is labelled to match the book's chapters.
// =============================================================================
import { db, TABLE, BUCKET, type Note } from './db';
import type { RealtimeChange } from '@laetoli/data';

const app = document.querySelector<HTMLDivElement>('#app')!;

// In-memory view of the current user's notes, kept in sync by realtime.
let notes: Note[] = [];
let userId: string | null = null;
let username = '';
let realtimeUp = false;

// ---- tiny DOM helpers --------------------------------------------------------

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c);
  return el;
}

function toast(message: string, kind: 'ok' | 'err' = 'ok'): void {
  const t = h('div', { class: `toast toast-${kind}` }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

// ---- AUTH --------------------------------------------------------------------

async function handleAuth(mode: 'login' | 'signup', form: HTMLFormElement): Promise<void> {
  const data = new FormData(form);
  const creds = {
    username: String(data.get('username') ?? '').trim(),
    password: String(data.get('password') ?? ''),
  };
  if (!creds.username || !creds.password) return toast('Enter a username and password.', 'err');

  const { data: res, error } =
    mode === 'signup'
      ? await db.auth.signUp(creds)
      : await db.auth.signInWithPassword(creds);

  if (error) return toast(error.message, 'err');
  username = creds.username;
  userId = res.user?.id ?? null;
  toast(mode === 'signup' ? `Karibu, ${creds.username}!` : `Habari tena, ${creds.username}!`);
  await afterSignIn();
}

async function signOut(): Promise<void> {
  db.realtime.disconnect();
  realtimeUp = false;
  await db.auth.signOut();
  userId = null;
  username = '';
  notes = [];
  render();
}

// React to auth changes (e.g. token cleared elsewhere) — supabase-parity.
db.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') render();
});

// ---- STORAGE (private bucket + signed URLs) ----------------------------------

/** Ensure the private `daftari` bucket exists. Safe to call repeatedly. */
async function ensureBucket(): Promise<void> {
  const { error } = await db.storage.createBucket(BUCKET, { public: false });
  if (error && !/exist/i.test(error.message)) {
    console.warn('createBucket:', error.message);
  }
}

/** Upload a file under the user's own prefix and return its storage path. */
async function uploadAttachment(file: File): Promise<string | null> {
  // Namespace by user id so each owner's objects are tidy (RLS still gates them).
  const path = `${userId}/${Date.now()}-${file.name}`;
  const { error } = await db.storage.from(BUCKET).upload(path, file, { contentType: file.type });
  if (error) {
    toast(`Upload failed: ${error.message}`, 'err');
    return null;
  }
  return path;
}

/** Mint a short-lived signed URL for a private object so an <img> can load it. */
async function signedUrlFor(path: string): Promise<string | null> {
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, 300); // 5 min
  if (error || !data) return null;
  // The signed URL is relative to the storage service; resolve against the node.
  return new URL(data.signedUrl, import.meta.env.VITE_LAETOLI_DATA_URL ?? location.origin).href;
}

// ---- CRUD (RLS-scoped) -------------------------------------------------------

async function loadNotes(): Promise<void> {
  const { data, error } = await db
    .from<Note[]>(TABLE)
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return toast(`Load failed: ${error.message}`, 'err');
  notes = data ?? [];
  render();
}

async function createNote(title: string, body: string, file: File | null): Promise<void> {
  let attachment_path: string | null = null;
  if (file) attachment_path = await uploadAttachment(file);

  // No user_id is sent — the node defaults it to auth.uid() from the JWT.
  const { error } = await db.from(TABLE).insert({ title, body, attachment_path }).select().single();
  if (error) return toast(`Create failed: ${error.message}`, 'err');
  toast('Note saved.');
  // Realtime will push the INSERT; reload as a fallback when it is not wired.
  if (!realtimeUp) await loadNotes();
}

async function toggleDone(note: Note): Promise<void> {
  const { error } = await db.from(TABLE).update({ done: !note.done }).eq('id', note.id);
  if (error) return toast(`Update failed: ${error.message}`, 'err');
  if (!realtimeUp) await loadNotes();
}

async function deleteNote(note: Note): Promise<void> {
  const { error } = await db.from(TABLE).delete().eq('id', note.id);
  if (error) return toast(`Delete failed: ${error.message}`, 'err');
  if (note.attachment_path) await db.storage.from(BUCKET).remove([note.attachment_path]);
  if (!realtimeUp) await loadNotes();
}

// ---- REALTIME ----------------------------------------------------------------

/**
 * Subscribe to row changes for THIS user's notes. The node's fan-out is
 * owner-aware (the table has a user_id column), so the stream already only
 * carries our rows — the optional filter is belt-and-braces.
 */
function startRealtime(): void {
  if (realtimeUp || !userId) return;
  db.channel(TABLE)
    .on('*', (change: RealtimeChange) => applyChange(change), { column: 'user_id', value: userId })
    .subscribe();
  realtimeUp = true;
  render(); // reflect the "live" badge
}

/** Merge a realtime change into the in-memory list, then re-render. */
function applyChange(change: RealtimeChange): void {
  if (change.truncated) {
    // Heavy payload was dropped at the NOTIFY cap — re-fetch authoritatively.
    void loadNotes();
    return;
  }
  if (change.event === 'DELETE') {
    const id = (change.old as Note | null)?.id;
    notes = notes.filter((n) => n.id !== id);
  } else {
    const row = change.record as Note | null;
    if (row) {
      const i = notes.findIndex((n) => n.id === row.id);
      if (i >= 0) notes[i] = row;
      else notes.unshift(row);
    }
  }
  render();
}

// ---- lifecycle after a successful sign-in ------------------------------------

async function afterSignIn(): Promise<void> {
  const { data } = await db.auth.getUser();
  if (data.user) {
    userId = data.user.id;
    username = (data.user as { username?: string }).username ?? username;
  }
  await ensureBucket();
  await loadNotes();
  startRealtime();
}

// ---- views -------------------------------------------------------------------

function authView(): HTMLElement {
  const form = h('form', { class: 'card auth' });
  form.append(
    h('h1', {}, 'Daftari'),
    h('p', { class: 'muted' }, 'Notes you own, on a node you own. — Laetoli Data'),
    labeledInput('username', 'Username', 'text'),
    labeledInput('password', 'Password', 'password'),
    h('div', { class: 'row' },
      button('Sign in', 'primary', (e) => { e.preventDefault(); void handleAuth('login', form); }),
      button('Create account', 'ghost', (e) => { e.preventDefault(); void handleAuth('signup', form); }),
    ),
    h('p', { class: 'hint' }, 'New here? Create an account — it lives in YOUR node’s auth.users.'),
  );
  return form;
}

function appView(): HTMLElement {
  const wrap = h('div', { class: 'shell' });

  // Header
  wrap.append(
    h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, 'Daftari',
        realtimeUp ? h('span', { class: 'live' }, '● live') : h('span', { class: 'live off' }, '○ offline')),
      h('div', { class: 'who' },
        h('span', { class: 'muted' }, username ? `@${username}` : 'signed in'),
        button('Sign out', 'ghost', () => void signOut())),
    ),
  );

  // New-note composer
  const form = h('form', { class: 'card composer' });
  const file = h('input', { type: 'file', name: 'file', accept: 'image/*' }) as HTMLInputElement;
  form.append(
    labeledInput('title', 'Title', 'text'),
    labeledTextarea('body', 'Note'),
    h('label', { class: 'field' }, h('span', {}, 'Attachment (optional image)'), file),
    button('Add note', 'primary', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const title = String(fd.get('title') ?? '').trim();
      const body = String(fd.get('body') ?? '').trim();
      if (!title && !body) return toast('Write something first.', 'err');
      void createNote(title, body, file.files?.[0] ?? null).then(() => form.reset());
    }),
  );
  wrap.append(form);

  // List
  const list = h('div', { class: 'list' });
  if (notes.length === 0) {
    list.append(h('p', { class: 'empty muted' }, 'No notes yet. Add one above — or run the seed script.'));
  }
  for (const note of notes) list.append(noteCard(note));
  wrap.append(list);

  return wrap;
}

function noteCard(note: Note): HTMLElement {
  const card = h('article', { class: `card note ${note.done ? 'done' : ''}` });
  card.append(
    h('div', { class: 'note-head' },
      h('strong', {}, note.title || '(untitled)'),
      h('span', { class: 'when muted' }, new Date(note.created_at).toLocaleString())),
  );
  if (note.body) card.append(h('p', {}, note.body));

  if (note.attachment_path) {
    const img = h('img', { class: 'thumb', alt: 'attachment' }) as HTMLImageElement;
    // Private object → resolve a fresh signed URL on demand.
    void signedUrlFor(note.attachment_path).then((url) => { if (url) img.src = url; });
    card.append(img);
  }

  card.append(
    h('div', { class: 'row' },
      button(note.done ? 'Mark undone' : 'Mark done', 'ghost', () => void toggleDone(note)),
      button('Delete', 'danger', () => void deleteNote(note))),
  );
  return card;
}

// ---- small UI primitives -----------------------------------------------------

function labeledInput(name: string, label: string, type: string): HTMLElement {
  const input = h('input', { type, name, autocomplete: 'off' });
  return h('label', { class: 'field' }, h('span', {}, label), input);
}

function labeledTextarea(name: string, label: string): HTMLElement {
  const ta = h('textarea', { name, rows: '3' });
  return h('label', { class: 'field' }, h('span', {}, label), ta);
}

function button(
  label: string,
  variant: 'primary' | 'ghost' | 'danger',
  onClick: (e: MouseEvent) => void,
): HTMLButtonElement {
  const b = h('button', { class: `btn ${variant}`, type: 'button' }, label);
  b.addEventListener('click', onClick as EventListener);
  return b;
}

// ---- render ------------------------------------------------------------------

function render(): void {
  app.replaceChildren(userId ? appView() : authView());
}

// On load: if a token was persisted (returning user), resume the session.
async function boot(): Promise<void> {
  const { data } = await db.auth.getUser();
  if (data.user) {
    userId = data.user.id;
    username = (data.user as { username?: string }).username ?? '';
    await afterSignIn();
  } else {
    render();
  }
}

void boot();
