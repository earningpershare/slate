import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { importFile, importNotion, importTickTick, unzip, withPageLinks, type ZipEntry } from "./importers";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);
/** stands in for the editor's Markdown parser: one paragraph per line */
const toBlocks = (md: string) =>
  md
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => ({ type: "paragraph", content: [{ type: "text", text: l, styles: {} }] }));
const textOf = (content: unknown) => JSON.stringify(content);

/** Build a zip the way a zip tool would (entries deflated unless told otherwise). */
async function zip(files: Record<string, string | Uint8Array>, stored = false): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const raw = typeof value === "string" ? bytes(value) : value;
    const body = stored
      ? raw
      : new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    const n = bytes(name);
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(6, 0x800, true);
    lv.setUint16(8, stored ? 0 : 8, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const central = new Uint8Array(46 + n.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, 0x800, true);
    cv.setUint16(10, stored ? 0 : 8, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    central.set(n, 46);
    parts.push(local, body);
    directory.push(central);
    offset += local.length + body.length;
  }
  const dirSize = directory.reduce((a, d) => a + d.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, directory.length, true);
  ev.setUint16(10, directory.length, true);
  ev.setUint32(12, dirSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...directory, end];
  const out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

beforeEach(async () => {
  await Promise.all([db.pages.clear(), db.tasks.clear(), db.lists.clear(), db.files.clear()]);
});

describe("unzip", () => {
  it("reads deflated and stored entries with non-ASCII names", async () => {
    for (const stored of [false, true]) {
      const got = await unzip(await zip({ "資料夾/筆記.md": "內容 ".repeat(200), "a.txt": "hi" }, stored));
      expect(got.map((e) => e.name)).toEqual(["資料夾/筆記.md", "a.txt"]);
      expect(new TextDecoder().decode(got[0].data)).toBe("內容 ".repeat(200));
    }
  });
  it("refuses something that is not a zip", async () => {
    await expect(unzip(bytes("just some text, long enough to look at"))).rejects.toThrow("zip");
  });
});

const TICKTICK = `"Date: 2024-03-01+0000"
"Version: 7.1"
"Status:
0 Normal
1 Completed
2 Archived"
"Folder Name","List Name","Title","Kind","Tags","Content","Is Check list","Start Date","Due Date","Reminder","Repeat","Priority","Status","Created Time","Completed Time","Order","Timezone","Is All Day","Is Floating","Column Name","Column Order","View Mode","taskId","parentId"
"","工作","寫週報","TEXT","報告, 每週","記得附上數字","N","2024-03-08T01:00:00+0000","2024-03-08T01:00:00+0000","","FREQ=WEEKLY;INTERVAL=1","5","0","2024-03-01T02:00:00+0000","","-1099511627776","Asia/Taipei","false","false","","","list","101",""
"","工作","蒐集數字","TEXT","","","N","","","","","0","0","2024-03-01T02:05:00+0000","","0","Asia/Taipei","","false","","","list","102","101"
"","Inbox","買牛奶","TEXT","","","N","2024-03-02T16:00:00+0000","2024-03-02T16:00:00+0000","","","1","2","2024-03-01T03:00:00+0000","2024-03-03T04:00:00+0000","0","Asia/Taipei","true","false","","","list","103",""
"","生活","運動","TEXT","","","N","","","","FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR","3","0","2024-03-01T03:00:00+0000","","0","Asia/Taipei","true","false","","","list","104","999"
`;

describe("TickTick backup", () => {
  it("brings in tasks, lists, subtasks, dates, priority, tags and repeats", async () => {
    expect(await importTickTick(TICKTICK)).toEqual({ tasks: 4, lists: 2 });
    const lists = await db.lists.toArray();
    expect(lists.map((l) => l.name).sort()).toEqual(["工作", "生活"]);
    const byTitle = Object.fromEntries((await db.tasks.toArray()).map((t) => [t.title, t]));

    const report = byTitle["寫週報"];
    expect(report.listId).toBe(lists.find((l) => l.name === "工作")!.id);
    expect(report.note).toBe("記得附上數字");
    expect(report.tags).toEqual(["報告", "每週"]);
    expect(report.priority).toBe(3);
    expect(report.repeat).toBe("weekly");
    expect(report.done).toBe(false);
    // 01:00 UTC, shown in whatever zone this machine is in
    const local = new Date("2024-03-08T01:00:00Z");
    expect(report.dueTime).toBe(`${String(local.getHours()).padStart(2, "0")}:00`);
    expect(report.due).toMatch(/^2024-03-0[78]$/);

    expect(byTitle["蒐集數字"].parentId).toBe(report.id); // subtask
    expect(byTitle["買牛奶"]).toMatchObject({ listId: null, done: true, priority: 1, dueTime: null }); // inbox, archived, all day
    expect(byTitle["買牛奶"].completedAt).toBe(Date.parse("2024-03-03T04:00:00Z"));
    expect(byTitle["運動"]).toMatchObject({ repeat: "weekdays", priority: 2, parentId: null }); // parent not in the file
  });

  it("importing the same backup twice does not double the tasks", async () => {
    await importTickTick(TICKTICK);
    await db.tasks.update("tt-101", { title: "改過的標題" });
    expect(await importTickTick(TICKTICK)).toEqual({ tasks: 4, lists: 0 });
    expect(await db.tasks.count()).toBe(4);
    expect(await db.lists.count()).toBe(2);
  });

  it("refuses a CSV that is not a TickTick backup", async () => {
    await expect(importTickTick("a,b\n1,2\n")).rejects.toThrow("滴答清單");
  });
});

const ID = (n: number) => String(n).repeat(32).slice(0, 32);
const notionFiles = (): Record<string, string | Uint8Array> => ({
  [`旅行計畫 ${ID(1)}.md`]: `# 旅行計畫\n\n先看 [行李清單](%E6%97%85%E8%A1%8C%E8%A8%88%E7%95%AB%20${ID(1)}/%E8%A1%8C%E6%9D%8E%E6%B8%85%E5%96%AE%20${ID(2)}.md) 和 [預算](%E6%97%85%E8%A1%8C%E8%A8%88%E7%95%AB%20${ID(1)}/%E9%A0%90%E7%AE%97%20${ID(3)}.csv)\n\n![地圖](%E6%97%85%E8%A1%8C%E8%A8%88%E7%95%AB%20${ID(1)}/map.png)\n\n[官網](https://example.com)\n`,
  [`旅行計畫 ${ID(1)}/行李清單 ${ID(2)}.md`]: `# 行李清單\n\n護照\n`,
  [`旅行計畫 ${ID(1)}/map.png`]: new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
  [`旅行計畫 ${ID(1)}/預算 ${ID(3)}.csv`]: `﻿項目,金額,已付\n機票,12000,Yes\n`,
  [`旅行計畫 ${ID(1)}/預算 ${ID(3)}_all.csv`]: `﻿項目,金額,已付\n機票,12000,Yes\n住宿,8000,No\n`,
  [`旅行計畫 ${ID(1)}/預算 ${ID(3)}/機票 ${ID(4)}.md`]: `# 機票\n\n金額: 12000\n\n訂位代號 ABC123\n`,
});
const entries = (files: Record<string, string | Uint8Array>): ZipEntry[] =>
  Object.entries(files).map(([name, v]) => ({ name, data: typeof v === "string" ? bytes(v) : v }));

describe("Notion export", () => {
  it("keeps nesting, databases with their rows, pictures and links between pages", async () => {
    const r = await importNotion(entries(notionFiles()), toBlocks);
    expect(r).toMatchObject({ pages: 2, databases: 1, rows: 2, files: 1 });
    const pages = await db.pages.toArray();
    const by = (title: string) => pages.find((p) => p.title === title)!;

    const root = by("從 Notion 匯入");
    const trip = by("旅行計畫");
    expect(trip.parentId).toBe(root.id);
    expect(by("行李清單").parentId).toBe(trip.id);
    expect(textOf(by("行李清單").content)).toContain("護照");

    // the complete table was used, not the filtered one
    const budget = by("預算");
    expect(budget.kind).toBe("database");
    expect(budget.parentId).toBe(trip.id);
    expect(budget.schema!.map((p) => [p.name, p.type])).toEqual([
      ["金額", "number"],
      ["已付", "checkbox"],
    ]);
    const ticket = by("機票");
    expect(ticket).toMatchObject({ parentId: budget.id, isRow: true });
    expect(ticket.props![budget.schema![0].id]).toBe(12000);
    expect(ticket.props![budget.schema![1].id]).toBe(true);
    expect(textOf(ticket.content)).toContain("ABC123"); // the row's own page came along
    expect(pages.filter((p) => p.title === "機票")).toHaveLength(1);
    expect(by("住宿").parentId).toBe(budget.id);

    // links point at the imported pages, the picture at the stored file, the web link is untouched
    const body = textOf(trip.content);
    expect(body).toContain(`#/p/${by("行李清單").id}`);
    expect(body).toContain(`#/p/${budget.id}`);
    const file = (await db.files.toArray())[0];
    expect(file).toMatchObject({ name: "map.png", type: "image/png" });
    expect(body).toContain(`idb://${file.id}`);
    expect(body).toContain("https://example.com");
    expect(body).not.toContain(ID(1));
  });

  it("is recognised from a zip, including a zip inside the zip", async () => {
    const inner = await zip(notionFiles());
    const outer = await zip({ "Export-Part-1.zip": inner }, true);
    const r = await importFile(new File([outer as BlobPart], "Export.zip"), toBlocks);
    expect(r).toMatchObject({ kind: "notion", pages: 2, databases: 1 });
  });

  it("explains what to do when the zip holds no pages", async () => {
    await expect(importNotion(entries({ "readme.txt": "hi" }), toBlocks)).rejects.toThrow("Markdown & CSV");
  });
});

describe("links between imported pages", () => {
  const link = (id: string, text: string) => ({ type: "link", href: "#/p/" + id, content: [{ type: "text", text, styles: {} }] });
  const t = (text: string) => ({ type: "text", text, styles: {} });
  it("a line that is only a link becomes a page-link block; one inside a sentence gets the block below", () => {
    const got = withPageLinks([
      { type: "paragraph", content: [link("p1", "子頁面")] },
      { type: "paragraph", content: [t("先看 "), link("p2", "這頁"), t(" 再說")] },
      { type: "bulletListItem", content: [t("外層")], children: [{ type: "paragraph", content: [link("p3", "深處")] }] },
      { type: "paragraph", content: [{ type: "link", href: "https://example.com", content: [t("外部")] }] },
    ]) as { type: string; props?: { pageId: string }; children?: { type: string }[] }[];
    expect(got.map((b) => b.type)).toEqual(["pageLink", "paragraph", "pageLink", "bulletListItem", "paragraph"]);
    expect(got[0].props!.pageId).toBe("p1");
    expect(got[2].props!.pageId).toBe("p2");
    expect(got[3].children![0].type).toBe("pageLink");
  });
});

describe("importFile", () => {
  it("recognises a TickTick backup and refuses anything else", async () => {
    expect(await importFile(new File([TICKTICK], "backup.csv"), toBlocks)).toMatchObject({ kind: "ticktick", tasks: 4 });
    await expect(importFile(new File(["hello"], "x.txt"), toBlocks)).rejects.toThrow("看不出");
  });
});
