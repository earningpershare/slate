import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "../db";
import { importFile, importNotion, importTickTick, namesFirst, unzip, withPageLinks, type ZipEntry } from "./importers";

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

// How Notion lays an export out since 2025: ids on the files, not on the folders; namesakes told
// apart by the start of the id; attachments in a folder of their own; a workspace section on top.
const HEX = (c: string) => c.repeat(32).slice(0, 32);
const P = "Export-0000/Private & Shared/";
const current = (): Record<string, string | Uint8Array> => ({
  [`${P}旅行 ${HEX("a")}.md`]: `# 旅行\n\n[行李](${encodeURIComponent("旅行")}/${encodeURIComponent(`行李 ${HEX("b")}`)}.md)\n\n![地圖](../attachments/11111111-2222/map.png)\n`,
  [`${P}旅行/行李 ${HEX("b")}.md`]: "# 行李\n\n護照\n",
  // a database: its table, a page file of its own beside it, and its rows' pages in a folder named after it
  [`${P}旅行/預算 ${HEX("c")}_all.csv`]: "\uFEFF項目,金額,已付\n機票,12000,Yes\n住宿,8000,No\n",
  [`${P}旅行/預算 ${HEX("c")}.md`]: "# 預算\n\n",
  [`${P}旅行/預算/機票 ${HEX("d")}.md`]: "# 機票\n\n金額: 12000\n已付: Yes\n\n訂位代號 ABC123\n",
  // two unnamed databases side by side: the folders carry the start of each id
  [`${P}旅行/Untitled Database ${"e1e1e1e1" + "0".repeat(24)}_all.csv`]: "Name\n甲\n",
  [`${P}旅行/Untitled Database ${"e2e2e2e2" + "0".repeat(24)}_all.csv`]: "Name\n乙\n",
  [`${P}旅行/Untitled e1e1-e1e1/甲 ${HEX("1")}.md`]: "# 甲\n\n甲的內文\n",
  [`${P}旅行/Untitled e2e2-e2e2/乙 ${HEX("2")}.md`]: "# 乙\n\n乙的內文\n",
  // the file name cuts a long title short; the heading has all of it
  [`${P}很長的標題在檔名裡被 ${HEX("3")}.md`]: "# 很長的標題在檔名裡被切掉了一半\n\n內容\n",
  // left behind by Notion: no title, nothing in it, nothing under it
  [`${P}Untitled ${HEX("4")}.md`]: "# Untitled\n\n",
  // another section, with a folder that is only an id
  [`Export-0000/Our plan/${HEX("5")}/留言 ${HEX("6")}.md`]: "# 留言\n\n記得訂位\n",
  "Export-0000/attachments/11111111-2222/map.png": new Uint8Array([137, 80, 78, 71, 9]),
});

