import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { AppDB } from "../db";
import type { Page, Task } from "../types";
import { applyChanges, manifestOf, markSent, newerThan, reconcile, unsent, wipeLocal } from "./sync";

let n = 0;
let phone: AppDB;
let laptop: AppDB;

beforeEach(() => {
  n++;
  phone = new AppDB("phone-" + n);
  laptop = new AppDB("laptop-" + n);
});

const page = (id: string, title: string): Page => ({
  id,
  parentId: "",
  kind: "page",
  title,
  createdAt: 1,
  updatedAt: 1,
  sort: 1,
});
const task = (id: string, title: string): Task => ({
  id,
  title,
  listId: null,
  done: false,
  priority: 0,
  sort: 1,
  createdAt: 1,
});
const tick = () => new Promise((r) => setTimeout(r, 5));
/** what a device does for the ones that are online: send what changed, the other applies it */
const sendLive = async (from: AppDB, to: AppDB) => {
  const changes = await unsent(from);
  const applied = await applyChanges(to, changes);
  await markSent(from, changes);
  return { sent: changes.length, applied };
};

describe("change tracking", () => {
  it("marks every local write and leaves a tombstone for every delete", async () => {
    await phone.pages.add(page("p1", "a"));
    const first = (await phone.pages.get("p1"))!;
    expect(first.dirty).toBe(1);
    await phone.pages.update("p1", { title: "b" });
    const second = (await phone.pages.get("p1"))!;
    expect(second.rev!).toBeGreaterThan(first.rev!);
    await phone.pages.delete("p1");
    await phone.tombsSettled();
    expect(await phone.tombs.get("pages:p1")).toMatchObject({ table: "pages", id: "p1", dirty: 1 });
  });

  it("does not track local-only tables", async () => {
    await phone.history.add({ id: "h1", pageId: "p1", at: 1, title: "", content: [] });
    await phone.history.delete("h1");
    await phone.tombsSettled();
    expect(await phone.tombs.count()).toBe(0);
  });
});

describe("two devices meeting", () => {
  it("each ends up with what the other had", async () => {
    await phone.pages.add(page("p1", "手機的頁面"));
    await laptop.tasks.add(task("t1", "電腦的任務"));
    expect(await reconcile(phone, laptop)).toEqual({ toA: 1, toB: 1 });
    expect((await laptop.pages.get("p1"))?.title).toBe("手機的頁面");
    expect((await phone.tasks.get("t1"))?.title).toBe("電腦的任務");
    // nothing left to exchange
    expect(await reconcile(phone, laptop)).toEqual({ toA: 0, toB: 0 });
    expect(await newerThan(phone, await manifestOf(laptop))).toEqual([]);
  });

  it("sends only what the other side lacks", async () => {
    await phone.pages.bulkAdd([page("p1", "a"), page("p2", "b"), page("p3", "c")]);
    await reconcile(phone, laptop);
    await phone.pages.update("p2", { title: "b2" });
    const diff = await newerThan(phone, await manifestOf(laptop));
    expect(diff.map((c) => c.id)).toEqual(["p2"]);
  });

  it("keeps the later edit when both changed the same record while apart", async () => {
    await phone.pages.add(page("p1", "原本"));
    await reconcile(phone, laptop);
    await phone.pages.update("p1", { title: "手機改的" });
    await tick();
    await laptop.pages.update("p1", { title: "電腦後改的" });
    await reconcile(phone, laptop);
    expect((await phone.pages.get("p1"))?.title).toBe("電腦後改的");
    expect((await laptop.pages.get("p1"))?.title).toBe("電腦後改的");
  });

  it("keeps edits to different records made on both sides", async () => {
    await phone.pages.bulkAdd([page("p1", "a"), page("p2", "b")]);
    await reconcile(phone, laptop);
    await phone.pages.update("p1", { title: "a-手機" });
    await laptop.pages.update("p2", { title: "b-電腦" });
    await reconcile(phone, laptop);
    for (const d of [phone, laptop]) {
      expect((await d.pages.get("p1"))?.title).toBe("a-手機");
      expect((await d.pages.get("p2"))?.title).toBe("b-電腦");
    }
  });

  it("carries deletions; an edit after the deletion brings the record back, an older one does not", async () => {
    await phone.pages.bulkAdd([page("p1", "a"), page("p2", "b"), page("p3", "c")]);
    await reconcile(phone, laptop);
    await phone.pages.update("p2", { title: "太早的修改" });
    await tick();
    await laptop.pages.bulkDelete(["p1", "p2", "p3"]);
    await tick();
    await phone.pages.update("p1", { title: "刪除之後又改了" });
    await reconcile(phone, laptop);
    for (const d of [phone, laptop]) {
      expect((await d.pages.get("p1"))?.title).toBe("刪除之後又改了");
      expect(await d.pages.get("p2")).toBeUndefined();
      expect(await d.pages.get("p3")).toBeUndefined();
    }
    // and it stays that way
    expect(await reconcile(phone, laptop)).toEqual({ toA: 0, toB: 0 });
  });

  it("restoring a backup over existing records does not delete them elsewhere", async () => {
    await phone.pages.bulkAdd([page("p1", "a"), page("p2", "b")]);
    await reconcile(phone, laptop);
    // what importAll does: wipe, then put back (here without p2)
    await phone.transaction("rw", phone.pages, async () => {
      await phone.pages.clear();
      await phone.pages.add(page("p1", "還原後"));
    });
    await reconcile(phone, laptop);
    expect((await laptop.pages.get("p1"))?.title).toBe("還原後");
    expect(await laptop.pages.get("p2")).toBeUndefined();
  });

  it("attachments arrive with their contents", async () => {
    await phone.files.add({ id: "f1", name: "a.png", type: "image/png", blob: new Blob(["12345"]) });
    await reconcile(phone, laptop);
    const got = (await laptop.files.get("f1"))!;
    expect(got.name).toBe("a.png");
    expect(got.blob.size).toBe(5);
  });

  it("three devices agree after meeting in pairs", async () => {
    const tablet = new AppDB("tablet-" + n);
    await phone.pages.add(page("p1", "a"));
    await laptop.pages.add(page("p2", "b"));
    await tablet.pages.add(page("p3", "c"));
    await reconcile(phone, laptop);
    await reconcile(laptop, tablet);
    await reconcile(tablet, phone);
    for (const d of [phone, laptop, tablet]) expect(await d.pages.count()).toBe(3);
  });
});

