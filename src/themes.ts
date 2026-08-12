import type { Database } from 'bun:sqlite';
import { db as appDb } from './db.ts';

const THEME_PALETTE = ['#fe7141','#cdabfe','#d1ddd3','#75c9c8','#f4bf58','#ef8fb1','#8eacef','#b8d65f','#d89b72','#87c77b','#e58b72','#9c8de3','#64b5d2','#d6a45f','#a7c4e8','#c69acb'];

function slug(value: string) { return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80); }
function mapTheme(row: Record<string, unknown>) { return { id: String(row.id), name: String(row.name), description: String(row.description), colour: String(row.colour), source: String(row.source) }; }

export function listThemes(database: Database = appDb) {
  return (database.query('SELECT * FROM themes ORDER BY name COLLATE NOCASE').all() as Record<string, unknown>[]).map(mapTheme);
}

export function getTheme(id: string, database: Database = appDb) {
  const row = database.query('SELECT * FROM themes WHERE id=?1').get(id) as Record<string, unknown> | null;
  return row ? mapTheme(row) : null;
}

export function createTheme(input: { name: string; description: string }, database: Database = appDb) {
  const base = slug(input.name); if (!base) throw new Error('Theme name cannot produce a stable id');
  const existing = listThemes(database).find((item) => item.id === base || item.name.toLowerCase() === input.name.trim().toLowerCase());
  if (existing) return existing;
  let id = base; let suffix = 2; while (getTheme(id, database)) id = `${base}-${suffix++}`;
  const count = Number((database.query('SELECT COUNT(*) AS count FROM themes').get() as { count: number }).count);
  const now = Date.now();
  database.query("INSERT INTO themes(id,name,description,colour,source,created_at,updated_at) VALUES(?1,?2,?3,?4,'studio',?5,?5)")
    .run(id, input.name.trim(), input.description.trim(), THEME_PALETTE[count % THEME_PALETTE.length], now);
  return getTheme(id, database)!;
}
