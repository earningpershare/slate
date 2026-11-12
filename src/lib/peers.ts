// Live link to the other devices of the signed-in account, through the relay in
// server/slate-server.mjs. The relay only passes messages on; it keeps nothing.
//
// Messages between devices:
//   { t: "manifest", m, reply }                "this is what I have" (ids and revs only);
//                                              reply: "and tell me what you have"
//   { t: "changes", changes }                  records the other side lacks or has older
//   { t: "file", change, i, n, data }          one attachment, base64 in n pieces
import { liveQuery } from "dexie";
import { type AppDB, SYNC_TABLES } from "../db";
import { applyChanges, manifestOf, markSent, newerThan, type Manifest, type SyncChange, unsent } from "./sync";

type Msg =
  | { t: "manifest"; m: Manifest; reply: boolean }
  | { t: "changes"; changes: SyncChange[] }
  | { t: "file"; change: SyncChange; i: number; n: number; data: string };

export interface PeerLink {
  stop(): void;
}

const BATCH = 400_000; // characters of JSON per message
const PIECE = 300_000; // bytes of an attachment per message

const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(parts: string[], type: string): Blob {
  return new Blob(
    parts.map((p) => Uint8Array.from(atob(p), (c) => c.charCodeAt(0))),
    { type },
  );
}

/**
 * Connect to the account's other devices and keep this one in step with them.
 * `onPeers` reports how many other devices are online; `onSignedOut` fires when
 * the server no longer accepts this device's session.
 */
export function connectPeers(
  db: AppDB,
  onPeers: (count: number) => void,
  onSignedOut: () => void,
): PeerLink {
  const me = randomId();
  let stopped = false;
  let known = new Set<string>();
  const incoming = new Map<string, string[]>(); // attachment pieces, by sender:file id
  let work: Promise<unknown> = Promise.resolve();
  /** one thing at a time, in arrival order */
  const queue = (job: () => Promise<unknown>) => {
    work = work.then(job).catch((e) => console.warn("sync:", e));
    return work;
  };

  const post = async (to: string, msg: Msg): Promise<number> => {
    try {
      const res = await fetch(`/api/relay/send?from=${me}&to=${encodeURIComponent(to)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-slate": "1" },
        body: JSON.stringify(msg),
      });
      if (!res.ok) return 0;
      return ((await res.json()) as { delivered: number }).delivered;
    } catch {
      return 0; // offline: whatever was not delivered is picked up by the next exchange
    }
  };

  /** Send changes to one device ("*" = all that are online). Resolves to false if nobody received them. */
  const sendChanges = async (to: string, changes: SyncChange[]): Promise<boolean> => {
    let reached = true;
    let batch: SyncChange[] = [];
    let size = 0;
    const flush = async () => {
      if (batch.length && !(await post(to, { t: "changes", changes: batch }))) reached = false;
      batch = [];
      size = 0;
    };
    for (const c of changes) {
      if (c.blob) {
        await flush();
        const { blob, ...change } = c;
        const n = Math.max(1, Math.ceil(blob.size / PIECE));
        for (let i = 0; i < n; i++) {
          const data = await toBase64(blob.slice(i * PIECE, (i + 1) * PIECE));
          if (!(await post(to, { t: "file", change, i, n, data }))) reached = false;
        }
        continue;
      }
      const len = JSON.stringify(c).length;
      if (size + len > BATCH) await flush();
      batch.push(c);
      size += len;
    }
    await flush();
    return reached;
  };

  const onMessage = async (from: string, msg: Msg) => {
    if (msg.t === "manifest") {
      // the other device told us what it has: give it whatever it lacks
      const changes = await newerThan(db, msg.m);
      if (changes.length && (await sendChanges(from, changes)) && known.size === 1) await markSent(db, changes);
      if (msg.reply) await post(from, { t: "manifest", m: await manifestOf(db), reply: false });
    } else if (msg.t === "changes") {
      await applyChanges(db, msg.changes);
    } else if (msg.t === "file") {
      const key = from + ":" + msg.change.id;
      const parts = msg.i === 0 ? [] : (incoming.get(key) ?? []);
      if (parts.length !== msg.i) return void incoming.delete(key); // a piece went missing: the next meeting resends it
      parts.push(msg.data);
      if (parts.length < msg.n) return void incoming.set(key, parts);
      incoming.delete(key);
      const type = String((msg.change.data as { type?: string } | undefined)?.type ?? "");
      await applyChanges(db, [{ ...msg.change, blob: fromBase64(parts, type) }]);
    }
  };

  // ---- local edits go out as they happen ----
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sendUnsent = () =>
    queue(async () => {
      if (stopped || known.size === 0) return;
      const changes = await unsent(db);
      if (changes.length && (await sendChanges("*", changes))) await markSent(db, changes);
    });
  const watch = liveQuery(async () => {
    let waiting = await db.tombs.where("dirty").equals(1).count();
    for (const t of SYNC_TABLES) waiting += await db.table(t).where("dirty").equals(1).count();
    return waiting;
  }).subscribe((waiting) => {
    if (!waiting) return;
    clearTimeout(timer);
    timer = setTimeout(sendUnsent, 700);
  });

  // Full exchange with everyone online. Done when a device appears, when the network
  // comes back, and once a minute as a safety net for anything that got lost on the way.
  const exchange = (to = "*") =>
    queue(async () => {
      if (stopped || known.size === 0) return;
      await post(to, { t: "manifest", m: await manifestOf(db), reply: true });
    });
  const safety = setInterval(() => void exchange(), 60_000);
  const backOnline = () => void exchange();
  window.addEventListener("online", backOnline);

  // ---- the stream from the relay ----
  const es = new EventSource("/api/relay/events?peer=" + me);
  es.addEventListener("peers", (e) => {
    const now = new Set(JSON.parse((e as MessageEvent).data) as string[]);
    const joined = [...now].filter((p) => !known.has(p));
    known = now;
    onPeers(now.size);
    for (const p of joined) void exchange(p);
  });
  es.addEventListener("msg", (e) => {
    const { from, msg } = JSON.parse((e as MessageEvent).data) as { from: string; msg: Msg };
    queue(() => onMessage(from, msg));
  });
  es.onerror = () => {
    known = new Set();
    onPeers(0);
    // CLOSED means the browser gave up, which happens when the server refuses us (signed out);
    // a dropped connection stays CONNECTING and is retried by the browser itself
    if (es.readyState === EventSource.CLOSED && !stopped) onSignedOut();
  };

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearInterval(safety);
      window.removeEventListener("online", backOnline);
      watch.unsubscribe();
      es.close();
      onPeers(0);
    },
  };
}
