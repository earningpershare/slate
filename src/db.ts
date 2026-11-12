import Dexie, { type Table, type Transaction } from "dexie";
import type {
  DbView,
  FocusSession,
  Habit,
  Page,
  Property,
  PropValue,
  Snapshot,
  StoredFile,
  Task,
  TaskList,
  Tomb,
} from "./types";
import {
  blocksToText,
  guessType,
  linkedPageIds,
  nextDue,
  parseCsv,
  safeBlobType,
  sortBetween,
  uid,
} from "./lib/logic";

/** Tables whose records travel between devices. History and meta stay local. */
export const SYNC_TABLES = ["pages", "tasks", "lists", "focus", "habits", "files"] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];

/** Transactions that apply changes coming from elsewhere: they must not be re-marked as local edits. */
const quiet = new WeakSet<Transaction>();

/** A rev later than `prev`. The random fraction makes two devices picking the same value practically impossible. */
export const nextRev = (prev = 0) => Math.max(Date.now(), Math.floor(prev) + 1) + Math.random();

export class AppDB extends Dexie {
  pages!: Table<Page, string>;
  tasks!: Table<Task, string>;
  lists!: Table<TaskList, string>;
  focus!: Table<FocusSession, string>;
  habits!: Table<Habit, string>;
  files!: Table<StoredFile, string>;
  history!: Table<Snapshot, string>;
  /** small key/value store for things that are not user content (e.g. the backup folder handle) */
  meta!: Table<{ key: string; value: unknown }, string>;
  /** deletions waiting to be passed on to other devices */
  tombs!: Table<Tomb, string>;
  private tombWrites: Promise<unknown> = Promise.resolve();

  constructor(name = "slate-workspace") {
    super(name);
    this.version(1).stores({
      pages: "id, parentId, updatedAt",
      tasks: "id, listId, parentId, due",
      lists: "id",
      focus: "id, taskId, start",
      habits: "id",
      files: "id",
    });
    this.version(2).stores({ history: "id, pageId, at" });
    this.version(3).stores({ meta: "key" });
    // v4: change tracking for sync. Everything that already exists counts as not yet uploaded.
    this.version(4)
      .stores({
        pages: "id, parentId, updatedAt, dirty",
        tasks: "id, listId, parentId, due, dirty",
        lists: "id, dirty",
        focus: "id, taskId, start, dirty",
        habits: "id, dirty",
        files: "id, dirty",
        tombs: "key, dirty",
      })
      .upgrade((tx) =>
        Promise.all(
          SYNC_TABLES.map((t) =>
            tx.table(t).toCollection().modify((r: { rev?: number; dirty?: number; updatedAt?: number }) => {
              r.rev = nextRev(r.updatedAt);
              r.dirty = 1;
            }),
          ),
        ),
      );
    this.trackChanges();
  }

  /**
   * Stamp every local write with a new rev and mark it dirty, and leave a
   * tombstone for every local delete. This is all the sync engine needs, and
   * it happens here so that no caller can forget it.
   */
  private trackChanges() {
    const pending = new WeakMap<Transaction, Tomb[]>();
    for (const name of SYNC_TABLES) {
      const table = this.table(name);
      table.hook("creating", (_key, obj: { rev?: number; dirty?: number }, tx) => {
        if (quiet.has(tx)) return;
        obj.rev = nextRev();
        obj.dirty = 1;
      });
      table.hook("updating", (_mods, _key, obj: { rev?: number }, tx) => {
        if (quiet.has(tx)) return;
        return { rev: nextRev(obj.rev), dirty: 1 };
      });
      table.hook("deleting", (key, obj: { rev?: number } | undefined, tx) => {
        if (quiet.has(tx)) return;
        const tomb: Tomb = { key: name + ":" + key, table: name, id: String(key), rev: nextRev(obj?.rev), dirty: 1 };
        const list = pending.get(tx);
        if (list) return void list.push(tomb);
        const fresh = [tomb];
        pending.set(tx, fresh);
        // written once the delete itself has committed (the tombs table is usually not in its scope)
        tx.on("complete", () => {
          this.tombWrites = this.tombWrites.then(() => this.tombs.bulkPut(fresh)).catch(() => undefined);
        });
      });
    }
  }

  /** Resolves once every tombstone for an already-committed delete is stored. */
  tombsSettled(): Promise<unknown> {
    return this.tombWrites;
  }

