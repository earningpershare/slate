// Bringing data in from other apps:
//   TickTick / 滴答清單   the backup CSV (設定 → 備份 → 生成備份)
//   Notion               the export zip (匯出 → Markdown & CSV, 包含子頁面)
// Both add to what is already here; nothing is replaced.
import { createDatabase, createPage, db, importCsv, saveFile, updatePage } from "../db";
import type { Repeat, Task } from "../types";
import { parseCsv, uid } from "./logic";

export class ImportError extends Error {}

// ---------- zip ----------

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Read a zip archive (stored and deflated entries). Folders are left out. */
export async function unzip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // the directory sits at the end, after a record that starts with PK\5\6
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ImportError("這不是 zip 壓縮檔，或檔案已損壞。");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new ImportError("這個壓縮檔太大（超過 4 GB），請分批匯出。");
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new ImportError("壓縮檔已損壞。");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const rawName = bytes.subarray(at + 46, at + 46 + nameLen);
    // bit 11 says UTF-8; names that happen to be valid UTF-8 are read that way too
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: !(flags & 0x800) }).decode(rawName);
    } catch {
      name = new TextDecoder("latin1").decode(rawName);
    }
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const body = bytes.subarray(start, start + size);
    if (method === 0) out.push({ name, data: body });
    else if (method === 8) out.push({ name, data: await inflate(body) });
    else throw new ImportError("壓縮檔使用了不支援的壓縮方式。");
  }
  return out;
}

/** Notion splits big exports into zips inside the zip: flatten them. */
async function unzipDeep(bytes: Uint8Array, depth = 0): Promise<ZipEntry[]> {
  const out: ZipEntry[] = [];
  for (const e of await unzip(bytes)) {
    if (depth < 2 && /\.zip$/i.test(e.name)) out.push(...(await unzipDeep(e.data, depth + 1)));
    else out.push(e);
  }
  return out;
}

// ---------- TickTick ----------

const LIST_COLORS = ["#2f6f5e", "#c2622d", "#3b6fb6", "#8a5cb8", "#b8447a", "#a08a1c"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "2024-03-05T16:00:00+0000" -> local date and time */
function localParts(stamp: string): { date: string; time: string; at: number } | null {
  const d = new Date(stamp.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isNaN(d.getTime())) return null;
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    at: d.getTime(),
  };
}

function repeatOf(rule: string): Repeat | null {
  const freq = rule.match(/FREQ=(\w+)/)?.[1];
  if (freq === "DAILY") return "daily";
  if (freq === "WEEKLY") return /BYDAY=MO,TU,WE,TH,FR(;|$)/.test(rule) ? "weekdays" : "weekly";
  if (freq === "MONTHLY") return "monthly";
  if (freq === "YEARLY") return "yearly";
  return null;
}

export const looksLikeTickTick = (text: string) => /"?List Name"?\s*,\s*"?Title"?/.test(text.slice(0, 4000));

/**
 * Import a TickTick / 滴答清單 backup. Importing the same backup again updates the
 * tasks it brought in before instead of adding them twice.
 */
