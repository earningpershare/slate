import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  createPage,
  db,
  importCsv,
  mutatePage,
  placePage,
  restorePage,
  restoreSnapshot,
  setRowProp,
  trashPage,
  updatePage,
  movePage,
  backlinks,
} from "./db";

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

const para = (text: string) => [{ type: "paragraph", content: [{ type: "text", text }], children: [] }];

describe("concurrent edits", () => {
  it("keeps every change when one property is patched several times at once", async () => {
    const id = await createDatabase(null, "db");
    const propId = (await db.pages.get(id))!.schema![0].id;
    const patch = (p: object) =>
      mutatePage(id, (cur) => ({ schema: cur.schema!.map((x) => (x.id === propId ? { ...x, ...p } : x)) }));
    await Promise.all([patch({ rollupRel: "r" }), patch({ rollupProp: "p" }), patch({ rollupCalc: "sum" })]);
    expect((await db.pages.get(id))!.schema![0]).toMatchObject({ rollupRel: "r", rollupProp: "p", rollupCalc: "sum" });
  });
  it("keeps every cell when a row is edited in several columns at once", async () => {
    const row = await createPage("db", { isRow: true });
    await Promise.all([setRowProp(row, "a", 1), setRowProp(row, "b", "x"), setRowProp(row, "c", true)]);
    expect((await db.pages.get(row))!.props).toEqual({ a: 1, b: "x", c: true });
  });
});

describe("page tree", () => {
  it("places pages before a sibling and at the end", async () => {
    const a = await createPage(null, { title: "a" });
    const b = await createPage(null, { title: "b" });
    const c = await createPage(null, { title: "c" });
    const order = async () =>
      (await db.pages.where("parentId").equals("").sortBy("sort")).map((p) => p.title).join("");
    await placePage(c, null, a);
    expect(await order()).toBe("cab");
    await placePage(c, null, null);
    expect(await order()).toBe("abc");
    await placePage(a, null, c);
    expect(await order()).toBe("bac");
    expect(b).toBeTruthy();
  });
  it("refuses to move a page under its own descendant", async () => {
    const a = await createPage(null);
    const b = await createPage(a);
    await movePage(a, b);
    expect((await db.pages.get(a))!.parentId).toBe("");
  });
  it("restores to the top level when the parent is gone", async () => {
    const a = await createPage(null);
    const b = await createPage(a);
    await trashPage(b);
    await trashPage(a);
    await restorePage(b);
    expect(await db.pages.get(b)).toMatchObject({ parentId: "", deletedAt: null });
  });
});

describe("history and links", () => {
  it("snapshots the previous content and can restore it", async () => {
    const id = await createPage(null);
    await updatePage(id, { content: para("first") });
    await updatePage(id, { content: para("second") }); // snapshots "first"
    const snaps = await db.history.where("pageId").equals(id).toArray();
    expect(snaps).toHaveLength(1);
    await restoreSnapshot(snaps[0].id);
    const page = (await db.pages.get(id))!;
    expect(page.text).toBe("first");
    // the content we replaced is itself kept, so a restore can be undone
    expect(await db.history.where("pageId").equals(id).count()).toBe(2);
  });
  it("tracks backlinks from saved content", async () => {
    const target = await createPage(null, { title: "target" });
    const source = await createPage(null, { title: "source" });
    await updatePage(source, { content: [{ type: "pageLink", props: { pageId: target }, children: [] }] });
    expect((await backlinks(target)).map((p) => p.title)).toEqual(["source"]);
    await trashPage(source);
    expect(await backlinks(target)).toEqual([]);
  });
});

describe("importCsv", () => {
  it("matches existing columns, creates new ones and adds options", async () => {
    const id = await createDatabase(null, "db");
    const n = await importCsv(id, "名稱,狀態,預算,日期\n甲,完成,100,2026/1/5\n乙,新狀態,,\n");
    expect(n).toBe(2);
    const dbPage = (await db.pages.get(id))!;
    const status = dbPage.schema!.find((p) => p.name === "狀態")!;
    const budget = dbPage.schema!.find((p) => p.name === "預算")!;
    const date = dbPage.schema!.find((p) => p.name === "日期")!;
    expect(budget.type).toBe("number");
    expect(status.options!.map((o) => o.name)).toContain("新狀態");
    const rows = await db.pages.where("parentId").equals(id).sortBy("sort");
    expect(rows.map((r) => r.title)).toEqual(["甲", "乙"]);
    expect(rows[0].props![budget.id]).toBe(100);
    expect(rows[0].props![date.id]).toBe("2026-01-05");
    expect(rows[0].props![status.id]).toBe(status.options!.find((o) => o.name === "完成")!.id);
    expect(rows[1].props![budget.id]).toBeUndefined();
  });
  it("ignores a file with only a header", async () => {
    const id = await createDatabase(null, "db");
    expect(await importCsv(id, "名稱,狀態\n")).toBe(0);
  });
});