  /** Run writes that came from another device: they keep their own rev and are not marked dirty. */
  applyQuietly<T>(tables: Table[], fn: () => Promise<T>): Promise<T> {
    return this.transaction("rw", tables, (tx) => {
      quiet.add(tx);
      return fn();
    });
  }
}

export const db = new AppDB();

// ---------- pages ----------

export const OPTION_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

async function nextSort(parentId: string | null): Promise<number> {
  const siblings = await db.pages.where("parentId").equals(parentId ?? "").toArray();
  return siblings.reduce((m, p) => Math.max(m, p.sort), 0) + 1;
}

// Dexie cannot index null, so root pages use "" as parentId in storage.
const store = (parentId: string | null) => parentId ?? "";

export async function createPage(
  parentId: string | null,
  init: Partial<Page> = {},
): Promise<string> {
  const now = Date.now();
  const id = uid();
  await db.pages.add({
    id,
    kind: "page",
    title: "",
    createdAt: now,
    updatedAt: now,
    sort: await nextSort(parentId),
    ...init,
    parentId: store(parentId),
  });
  return id;
}

export async function createDatabase(parentId: string | null, title = ""): Promise<string> {
  const statusId = uid();
  const schema: Property[] = [
    {
      id: statusId,
      name: "狀態",
      type: "select",
      options: [
        { id: uid(), name: "未開始", color: "gray" },
        { id: uid(), name: "進行中", color: "blue" },
        { id: uid(), name: "完成", color: "green" },
      ],
    },
    { id: uid(), name: "日期", type: "date" },
  ];
  const views: DbView[] = [
    { id: uid(), name: "表格", type: "table", filters: [], sorts: [] },
  ];
  return createPage(parentId, { kind: "database", title, schema, views });
}

const SNAPSHOT_EVERY = 10 * 60_000;
const SNAPSHOT_KEEP = 40;

/** Keep a copy of the page as it was, at most once every 10 minutes. */
async function snapshotBefore(id: string, force = false) {
  const page = await db.pages.get(id);
  if (!page?.content?.length) return;
  const all = await db.history.where("pageId").equals(id).sortBy("at");
  const last = all[all.length - 1];
  if (!force && last && Date.now() - last.at < SNAPSHOT_EVERY) return;
  if (last && JSON.stringify(last.content) === JSON.stringify(page.content)) return;
  await db.history.add({ id: uid(), pageId: id, at: Date.now(), title: page.title, content: page.content });
  if (all.length >= SNAPSHOT_KEEP) {
    await db.history.bulkDelete(all.slice(0, all.length + 1 - SNAPSHOT_KEEP).map((s) => s.id));
  }
}

export async function updatePage(id: string, patch: Partial<Page>) {
  const extra: Partial<Page> = { updatedAt: Date.now() };
  if (patch.content) {
    await snapshotBefore(id);
    extra.text = blocksToText(patch.content);
    extra.links = linkedPageIds(patch.content);
  }
  await db.pages.update(id, { ...patch, ...extra });
}

/**
 * Read-modify-write on one page inside a transaction. Use this (not updatePage
 * with values captured at render time) whenever the new value depends on the
 * old one, so that quick successive edits cannot overwrite each other.
 */
export function mutatePage(id: string, change: (current: Page) => Partial<Page>) {
  return db.transaction("rw", db.pages, async () => {
    const current = await db.pages.get(id);
    if (current) await db.pages.update(id, { ...change(current), updatedAt: Date.now() });
  });
}

export const setRowProp = (rowId: string, propId: string, value: PropValue) =>
  mutatePage(rowId, (row) => ({ props: { ...row.props, [propId]: value } }));

/** Put a saved version back. The current content is snapshotted first, so this can be undone. */
export async function restoreSnapshot(snapshotId: string) {
  const snap = await db.history.get(snapshotId);
  if (!snap) return;
  await snapshotBefore(snap.pageId, true);
  await db.pages.update(snap.pageId, {
    content: snap.content,
    text: blocksToText(snap.content),
    links: linkedPageIds(snap.content),
    updatedAt: Date.now(),
  });
}

/** Pages whose content links to the given page. */
export async function backlinks(id: string): Promise<Page[]> {
  const all = await db.pages.toArray();
  return all.filter(
    (p) => p.id !== id && !p.deletedAt && (p.links ?? linkedPageIds(p.content)).includes(id),
  );
}

/**
 * Move a page next to a sibling: before `beforeId`, or to the end of the
 * parent when `beforeId` is null. Also used to reorder database rows.
 */