export async function importTickTick(text: string): Promise<{ tasks: number; lists: number }> {
  const table = parseCsv(text);
  const head = table.findIndex((r) => r.includes("Title") && r.includes("List Name"));
  if (head < 0) throw new ImportError("這不是滴答清單的備份檔（找不到 Title 和 List Name 欄位）。");
  const col = (name: string) => table[head].indexOf(name);
  const c = {
    list: col("List Name"),
    title: col("Title"),
    tags: col("Tags"),
    content: col("Content"),
    start: col("Start Date"),
    due: col("Due Date"),
    repeat: col("Repeat"),
    priority: col("Priority"),
    status: col("Status"),
    created: col("Created Time"),
    completed: col("Completed Time"),
    allDay: col("Is All Day"),
    id: col("taskId"),
    parent: col("parentId"),
  };
  const get = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");

  const lists = await db.lists.toArray();
  let made = 0;
  const listId = async (name: string): Promise<string | null> => {
    if (!name || /^(inbox|收集箱|收件匣|收件箱)$/i.test(name)) return null;
    let l = lists.find((x) => x.name === name);
    if (!l) {
      l = { id: uid(), name, color: LIST_COLORS[lists.length % LIST_COLORS.length], sort: Date.now() + lists.length };
      await db.lists.add(l);
      lists.push(l);
      made++;
    }
    return l.id;
  };

  const rows = table.slice(head + 1).filter((r) => get(r, c.title) || get(r, c.content));
  const idOf = (theirs: string) => "tt-" + theirs;
  const tasks: Task[] = [];
  for (const [i, r] of rows.entries()) {
    const theirs = get(r, c.id);
    const when = localParts(get(r, c.due) || get(r, c.start));
    const status = Number(get(r, c.status) || 0);
    const done = status !== 0;
    const priority = ({ 1: 1, 3: 2, 5: 3 } as Record<string, 1 | 2 | 3>)[get(r, c.priority)] ?? 0;
    const parent = get(r, c.parent);
    const tags = get(r, c.tags)
      .split(/[,，]\s*/)
      .filter(Boolean);
    tasks.push({
      id: theirs ? idOf(theirs) : uid(),
      title: get(r, c.title) || "（無標題）",
      note: get(r, c.content) || undefined,
      listId: await listId(get(r, c.list)),
      parentId: parent && parent !== "0" ? idOf(parent) : null,
      done,
      completedAt: done ? (localParts(get(r, c.completed))?.at ?? Date.now()) : null,
      due: when?.date ?? null,
      dueTime: when && !/^true$/i.test(get(r, c.allDay)) ? when.time : null,
      priority,
      repeat: repeatOf(get(r, c.repeat)),
      tags: tags.length ? tags : undefined,
      sort: Date.now() + i,
      createdAt: localParts(get(r, c.created))?.at ?? Date.now(),
    });
  }
  // a subtask whose parent is not in the file becomes an ordinary task
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) if (t.parentId && !ids.has(t.parentId)) t.parentId = null;
  await db.tasks.bulkPut(tasks);
  return { tasks: tasks.length, lists: made };
}

// ---------- Notion ----------

/** "My page 0123456789abcdef0123456789abcdef" -> "My page" */
const stripId = (name: string) => name.replace(/\s+[0-9a-f]{32}$/i, "").trim();
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
};

/** Resolve "a/b" + "../c%20d.png" -> "a/c d.png" */
function resolvePath(fromDir: string, link: string): string {
  let target = link.split("#")[0].split("?")[0];
  try {
    target = decodeURIComponent(target);
  } catch {
    /* keep as written */
  }
  const parts = fromDir ? fromDir.split("/") : [];
  for (const p of target.split("/")) {
    if (p === "..") parts.pop();
    else if (p && p !== ".") parts.push(p);
  }
  return parts.join("/");
}

type Node = { type?: string; href?: string; text?: string; props?: Record<string, unknown>; content?: unknown; children?: unknown };
const pageOf = (n: Node) => (n.type === "link" && typeof n.href === "string" ? /^#\/p\/([\w-]+)$/.exec(n.href)?.[1] : undefined);

/**
 * Turn links to imported pages into this app's own page-link blocks (they show the page's
 * icon and title, follow renames and feed backlinks). A line that is nothing but such a
 * link becomes the block; a link inside a sentence stays, and the block is added below it.
 */
export function withPageLinks(blocks: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of blocks) {
    const block = raw as Node;
    const children = Array.isArray(block.children) ? withPageLinks(block.children) : block.children;
    const inline = Array.isArray(block.content) ? (block.content as Node[]) : [];
    const targets = [...new Set(inline.map(pageOf).filter((x): x is string => !!x))];
    const rest = inline.filter((n) => !pageOf(n) && String(n.text ?? "").trim());
    const linkBlocks = targets.map((pageId) => ({ type: "pageLink", props: { pageId } }));
    if (targets.length && rest.length === 0 && block.type === "paragraph") out.push(...linkBlocks);
    else out.push({ ...block, ...(children ? { children } : {}) }, ...linkBlocks);
  }
  return out;
}

export interface NotionResult {
  pages: number;
  databases: number;
  rows: number;
  files: number;
  /** untitled pages with nothing in them and nothing under them, left out */
  skipped: number;
  /** id of the page everything was put under */
  root: string;
}

