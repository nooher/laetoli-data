// =============================================================================
// examples/daftari/seed.mjs — seed Daftari with a demo user + a few notes.
// -----------------------------------------------------------------------------
// Uses the @laetoli/data SDK exactly as the app does: sign in (or sign up) a
// demo user, ensure the private `daftari` storage bucket exists, then insert a
// handful of notes. Because inserts run under the demo user's JWT, RLS stamps
// each row's user_id with that user automatically.
//
// Run AFTER applying examples/daftari/schema.sql to your node:
//   LAETOLI_DATA_URL=http://localhost:8088 node examples/daftari/seed.mjs
//
// Env (all optional, sensible local defaults):
//   LAETOLI_DATA_URL   node base URL          (default http://localhost:8088)
//   LAETOLI_ANON_KEY   anon apikey, if your node requires one
//   DAFTARI_USER       demo username          (default daftari_demo)
//   DAFTARI_PASS       demo password          (default Habari123!)
// =============================================================================
import { createClient } from '../../client/dist/index.js';

const URL = process.env.LAETOLI_DATA_URL ?? 'http://localhost:8088';
const ANON = process.env.LAETOLI_ANON_KEY || undefined;
const USERNAME = process.env.DAFTARI_USER ?? 'daftari_demo';
const PASSWORD = process.env.DAFTARI_PASS ?? 'Habari123!';

const db = createClient(URL, ANON ? { apikey: ANON } : undefined);

const ok = (label) => console.log('  ✓', label);
const die = (label, err) => {
  console.error('  ✗', label, '—', JSON.stringify(err));
  process.exit(1);
};

console.log(`Daftari seed → ${URL} (user: ${USERNAME})`);

// 1) Sign in if the demo user exists, else sign up.
let auth = await db.auth.signInWithPassword({ username: USERNAME, password: PASSWORD });
if (auth.error) {
  auth = await db.auth.signUp({ username: USERNAME, password: PASSWORD });
  if (auth.error) die('auth', auth.error);
  ok(`signed up ${USERNAME}`);
} else {
  ok(`signed in ${USERNAME}`);
}

// 2) Ensure the private `daftari` storage bucket exists (idempotent-ish:
//    treat an "already exists" failure as success).
const bucket = await db.storage.createBucket('daftari', { public: false });
if (bucket.error && !/exist/i.test(bucket.error.message)) {
  console.warn('  ! could not create bucket (may already exist):', bucket.error.message);
} else {
  ok('private bucket "daftari" ready');
}

// 3) Insert a few notes. RLS sets user_id = auth.uid() from the bearer token,
//    so we never pass an owner — the node derives it from the verified JWT.
const seeds = [
  { title: 'Karibu Daftari', body: 'Notes you own, on a node you own.', done: false },
  { title: 'Nunua maziwa', body: 'Soko la Kariakoo — lita mbili.', done: false },
  { title: 'Soma sura ya 4', body: 'Laetoli Data: RLS + realtime.', done: true },
];

for (const note of seeds) {
  const { data, error } = await db.from('daftari_notes').insert(note).select('id,title').single();
  if (error) die(`insert "${note.title}"`, error);
  ok(`note ${data.id.slice(0, 8)}… "${data.title}"`);
}

// 4) Read them back — RLS returns ONLY this user's rows.
const mine = await db.from('daftari_notes').select('id,title,done').order('created_at', { ascending: false });
if (mine.error) die('read back', mine.error);
ok(`read back ${mine.data.length} note(s) (RLS-scoped to ${USERNAME})`);

await db.auth.signOut();
console.log('\nDone. Run the app (npm run dev) and sign in as the same user to see them.');