describe("Notion export, current layout", () => {
  it("rebuilds the nesting from folders that carry no ids", async () => {
    const r = await importNotion(entries(current()), toBlocks);
    expect(r).toMatchObject({ pages: 4, databases: 3, rows: 4, files: 1, skipped: 1 });
    const pages = await db.pages.toArray();
    const by = (title: string) => pages.filter((p) => p.title === title);
    const one = (title: string) => {
      expect(by(title), title).toHaveLength(1);
      return by(title)[0];
    };
    const root = one("從 Notion 匯入");
    const trip = one("旅行");
    expect(trip.parentId).toBe(root.id); // the section folder on top is not a page
    expect(one("行李").parentId).toBe(trip.id);
    expect(one("留言").parentId).toBe(root.id); // a folder that is only an id is skipped over
    expect(one("很長的標題在檔名裡被切掉了一半").parentId).toBe(root.id);
    expect(by("Untitled")).toHaveLength(0);

    // the database and the page file beside it are one thing, under the right page
    const budget = one("預算");
    expect(budget).toMatchObject({ kind: "database", parentId: trip.id });
    const ticket = one("機票"); // the row from the table and its page file are the same row
    expect(ticket).toMatchObject({ parentId: budget.id, isRow: true });
    expect(ticket.props![budget.schema!.find((p) => p.name === "金額")!.id]).toBe(12000);
    const body = textOf(ticket.content);
    expect(body).toContain("ABC123");
    expect(body).not.toContain("金額: 12000"); // the columns repeated at the top of a row's page are dropped
    expect(body).not.toContain("已付");
    expect(one("住宿").parentId).toBe(budget.id);

    // namesakes: each row's page went to its own table
    const unnamed = by("Untitled Database");
    expect(unnamed).toHaveLength(2);
    for (const [row, inside] of [["甲", "甲的內文"], ["乙", "乙的內文"]]) {
      const p = one(row);
      expect(p.isRow).toBe(true);
      expect(textOf(p.content)).toContain(inside);
      const table = unnamed.find((d) => d.id === p.parentId)!;
      expect((await db.pages.where("parentId").equals(table.id).toArray()).map((x) => x.title)).toEqual([row]);
    }

    // a picture kept in the separate attachments folder, and a link to a page in a subfolder
    const file = (await db.files.toArray())[0];
    expect(file).toMatchObject({ name: "map.png", type: "image/png" });
    expect(textOf(trip.content)).toContain(`idb://${file.id}`);
    expect(textOf(trip.content)).toContain(`#/p/${one("行李").id}`);
    expect(JSON.stringify(pages)).not.toContain("data:image/gif"); // the stand-in used while parsing is gone
  });

  it("finds the column that names the rows, wherever Notion put it, and reads Notion's dates", async () => {
    const files: Record<string, string> = {
      // the names are in the third column here; the first one is a status every row shares
      [`${P}美食 ${HEX("7")}_all.csv`]: "狀態,日期,餐廳,完成\n想去,\"October 13, 2024\",德記燒臘,Yes\n想去,\"June 24, 2025 → June 26, 2025\",正旺燒雞,No\n",
      [`${P}美食/德記燒臘 ${HEX("8")}.md`]: "# 德記燒臘\n\n狀態: 想去\n日期: October 13, 2024\n\n必點叉燒\n",
      [`${P}美食/正旺燒雞 ${HEX("9")}.md`]: "# 正旺燒雞\n\n",
    };
    await importNotion(entries(files), toBlocks);
    const pages = await db.pages.toArray();
    const table = pages.find((p) => p.title === "美食")!;
    const rows = pages.filter((p) => p.parentId === table.id).map((p) => p.title).sort();
    expect(rows).toEqual(["德記燒臘", "正旺燒雞"]); // not "想去" twice
    const col = (name: string) => table.schema!.find((p) => p.name === name)!;
    expect(table.schema!.map((p) => [p.name, p.type])).toEqual([
      ["狀態", "text"],
      ["日期", "date"],
      ["完成", "checkbox"],
    ]);
    const shop = pages.find((p) => p.title === "德記燒臘")!;
    expect(shop.props![col("日期").id]).toBe("2024-10-13");
    expect(shop.props![col("完成").id]).toBe(true);
    expect(pages.find((p) => p.title === "正旺燒雞")!.props![col("日期").id]).toBe("2025-06-24");
    expect(textOf(shop.content)).toContain("必點叉燒"); // the row and its page file are still one
    expect(textOf(shop.content)).not.toContain("狀態: 想去");
  });

  it("rows without a name are matched to their own page by what the page says about them", async () => {
    // a habit tracker: no row has a name, every page file is "Untitled", only the date tells them apart
    const files: Record<string, string> = {
      [`${P}習慣 ${HEX("a")}_all.csv`]: "name,日期,運動\n,\"October 14, 2024\",Yes\n,\"October 15, 2024\",No\n,\"October 16, 2024\",Yes\n",
      // deliberately not in the table's order
      [`${P}習慣/Untitled ${HEX("3")}.md`]: "# Untitled\n\n日期: October 16, 2024\n運動: Yes\n\n第三天的心得\n",
      [`${P}習慣/Untitled ${HEX("1")}.md`]: "# Untitled\n\n日期: October 14, 2024\n運動: Yes\n\n第一天的心得\n",
      [`${P}習慣/Untitled ${HEX("2")}.md`]: "# Untitled\n\n日期: October 15, 2024\n運動: No\n",
    };
    const r = await importNotion(entries(files), toBlocks);
    expect(r.rows).toBe(3); // three rows, not three rows plus three stray "Untitled" pages
    const pages = await db.pages.toArray();
    const table = pages.find((p) => p.kind === "database")!;
    const rows = pages.filter((p) => p.parentId === table.id);
    expect(rows).toHaveLength(3);
    const day = table.schema!.find((p) => p.name === "日期")!.id;
    const says = (date: string) => textOf(rows.find((x) => x.props![day] === date)!.content ?? []);
    expect(says("2024-10-14")).toContain("第一天的心得");
    expect(says("2024-10-16")).toContain("第三天的心得");
    expect(says("2024-10-15")).not.toContain("心得");
    expect(JSON.stringify(rows)).not.toContain("日期: October"); // and the repeated columns are gone from the pages
  });

  it("namesFirst leaves a table alone unless it has reason to move a column", () => {
    const csv = "Name,Tags\n甲,x\n乙,y\n";
    expect(namesFirst(csv, ["甲", "乙"])).toBe(csv);
    expect(namesFirst(csv, [])).toBe(csv);
    const unnamed = "name,日期\n,2024-10-14\n,2024-10-15\n";
    expect(namesFirst(unnamed, ["Untitled", "Untitled"])).toBe(unnamed); // rows that have no names keep having none
    expect(namesFirst("狀態,餐廳\n想去,\"a, b\"\n", ["a, b"])).toBe('餐廳,狀態\n"a, b",想去'); // cells are quoted again as needed
  });

  it("takes everything back out when it fails part-way", async () => {
    await db.pages.add({ id: "mine", parentId: "", kind: "page", title: "原本就有的", sort: 1, createdAt: 1, updatedAt: 1 });
    let calls = 0;
    const failing = (md: string) => {
      if (++calls === 3) throw new Error("parser blew up");
      return toBlocks(md);
    };
    await expect(importNotion(entries(current()), failing)).rejects.toThrow("parser blew up");
    expect((await db.pages.toArray()).map((p) => p.title)).toEqual(["原本就有的"]);
    expect(await db.files.count()).toBe(0);
  });

  it("reports progress from start to finish", async () => {
    const seen: number[] = [];
    await importNotion(entries(current()), toBlocks, (done, total) => seen.push(done / total));
    expect(seen.length).toBeGreaterThan(10);
    expect(seen[seen.length - 1]).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
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