/** A one-pixel picture that loads from nowhere: what stored pictures are called while Markdown is being parsed. */
const STAND_IN = "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=";

/** One Notion page or database, pieced together from the files that describe it. */
interface NotionDoc {
  /** folder it sits in, and that folder + its file name without extension */
  dir: string;
  stem: string;
  /** as in the file name (long titles are cut short there) */
  title: string;
  /** Notion's 32-character id, when the file name carries one */
  nid: string;
  md?: string;
  csv?: string;
  /** the page it becomes in this workspace */
  pageId: string;
  depth: number;
}

/**
 * Import a Notion export (Markdown & CSV). Pages keep their nesting, databases come in as
 * databases with their rows, pictures and attachments are stored, and links between
 * pages keep working. Everything lands under one new page so nothing gets mixed up.
 * If anything fails, whatever was already brought in is taken out again.
 *
 * How an export is laid out (as of 2025): a page is "Title <32-hex id>.md"; a database is
 * "Title <id>_all.csv" (sometimes with a ".md" of the same name beside it); what sits
 * inside a page or database is in a FOLDER named after it, without the id ("Title"), or,
 * when two neighbours share a title, with the start of the id ("Title 1b81-4f2a").
 * Older exports put the id on the folder too. Attachments may sit in a folder of their own.
 */