export async function placePage(id: string, parentId: string | null, beforeId: string | null) {
  if (parentId === id) return;
  if (parentId && (await descendants(id)).some((d) => d.id === parentId)) return;
  const me = await db.pages.get(id);
  if (!me) return;
  const siblings = (await db.pages.where("parentId").equals(store(parentId)).toArray())
    .filter((p) => p.id !== id && !p.deletedAt && !!p.isRow === !!me.isRow)
    .sort((a, b) => a.sort - b.sort);
  const i = beforeId ? siblings.findIndex((p) => p.id === beforeId) : -1;
  const sort =
    i < 0
      ? sortBetween(siblings[siblings.length - 1]?.sort, undefined)
      : sortBetween(siblings[i - 1]?.sort, siblings[i].sort);
  await db.pages.update(id, { parentId: store(parentId), sort, updatedAt: Date.now() });
}

export async function descendants(id: string): Promise<Page[]> {
  const out: Page[] = [];
  const queue = [id];
  while (queue.length) {
    const kids = await db.pages.where("parentId").equals(queue.shift()!).toArray();
    out.push(...kids);
    queue.push(...kids.map((k) => k.id));
  }
  return out;
}

/** Move a page (and everything under it) to the trash. */
export async function trashPage(id: string) {
  await db.pages.update(id, { deletedAt: Date.now() });
}

export async function restorePage(id: string) {
  const page = await db.pages.get(id);
  if (!page) return;
  const patch: Partial<Page> = { deletedAt: null };
  // If the parent is gone or itself trashed, restore to the top level.
  if (page.parentId) {
    const parent = await db.pages.get(page.parentId);
    if (!parent || (await isTrashed(parent))) {
      patch.parentId = "";
      patch.isRow = false;
    }
  }
  await db.pages.update(id, patch);
}

export async function isTrashed(page: Page): Promise<boolean> {
  let cur: Page | undefined = page;
  while (cur) {
    if (cur.deletedAt) return true;
    if (!cur.parentId) return false;
    cur = await db.pages.get(cur.parentId);
  }
  return false;
}

export async function deletePageForever(id: string) {
  const kids = await descendants(id);
  const ids = [id, ...kids.map((k) => k.id)];
  await db.pages.bulkDelete(ids);
  await db.history.where("pageId").anyOf(ids).delete();
}

export async function movePage(id: string, newParentId: string | null) {
  if (newParentId === id) return;
  if (newParentId && (await descendants(id)).some((d) => d.id === newParentId)) return;
  await db.pages.update(id, {
    parentId: store(newParentId),
    isRow: false,
    sort: await nextSort(newParentId),
    updatedAt: Date.now(),
  });
}

export async function duplicatePage(id: string, parentOverride?: string): Promise<string | null> {
  const src = await db.pages.get(id);
  if (!src) return null;
  const now = Date.now();
  const copyId = uid();
  await db.pages.add({
    ...src,
    id: copyId,
    parentId: parentOverride ?? src.parentId,
    title: parentOverride ? src.title : src.title + "（副本）",
    favorite: false,
    createdAt: now,
    updatedAt: now,
    sort: parentOverride ? src.sort : src.sort + 0.5,
  });
  const kids = await db.pages.where("parentId").equals(id).toArray();
  for (const k of kids) if (!k.deletedAt) await duplicatePage(k.id, copyId);
  return copyId;
}

export async function breadcrumb(id: string): Promise<Page[]> {
  const out: Page[] = [];
  let cur = await db.pages.get(id);
  while (cur) {
    out.unshift(cur);
    cur = cur.parentId ? await db.pages.get(cur.parentId) : undefined;
  }
  return out;
}

