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
  /** id of the page everything was put under */
  root: string;
}

/**
 * Import a Notion export (Markdown & CSV). Pages keep their nesting, databases come in as
 * databases with their rows, pictures and attachments are stored, and links between
 * pages keep working. Everything lands under one new page so nothing gets mixed up.
 */
export async function importNotion(
  entries: ZipEntry[],
  toBlocks: (markdown: string) => unknown[] | Promise<unknown[]>,
): Promise<NotionResult> {
  const text = new TextDecoder();
  const files = new Map(entries.map((e) => [e.name.replace(/\\/g, "/").replace(/^\/+/, ""), e.data]));
  const mds = [...files.keys()].filter((p) => /\.md$/i.test(p));
  // "X_all.csv" holds every row of a database; "X.csv" only what its default view showed
  const csvs = [...files.keys()].filter((p) => /\.csv$/i.test(p));
  const databases = csvs.filter((p) => /_all\.csv$/i.test(p) || !files.has(p.replace(/\.csv$/i, "_all.csv")));
  if (mds.length + databases.length === 0) {
    throw new ImportError("壓縮檔裡沒有 Notion 的頁面。請在 Notion 匯出時選「Markdown & CSV」。");
  }

  // every page and database gets its id up front, so links between them can be rewritten
  const stem = (p: string) => p.replace(/(_all)?\.(md|csv)$/i, "");
  const idByStem = new Map<string, string>();
  for (const p of [...mds, ...databases]) if (!idByStem.has(stem(p))) idByStem.set(stem(p), uid());
  const dbStems = new Set(databases.map(stem));

  const result: NotionResult = { pages: 0, databases: 0, rows: 0, files: 0, root: "" };
  result.root = await createPage(null, { title: "從 Notion 匯入", icon: "📥" });

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
    result.files++;
    return url;
  };

  /** Markdown of one page -> { title, blocks }, with its pictures stored and its links rewritten. */
  const read = async (path: string) => {
    let md = text.decode(files.get(path)!).replace(/^﻿/, "");
    let title = stripId(baseOf(path).replace(/\.md$/i, ""));
    const h1 = md.match(/^\s*#\s+(.+)\r?\n?/);
    if (h1) {
      title = h1[1].trim();
      md = md.slice(h1[0].length);
    }
    const dir = dirOf(path);
    const links = [...md.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g)];
    for (const [whole, bang, label, href] of links) {
      if (/^(https?:|mailto:|#|idb:)/i.test(href)) continue;
      const target = resolvePath(dir, href);
      const page = idByStem.get(stem(target));
      let next: string | null = null;
      if (!bang && page && /\.(md|csv)$/i.test(target)) next = `[${label}](#/p/${page})`;
      else {
        const url = await store(target);
        if (url) next = `${bang}[${label}](${url})`;
      }
      if (next) md = md.split(whole).join(next);
    }
    return { title, content: withPageLinks(await toBlocks(md)) };
  };

  /** The page or database a path sits inside: the one named like its folder. */
  const parentOf = (path: string): string | null => idByStem.get(dirOf(stem(path))) ?? null;
  const depth = (p: string) => p.split("/").length;

  // databases first (their rows are pages inside them), shallow before deep
  const rowPages = new Map<string, string>(); // md path -> row id
  for (const p of [...databases].sort((a, b) => depth(a) - depth(b))) {
    const id = idByStem.get(stem(p))!;
    const title = stripId(baseOf(stem(p)));
    await createPage(null, { id, kind: "database", title, schema: [], views: [{ id: uid(), name: "表格", type: "table", filters: [], sorts: [] }] });
    result.rows += await importCsv(id, text.decode(files.get(p)!));
    result.databases++;
    // a row with a body has its own .md in the folder named after the database
    const rows = await db.pages.where("parentId").equals(id).toArray();
    const free = new Map<string, string[]>();
    for (const r of rows) free.set(r.title, [...(free.get(r.title) ?? []), r.id]);
    for (const m of mds.filter((x) => dirOf(x) === stem(p))) {
      const name = stripId(baseOf(m).replace(/\.md$/i, ""));
      const rowId = free.get(name)?.shift();
      if (rowId) {
        rowPages.set(m, rowId);
        idByStem.set(stem(m), rowId);
      }
    }
  }

  const ordered = [...mds].sort((a, b) => depth(a) - depth(b));
  // pages are created first and filled second, so every link target already has its id
  for (const m of ordered) {
    if (rowPages.has(m)) continue;
    const parent = parentOf(m);
    await createPage(parent ?? result.root, {
      id: idByStem.get(stem(m))!,
      title: stripId(baseOf(m).replace(/\.md$/i, "")),
      // a page in a database's folder that matched no row of the table is still one of its rows
      ...(parent && dbStems.has(dirOf(stem(m))) ? { isRow: true } : {}),
    });
    result.pages++;
  }
  for (const p of databases) {
    const id = idByStem.get(stem(p))!;
    await db.pages.update(id, { parentId: parentOf(p) ?? result.root });
  }
  for (const m of ordered) {
    const { title, content } = await read(m);
    const id = rowPages.get(m) ?? idByStem.get(stem(m))!;
    // a row keeps the name its table gave it
    await updatePage(id, rowPages.has(m) ? { content } : { title, content });
  }
  return result;
}

// ---------- one entry point ----------

export type Imported =
  | ({ kind: "notion" } & NotionResult)
  | { kind: "ticktick"; tasks: number; lists: number };

/** Work out what a chosen file is and import it. */
export async function importFile(
  file: File,
  toBlocks: (markdown: string) => unknown[] | Promise<unknown[]>,
): Promise<Imported> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) return { kind: "notion", ...(await importNotion(await unzipDeep(bytes), toBlocks)) };
  const content = new TextDecoder().decode(bytes);
  if (looksLikeTickTick(content)) return { kind: "ticktick", ...(await importTickTick(content)) };
  throw new ImportError(
    "看不出這是什麼檔案。可以匯入的是：Notion 匯出的 .zip（選 Markdown & CSV），或滴答清單／TickTick 的備份 .csv。",
  );
}