export async function importNotion(
  entries: ZipEntry[],
  toBlocks: (markdown: string) => unknown[] | Promise<unknown[]>,
  onProgress?: (done: number, total: number) => void,
): Promise<NotionResult> {
  const text = new TextDecoder();
  const files = new Map(entries.map((e) => [e.name.replace(/\\/g, "/").replace(/^\/+/, ""), e.data]));
  const read = (path: string) => text.decode(files.get(path)!).replace(/^﻿/, "");

  // ---- 1. which files describe which page ----
  const docs = new Map<string, NotionDoc>();
  for (const path of files.keys()) {
    const m = /^(.*?)(_all)?\.(md|csv)$/i.exec(path);
    if (!m) continue;
    const stem = m[1];
    const name = baseOf(stem);
    const id = /^(.*?)\s+([0-9a-f]{32})$/i.exec(name);
    const doc = docs.get(stem) ?? { dir: dirOf(stem), stem, title: (id ? id[1] : name).trim(), nid: id ? id[2].toLowerCase() : "", pageId: uid(), depth: 0 };
    if (m[3].toLowerCase() === "md") doc.md = path;
    else if (m[2] || !doc.csv) doc.csv = path; // "_all" holds every row; the plain one only what a view showed
    docs.set(stem, doc);
  }
  if (docs.size === 0) throw new ImportError("壓縮檔裡沒有 Notion 的頁面。請在 Notion 匯出時選「Markdown & CSV」。");

  // ---- 2. which page a folder belongs to ----
  const inDir = new Map<string, NotionDoc[]>();
  for (const d of docs.values()) inDir.set(d.dir, [...(inDir.get(d.dir) ?? []), d]);
  const folderDoc = new Map<string, NotionDoc | null>();
  const docOfFolder = (folder: string): NotionDoc | null => {
    if (folderDoc.has(folder)) return folderDoc.get(folder)!;
    const around = inDir.get(dirOf(folder)) ?? [];
    const name = baseOf(folder);
    // older exports: the folder carries the full id, exactly like the file
    let hit = docs.get(folder) ?? null;
    if (!hit) {
      const same = around.filter((d) => d.title === name);
      // a database and its own ".md" share a stem, so they are one doc already; two docs here are true namesakes
      hit = same.find((d) => d.csv) ?? same[0] ?? null;
    }
    if (!hit) {
      // "Title 1b81-4f2a": the start of the id tells namesakes apart
      const m = /^(.*?)\s+([0-9a-f]{4}(?:-[0-9a-f]{1,12})*)$/i.exec(name);
      if (m) {
        const prefix = m[2].replace(/-/g, "").toLowerCase();
        const want = m[1].trim();
        const byId = around.filter((d) => d.nid.startsWith(prefix));
        hit = byId.find((d) => d.title === want) ?? byId.find((d) => d.title.startsWith(want)) ?? byId[0] ?? null;
      }
    }
    if (!hit && name === "Untitled") {
      // an unnamed database is "Untitled Database" as a file, but its folder is just "Untitled"
      const unnamed = around.filter((d) => d.csv && /^Untitled/.test(d.title));
      if (unnamed.length === 1) hit = unnamed[0];
    }
    folderDoc.set(folder, hit);
    return hit;
  };
  /** The page a doc sits inside: the nearest folder above it that is a page. */
  const parentOf = (doc: NotionDoc): NotionDoc | null => {
    for (let dir = doc.dir; dir; dir = dirOf(dir)) {
      const owner = docOfFolder(dir);
      if (owner && owner !== doc) return owner;
    }
    return null;
  };
  const parents = new Map<NotionDoc, NotionDoc | null>();
  for (const d of docs.values()) parents.set(d, parentOf(d));
  const depthOf = (d: NotionDoc): number => {
    let n = 0;
    for (let p = parents.get(d); p && n < 64; p = parents.get(p)) n++;
    return n;
  };
  for (const d of docs.values()) d.depth = depthOf(d);
  const children = new Map<NotionDoc | null, NotionDoc[]>();
  for (const [d, p] of parents) children.set(p, [...(children.get(p) ?? []), d]);

  /** A page's Markdown split into its title line and the rest. */
  const split = (path: string) => {
    const md = read(path);
    const h1 = /^\s*#\s+(.+?)\s*(?:\r?\n|$)/.exec(md);
    return h1 ? { title: h1[1].trim(), body: md.slice(h1[0].length) } : { title: "", body: md };
  };
  // the file name cuts long titles short; the heading inside has the whole one
  for (const d of docs.values()) {
    if (!d.md || d.csv) continue;
    const { title } = split(d.md);
    if (title) d.title = title;
  }

  // untitled, empty, and nothing inside: Notion leaves many of these behind
  const isRowDoc = (d: NotionDoc) => !!parents.get(d)?.csv;
  const blank = (d: NotionDoc) =>
    !d.csv && !isRowDoc(d) && !(children.get(d)?.length) && /^(untitled)?$/i.test(d.title) && (!d.md || !split(d.md).body.trim());

  // ---- 3. create ----
  const result: NotionResult = { pages: 0, databases: 0, rows: 0, files: 0, skipped: 0, root: "" };
  const made: string[] = []; // every page created, to take back out if something fails
  const madeFiles: string[] = [];
  const todo = [...docs.values()].filter((d) => !blank(d)).sort((a, b) => a.depth - b.depth);
  result.skipped = docs.size - todo.length;
  const total = todo.length * 2;
  let done = 0;
  const tick = () => onProgress?.(++done, total);

  const saved = new Map<string, string>();
  const store = async (path: string): Promise<string | null> => {
    const hit = saved.get(path);
    if (hit) return hit;
    const data = files.get(path);
    if (!data) return null;
    const name = baseOf(path);
    const type = MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
    const url = await saveFile(new File([data as BlobPart], name, { type }));
    saved.set(path, url);
    madeFiles.push(url.replace("idb://", ""));
    result.files++;
    return url;
  };

  try {
    result.root = await createPage(null, { title: "從 Notion 匯入", icon: "📥" });
    made.push(result.root);
    const columns = new Map<NotionDoc, string[]>(); // a database's column names, to tidy its rows' pages

    for (const d of todo) {
      const parent = parents.get(d);
      if (d.csv) {
        await createPage(parent?.pageId ?? result.root, { id: d.pageId, kind: "database", title: d.title, schema: [], views: [{ id: uid(), name: "表格", type: "table", filters: [], sorts: [] }] });
        made.push(d.pageId);
        result.rows += await importCsv(d.pageId, read(d.csv));
        result.databases++;
        const database = await db.pages.get(d.pageId);
        columns.set(d, (database?.schema ?? []).map((p) => p.name));
        // each row with a body has its own page file in the database's folder: pair them up by title
        const rows = await db.pages.where("parentId").equals(d.pageId).toArray();
        made.push(...rows.map((r) => r.id));
        const free = new Map<string, string[]>();
        for (const r of rows) free.set(r.title, [...(free.get(r.title) ?? []), r.id]);
        for (const kid of children.get(d) ?? []) {
          if (kid.csv) continue;
          const rowId = free.get(kid.title)?.shift() ?? [...free.entries()].find(([t, ids]) => ids.length && kid.title && t.startsWith(kid.title))?.[1].shift();
          if (rowId) kid.pageId = rowId; // the page of that row; otherwise it is created below as one more row
          else free.delete(kid.title);
        }
      } else if (!made.includes(d.pageId)) {
        await createPage(parent?.pageId ?? result.root, { id: d.pageId, title: d.title, ...(parent?.csv ? { isRow: true } : {}) });
        made.push(d.pageId);
        if (parent?.csv) result.rows++;
        else result.pages++;
      }
      tick();
    }

    // ---- 4. fill in, now that every page has its id and links can point at it ----
    for (const d of todo) {
      if (d.md && !d.csv) {
        let { body } = split(d.md);
        const parent = parents.get(d);
        if (parent?.csv) {
          // a row's page starts by repeating its columns ("Status: Done"); the table already has those
          const names = new Set(columns.get(parent) ?? []);
          const lines = body.split(/\r?\n/);
          let at = 0;
          while (at < lines.length && !lines[at].trim()) at++;
          let dropped = 0;
          while (at < lines.length) {
            const m = /^([^:\n]{1,80}):\s?.*$/.exec(lines[at]);
            if (!m || !names.has(m[1].trim())) break;
            at++;
            dropped++;
          }
          if (dropped) body = lines.slice(at).join("\n");
        }
        const dir = dirOf(d.md);
        for (const [whole, bang, label, href] of [...body.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g)]) {
          if (/^(https?:|mailto:|#|idb:)/i.test(href)) continue;
          const target = resolvePath(dir, href);
          const linked = docs.get(target.replace(/(_all)?\.(md|csv)$/i, ""));
          let next: string | null = null;
          if (!bang && linked && /\.(md|csv)$/i.test(target)) next = made.includes(linked.pageId) ? `[${label}](#/p/${linked.pageId})` : label;
          else {
            const url = await store(target);
            if (url) next = `${bang}[${label}](${url})`;
          }
          if (next !== null) body = body.split(whole).join(next);
        }
        if (body.trim()) {
          // the parser builds real picture elements, which would try to load "idb://…": give it a harmless
          // address while it works, and put the stored one back afterwards
          const held = body.replace(/idb:\/\/([\w-]+)/g, STAND_IN + "#stored-$1");
          const blocks = JSON.parse(JSON.stringify(await toBlocks(held)).split(STAND_IN + "#stored-").join("idb://")) as unknown[];
          await updatePage(d.pageId, { content: withPageLinks(blocks) });
        }
      }
      tick();
    }
    return result;
  } catch (e) {
    // leave nothing half-imported behind
    await db
      .applyQuietly([db.pages, db.files, db.history, db.tombs], async () => {
        await db.pages.bulkDelete(made);
        await db.files.bulkDelete(madeFiles);
        await db.history.where("pageId").anyOf(made).delete();
      })
      .catch(() => undefined);
    throw e;
  }
}

// ---------- one entry point ----------

export type Imported =
  | ({ kind: "notion" } & NotionResult)
  | { kind: "ticktick"; tasks: number; lists: number };

/** Work out what a chosen file is and import it. */
export async function importFile(
  file: File,
  toBlocks: (markdown: string) => unknown[] | Promise<unknown[]>,
  onProgress?: (done: number, total: number) => void,
): Promise<Imported> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) return { kind: "notion", ...(await importNotion(await unzipDeep(bytes), toBlocks, onProgress)) };
  const content = new TextDecoder().decode(bytes);
  if (looksLikeTickTick(content)) return { kind: "ticktick", ...(await importTickTick(content)) };
  throw new ImportError(
    "看不出這是什麼檔案。可以匯入的是：Notion 匯出的 .zip（選 Markdown & CSV），或滴答清單／TickTick 的備份 .csv。",
  );
}