/** Open (creating if needed) today's page under a top-level "日誌" page. */
export async function openDailyNote(): Promise<string> {
  const saved = (await db.meta.get("journalId"))?.value as string | undefined;
  let journal = saved ? await db.pages.get(saved) : undefined;
  if (!journal || (await isTrashed(journal))) {
    const id = await createPage(null, { title: "日誌", icon: "📓" });
    await db.meta.put({ key: "journalId", value: id });
    journal = (await db.pages.get(id))!;
  }
  const title = new Date().toLocaleDateString("zh-TW", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  const days = await db.pages.where("parentId").equals(journal.id).toArray();
  const existing = days.find((p) => p.title === title && !p.deletedAt);
  if (existing) return existing.id;
  // newest day first
  const first = Math.min(1, ...days.map((p) => p.sort));
  return createPage(journal.id, { title, icon: "🗒️", sort: first - 1 });
}

/**
 * Append CSV rows to a database. The first line is the header; the first column
 * becomes the row name, other columns are matched to properties by name and
 * created (with a guessed type) when missing. Returns the number of rows added.
 */
export async function importCsv(dbId: string, text: string): Promise<number> {
  const table = parseCsv(text);
  const dbPage = await db.pages.get(dbId);
  if (!dbPage || table.length < 2) return 0;
  const [header, ...lines] = table;
  const schema = [...(dbPage.schema ?? [])];
  const cols = header.slice(1).map((raw, i) => {
    const name = raw.trim() || `欄位 ${i + 2}`;
    let prop = schema.find((p) => p.name === name);
    if (!prop) {
      const type = guessType(lines.map((l) => l[i + 1] ?? ""));
      prop = { id: uid(), name, type, ...(type === "select" ? { options: [] } : {}) };
      schema.push(prop);
    }
    return prop;
  });
  const option = (prop: Property, name: string) => {
    let o = prop.options!.find((x) => x.name === name);
    if (!o) {
      o = { id: uid(), name, color: OPTION_COLORS[prop.options!.length % OPTION_COLORS.length] };
      prop.options!.push(o);
    }
    return o.id;
  };
  let sort = await nextSort(dbId);
  const now = Date.now();
  const rows: Page[] = lines.map((line) => {
    const props: Record<string, PropValue> = {};
    cols.forEach((prop, i) => {
      const v = (line[i + 1] ?? "").trim();
      if (!v) return;
      switch (prop.type) {
        case "number":
          if (Number.isFinite(Number(v))) props[prop.id] = Number(v);
          break;
        case "checkbox":
          props[prop.id] = /^(true|yes|✓|是)$/i.test(v);
          break;
        case "date": {
          const m = v.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
          if (m) props[prop.id] = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
          break;
        }
        case "select":
          props[prop.id] = option(prop, v);
          break;
        case "multiSelect":
          props[prop.id] = v.split(/[,、]\s*/).filter(Boolean).map((n) => option(prop, n));
          break;
        case "text":
        case "url":
          props[prop.id] = v;
          break;
        // computed and relation columns cannot be filled from text
      }
    });
    return {
      id: uid(),
      parentId: dbId,
      kind: "page",
      isRow: true,
      title: (line[0] ?? "").trim(),
      props,
      sort: sort++,
      createdAt: now,
      updatedAt: now,
    };
  });
  await db.transaction("rw", db.pages, async () => {
    await db.pages.update(dbId, { schema, updatedAt: now });
    await db.pages.bulkAdd(rows);
  });
  return rows.length;
}

// ---------- tasks ----------

export async function addTask(init: Partial<Task> & { title: string }): Promise<string> {
  const id = uid();
  await db.tasks.add({
    id,
    listId: null,
    done: false,
    priority: 0,
    sort: Date.now(),
    createdAt: Date.now(),
    ...init,
  });
  return id;
}

/**
 * Toggle completion. Completing a repeating task with a due date does not
 * close it: it rolls forward to the next occurrence instead.
 */
export async function toggleTask(id: string) {
  const t = await db.tasks.get(id);
  if (!t) return;
  if (!t.done && t.repeat && t.due) {
    await db.tasks.update(id, { due: nextDue(t.due, t.repeat) });
    // subtasks start fresh for the next round
    await db.tasks.where("parentId").equals(id).modify({ done: false, completedAt: null });
    return;
  }
  const done = !t.done;
  await db.tasks.update(id, { done, completedAt: done ? Date.now() : null });
}

export async function deleteTask(id: string) {
  await db.tasks.where("parentId").equals(id).delete();
  await db.tasks.delete(id);
}

export async function deleteList(id: string) {
  // tasks of a deleted list fall back to the inbox rather than vanishing
  await db.tasks.where("listId").equals(id).modify({ listId: null });
  await db.lists.delete(id);
}

// ---------- files ----------

const urlCache = new Map<string, string>();

export async function saveFile(file: File): Promise<string> {
  const id = uid();
  await db.files.add({ id, name: file.name, type: file.type, blob: file });
  return "idb://" + id;
}

export async function resolveFileUrl(url: string): Promise<string> {
  if (!url.startsWith("idb://")) return url;
  const id = url.slice(6);
  const hit = urlCache.get(id);
  if (hit) return hit;
  const f = await db.files.get(id);
  if (!f) return url;
  // Re-wrap with a vetted type: a stored file (possibly from an imported backup)
  // must never be served from our origin as HTML or SVG, where it could run script.
  const obj = URL.createObjectURL(new Blob([f.blob], { type: safeBlobType(f.type) }));
  urlCache.set(id, obj);
  return obj;
}

// ---------- backup ----------

const blobToDataUrl = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });

