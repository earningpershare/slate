// Automatic backups to a folder on disk (File System Access API, Chromium/Edge).
// One file per day, so the folder doubles as a short day-by-day history.
import dayjs from "dayjs";
import { db, exportAll } from "../db";

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
  entries?: () => AsyncIterable<[string, FileSystemHandle]>;
};

const KEY = "backupDir";
const LAST = "backup-last";
const KEEP_DAYS = 14;
const NAME = /^slate-backup-\d{4}-\d{2}-\d{2}\.json$/;

export const backupSupported = () => "showDirectoryPicker" in window;

export async function getBackupDir(): Promise<DirHandle | null> {
  return ((await db.meta.get(KEY))?.value as DirHandle | undefined) ?? null;
}

export async function chooseBackupDir(): Promise<string> {
  const pick = (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> })
    .showDirectoryPicker;
  const dir = await pick({ mode: "readwrite", id: "slate-backup" });
  await db.meta.put({ key: KEY, value: dir });
  await runBackup(true);
  return dir.name;
}

export async function clearBackupDir() {
  await db.meta.delete(KEY);
  localStorage.removeItem(LAST);
}

export const lastBackupAt = (): number => Number(localStorage.getItem(LAST) ?? 0);

/** "granted" | "prompt" (needs a click to re-allow) | "denied" | "none" (no folder chosen) */
export async function backupState(): Promise<PermissionState | "none"> {
  const dir = await getBackupDir();
  if (!dir) return "none";
  return dir.queryPermission ? dir.queryPermission({ mode: "readwrite" }) : "granted";
}

/** Must be called from a click: browsers only show the permission prompt on a user gesture. */
export async function reallowBackup(): Promise<boolean> {
  const dir = await getBackupDir();
  if (!dir) return false;
  const state = dir.requestPermission ? await dir.requestPermission({ mode: "readwrite" }) : "granted";
  if (state === "granted") await runBackup(true);
  return state === "granted";
}

/**
 * Write today's backup file. Returns false when there is no folder or no permission.
 * Unless forced, skips when nothing changed since the last backup.
 */
export async function runBackup(force = false): Promise<boolean> {
  const dir = await getBackupDir();
  if (!dir || (await backupState()) !== "granted") return false;
  const last = lastBackupAt();
  if (!force && last) {
    const newest = Math.max(
      (await db.pages.orderBy("updatedAt").last())?.updatedAt ?? 0,
      ...(await db.tasks.toArray()).map((t) => Math.max(t.createdAt, t.completedAt ?? 0)),
    );
    if (newest <= last) return true;
  }
  const file = await dir.getFileHandle(`slate-backup-${dayjs().format("YYYY-MM-DD")}.json`, { create: true });
  const w = await file.createWritable();
  await w.write(await exportAll());
  await w.close();
  localStorage.setItem(LAST, String(Date.now()));

  // prune daily files beyond the retention window
  if (dir.entries) {
    const names: string[] = [];
    for await (const [name] of dir.entries()) if (NAME.test(name)) names.push(name);
    for (const old of names.sort().slice(0, -KEEP_DAYS)) await dir.removeEntry(old);
  }
  return true;
}
