// Sync between linked devices. Devices talk to each other directly
// (see lib/link.ts); nothing here stores data anywhere else.
//
// How two devices get in step:
//   1. each sends the other its manifest: for every record, just its id and rev
//   2. each answers with the records the other is missing or has an older rev of
//   3. from then on, every local change is sent to the devices that are online
//
// Conflicts: a record (one page, one task, ...) carries a `rev`. When two devices
// changed the same record, the higher rev wins as a whole; different records never
// conflict. A deletion is a record too (a tombstone), so it wins or loses the same way.
import type { Table } from "dexie";
import { type AppDB, SYNC_TABLES, type SyncTable } from "../db";
import type { Tomb } from "../types";

export interface SyncChange {
  table: SyncTable;
  id: string;
  rev: number;
  /** true: the record was deleted (then `data` is absent) */
  deleted?: boolean;
  /** the whole record. For `files` the contents travel separately, as `blob`. */
  data?: Record<string, unknown>;
  /** attachment contents (files table only) */
  blob?: Blob;
}

/** "<table>:<id>" -> rev, for everything a device has, deletions included. */
export type Manifest = Record<string, number>;

type Row = { id: string; rev?: number; dirty?: 0 | 1 } & Record<string, unknown>;

const keyOf = (table: string, id: string) => table + ":" + id;
const isSyncTable = (t: string): t is SyncTable => (SYNC_TABLES as readonly string[]).includes(t);
const rows = (db: AppDB, name: string) => db.table(name) as Table<Row, string>;

/** Drop tombstones of records that exist again (deleted, then restored from a backup). */
async function dropStaleTombs(db: AppDB) {
  await db.tombsSettled();
  const stale: string[] = [];
  for (const t of await db.tombs.toArray()) {
    if (await db.table(t.table).get(t.id)) stale.push(t.key);
  }
  if (stale.length) await db.tombs.bulkDelete(stale);
}

/** What this device has: every record's rev, without the contents. */
export async function manifestOf(db: AppDB): Promise<Manifest> {
  await dropStaleTombs(db);
  const m: Manifest = {};
  for (const t of await db.tombs.toArray()) m[t.key] = t.rev;
  for (const name of SYNC_TABLES) {
    await rows(db, name).each((r) => {
      m[keyOf(name, r.id)] = r.rev ?? 0;
    });
  }
  return m;
}

function toChange(name: SyncTable, r: Row): SyncChange {
  const { rev, dirty: _dirty, ...data } = r;
  const change: SyncChange = { table: name, id: r.id, rev: rev ?? 0, data };
  if (name === "files") {
    change.blob = data.blob as Blob;
    delete data.blob;
  }
  return change;
}

/** Everything this device has that is missing from, or newer than, the other device's manifest. */
export async function newerThan(db: AppDB, theirs: Manifest): Promise<SyncChange[]> {
  await dropStaleTombs(db);
  const out: SyncChange[] = [];
  const wanted = (key: string, rev: number) => !(key in theirs) || rev > theirs[key];
  for (const name of SYNC_TABLES) {
    await rows(db, name).each((r) => {
      if (wanted(keyOf(name, r.id), r.rev ?? 0)) out.push(toChange(name, r));
    });
  }
  for (const t of await db.tombs.toArray()) {
    if (isSyncTable(t.table) && wanted(t.key, t.rev)) out.push({ table: t.table, id: t.id, rev: t.rev, deleted: true });
  }
  return out;
}

/** Changes made here that have not been sent to any other device yet. */
export async function unsent(db: AppDB): Promise<SyncChange[]> {
  await dropStaleTombs(db);
  const out: SyncChange[] = [];
  for (const name of SYNC_TABLES) {
    for (const r of await rows(db, name).where("dirty").equals(1).toArray()) out.push(toChange(name, r));
  }
  for (const t of await db.tombs.where("dirty").equals(1).toArray()) {
    if (isSyncTable(t.table)) out.push({ table: t.table, id: t.id, rev: t.rev, deleted: true });
  }
  return out;
}

/** Mark changes as sent - unless the record was edited again in the meantime. */
export async function markSent(db: AppDB, sent: SyncChange[]) {
  if (!sent.length) return;
  await db.applyQuietly([...SYNC_TABLES.map((t) => db.table(t)), db.tombs], async () => {
    for (const c of sent) {
      if (c.deleted) {
        await db.tombs.where("key").equals(keyOf(c.table, c.id)).modify((t: Tomb) => {
          if (t.rev === c.rev) t.dirty = 0;
        });
      } else {
        await rows(db, c.table).where("id").equals(c.id).modify((r) => {
          if (r.rev === c.rev) r.dirty = 0;
        });
      }
    }
  });
}

/**
 * Take in changes from another device. Whatever this device already has that is
 * at least as new is kept. Returns how many changes were actually applied.
 */
export async function applyChanges(db: AppDB, changes: SyncChange[]): Promise<number> {
  await db.tombsSettled();
  let applied = 0;
  await db.applyQuietly([...SYNC_TABLES.map((t) => db.table(t)), db.tombs], async () => {
    for (const c of changes) {
      if (!c || !isSyncTable(c.table) || typeof c.id !== "string" || typeof c.rev !== "number") continue;
      const table = rows(db, c.table);
      const local = await table.get(c.id);
      const tomb = await db.tombs.get(keyOf(c.table, c.id));
      if (c.rev <= Math.max(local?.rev ?? -1, tomb?.rev ?? -1)) continue;
      if (c.deleted) {
        if (local) await table.delete(c.id);
        await db.tombs.put({ key: keyOf(c.table, c.id), table: c.table, id: c.id, rev: c.rev, dirty: 0 });
      } else {
        if (!c.data || typeof c.data !== "object") continue;
        const row: Row = { ...c.data, id: c.id, rev: c.rev, dirty: 0 };
        if (c.table === "files") {
          if (!(c.blob instanceof Blob)) continue; // an attachment without its contents is useless
          row.blob = c.blob;
        }
        await table.put(row);
        if (tomb) await db.tombs.delete(tomb.key);
      }
      applied++;
    }
  });
  if (applied) await db.meta.put({ key: "sync:last", value: Date.now() });
  return applied;
}

/** Bring two databases fully in step (what two connected devices do when they meet). */
export async function reconcile(a: AppDB, b: AppDB) {
  const [ma, mb] = [await manifestOf(a), await manifestOf(b)];
  const toB = await newerThan(a, mb);
  const toA = await newerThan(b, ma);
  return { toA: await applyChanges(a, toA), toB: await applyChanges(b, toB) };
}

/** Remove everything from this device, leaving no deletions behind to sync. */
export async function wipeLocal(db: AppDB) {
  await db.tombsSettled();
  const tables = [...SYNC_TABLES.map((t) => db.table(t)), db.tombs, db.history];
  await db.applyQuietly(tables, async () => {
    await Promise.all(tables.map((t) => t.clear()));
  });
}