export async function exportAll(): Promise<string> {
  const files = await Promise.all(
    (await db.files.toArray()).map(async (f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      data: await blobToDataUrl(f.blob),
    })),
  );
  return JSON.stringify({
    app: "slate-workspace",
    version: 1,
    exportedAt: new Date().toISOString(),
    pages: await db.pages.toArray(),
    tasks: await db.tasks.toArray(),
    lists: await db.lists.toArray(),
    focus: await db.focus.toArray(),
    habits: await db.habits.toArray(),
    history: await db.history.toArray(),
    files,
  });
}

/** Replace all local data with a backup. Throws if the file is not a backup. */
export async function importAll(json: string) {
  const data = JSON.parse(json);
  if (data?.app !== "slate-workspace" || !Array.isArray(data.pages)) {
    throw new Error("這不是有效的備份檔");
  }
  const files: StoredFile[] = await Promise.all(
    (data.files ?? []).map(async (f: { id: string; name: string; type: string; data: string }) => {
      // only embedded data: never let a backup file make us fetch some other URL
      if (typeof f.data !== "string" || !f.data.startsWith("data:")) {
        throw new Error("備份檔裡的附件格式不正確");
      }
      return {
        id: String(f.id),
        name: String(f.name),
        type: String(f.type),
        blob: await (await fetch(f.data)).blob(),
      };
    }),
  );
  const tables = [db.pages, db.tasks, db.lists, db.focus, db.habits, db.files, db.history];
  await db.transaction("rw", tables, async () => {
    await Promise.all(tables.map((t) => t.clear()));
    await db.history.bulkAdd(data.history ?? []);
    await db.pages.bulkAdd(data.pages);
    await db.tasks.bulkAdd(data.tasks ?? []);
    await db.lists.bulkAdd(data.lists ?? []);
    await db.focus.bulkAdd(data.focus ?? []);
    await db.habits.bulkAdd(data.habits ?? []);
    await db.files.bulkAdd(files);
  });
}

// ---------- first run ----------

export async function seedIfEmpty() {
  if ((await db.pages.count()) > 0 || (await db.tasks.count()) > 0) return;
  const p = (text: string, type = "paragraph", props = {}) => ({
    type,
    props,
    content: [{ type: "text", text, styles: {} }],
  });
  const content = [
    p("這是一個完全離線的工作區，所有資料都只存在這台裝置的瀏覽器裡。"),
    p("快速上手", "heading", { level: 2 }),
    p("在空白行輸入 / 叫出區塊選單（標題、清單、待辦、表格、圖片、程式碼…）", "bulletListItem"),
    p("輸入 /頁面 或 /資料庫 可在此頁底下建立子頁面", "bulletListItem"),
    p("Ctrl + K 全域搜尋，Ctrl + \\ 收合側邊欄", "bulletListItem"),
    p("左側「待辦」是獨立的任務管理：今天、最近 7 天、番茄鐘、習慣打卡", "bulletListItem"),
    p("試著勾掉我", "checkListItem"),
    p("記得偶爾到「設定」匯出備份——清除瀏覽器資料會連同這裡的內容一起清掉。", "quote"),
  ];
  const home = await createPage(null, { title: "歡迎使用", icon: "👋", content, text: blocksToText(content) });
  const dbId = await createDatabase(home, "專案追蹤");
  const database = (await db.pages.get(dbId))!;
  const [status, date] = database.schema!;
  await updatePage(dbId, {
    icon: "📋",
    views: [
      ...database.views!,
      { id: uid(), name: "看板", type: "board", filters: [], sorts: [], groupBy: status.id },
      { id: uid(), name: "月曆", type: "calendar", filters: [], sorts: [], dateProp: date.id },
    ],
  });
  const d = new Date().toISOString().slice(0, 10);
  const rows: [string, number][] = [["規劃需求", 2], ["設計介面", 1], ["撰寫文件", 0]];
  for (const [title, opt] of rows) {
    await createPage(dbId, {
      title,
      isRow: true,
      props: { [status.id]: status.options![opt].id, [date.id]: d },
    });
  }
  await addTask({ title: "逛逛這個工作區", due: d, priority: 2 });
  await addTask({ title: "到設定匯出一次備份", due: d });
}
