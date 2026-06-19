// poc.mjs — proves the @laetoli/data SDK works against a LIVE Laetoli Data stack.
// Run the stack first (docker compose up -d), then: node examples/poc.mjs
// Uses the built client at ../client/dist/index.js (browser-grade fetch + in-mem
// token store in Node). This is the end-to-end "drop-in" proof.
import { createClient } from '../client/dist/index.js';

const URL = process.env.LAETOLI_DATA_URL ?? 'http://localhost:8088';
const db = createClient(URL);
const user = 'poc_' + Math.floor(Math.random() * 1e9);
const log = (label, v) => console.log(label, JSON.stringify(v));

// 1) sign up (sovereign auth → JWT, auto-stored + attached to requests)
const su = await db.auth.signUp({ username: user, password: 'Habari123!' });
if (su.error) throw new Error('signUp: ' + JSON.stringify(su.error));
log('1) signUp user:', su.data?.user?.id ?? su.data);

// 2) insert a note (RLS sets user_id = auth.uid() from the bearer)
const ins = await db.from('notes').insert({ body: 'PoC kupitia @laetoli/data SDK' }).select().single();
if (ins.error) throw new Error('insert: ' + JSON.stringify(ins.error));
log('2) inserted:', ins.data);

// 3) read my notes (bearer attached automatically → RLS returns only mine)
const mine = await db.from('notes').select('id,body');
log('3) my rows:', mine.data);

// 4) sign out, then read again with no token → RLS protects (no rows / blocked)
await db.auth.signOut();
const anon = await db.from('notes').select('id,body');
log('4) after signOut:', anon.error ? { blocked: anon.status } : anon.data);

console.log('\n*** @laetoli/data SDK works against the live sovereign backend ***');
