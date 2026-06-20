// db.ts — the one place the app creates its Laetoli Data client.
//
// This is the whole "point the SDK at your node" step: read the endpoint from
// the Vite env and hand it to createClient(). Every other module imports `db`
// and uses it the way a real app would — no special test harness.
import { createClient } from '@laetoli/data';

const URL = import.meta.env.VITE_LAETOLI_DATA_URL ?? 'http://localhost:8088';
const ANON = import.meta.env.VITE_LAETOLI_ANON_KEY || undefined;

export const db = createClient(URL, ANON ? { apikey: ANON } : undefined);

/** The table + bucket this example owns. */
export const TABLE = 'daftari_notes';
export const BUCKET = 'daftari';

/** A Daftari note row, matching examples/daftari/schema.sql. */
export interface Note {
  id: string;
  user_id: string;
  title: string;
  body: string;
  done: boolean;
  attachment_path: string | null;
  created_at: string;
  updated_at: string;
}