describe("while both are online", () => {
  it("sends each change once", async () => {
    await phone.pages.add(page("p1", "a"));
    expect(await sendLive(phone, laptop)).toEqual({ sent: 1, applied: 1 });
    expect(await sendLive(phone, laptop)).toEqual({ sent: 0, applied: 0 });
    await phone.pages.update("p1", { title: "b" });
    await phone.tasks.add(task("t1", "x"));
    expect(await sendLive(phone, laptop)).toEqual({ sent: 2, applied: 2 });
    // what was received is not echoed back
    expect(await unsent(laptop)).toEqual([]);
  });

  it("does not lose an edit made while a change is on its way", async () => {
    await phone.pages.add(page("p1", "v1"));
    const changes = await unsent(phone);
    await phone.pages.update("p1", { title: "v2" }); // edited again before the send finished
    await markSent(phone, changes);
    expect((await unsent(phone)).map((c) => c.data?.title)).toEqual(["v2"]);
  });

  it("ignores malformed or stale changes", async () => {
    await laptop.pages.add(page("p1", "現在的"));
    const applied = await applyChanges(laptop, [
      { table: "pages", id: "p1", rev: 1, data: { ...page("p1", "很舊的") } },
      { table: "pages", id: "p9", rev: Date.now() + 9e6 } as never, // no data
      { table: "meta" as never, id: "x", rev: Date.now() + 9e6, data: { key: "x" } },
      { table: "files", id: "f1", rev: Date.now() + 9e6, data: { name: "a", type: "b" } }, // no contents
      null as never,
    ]);
    expect(applied).toBe(0);
    expect((await laptop.pages.get("p1"))?.title).toBe("現在的");
    expect(await laptop.pages.count()).toBe(1);
    expect(await laptop.files.count()).toBe(0);
  });
});

describe("handing a device to another account", () => {
  it("wipes everything without leaving deletions to pass on", async () => {
    await phone.pages.add(page("p1", "a"));
    await phone.history.add({ id: "h1", pageId: "p1", at: 1, title: "", content: [] });
    await wipeLocal(phone);
    expect(await phone.pages.count()).toBe(0);
    expect(await phone.history.count()).toBe(0);
    expect(await manifestOf(phone)).toEqual({});
  });
});
