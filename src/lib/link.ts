// Linking devices with a code, and keeping linked devices in step.
//
// There are no accounts and no server of our own. Two devices find each other through
// a public WebRTC meeting point (the PeerJS broker), then talk directly. Everything
// they say is encrypted with a key the meeting point never sees:
//
//   pairing   one device shows an 8-character code, the other types it in. Both stretch
//             the code into (meeting id, key); the first device hands over the group secret.
//   after     every linked device knows the group secret. Its meeting id and the message
//             key come from that secret, so linked devices reconnect on their own whenever
//             they are open at the same time. The code is never needed again.
//
// Messages between linked devices:
//   { t: "hello", device, members }            who I am and which devices I know of
//   { t: "manifest", m, reply }                "this is what I have" (ids and revs only);
//                                              reply: "and tell me what you have"
//   { t: "changes", changes }                  records the other side lacks or has older
//   { t: "file", change, i, n, data }          one attachment, base64 in n pieces
//   { t: "bye", device }                       this device stopped syncing: forget it
//   { t: "members", members }                  a device was just linked: here is the list
//   { t: "rekey", secret, members }            a device was removed: the group moved to a new
//                                              secret, which the removed device never gets
//
// Who may connect: only a device whose id is in the local member list. Ids get there by
// pairing with a code, or by being named by a device that is already a member.
import { liveQuery } from "dexie";
import { useSyncExternalStore } from "react";
import type { DataConnection, Peer, PeerOptions } from "peerjs";
import { type AppDB, SYNC_TABLES } from "../db";
import { applyChanges, manifestOf, markSent, newerThan, type Manifest, type SyncChange, unsent, wipeLocal } from "./sync";

export interface Device {
  id: string;
  name: string;
}
interface Group {
  secret: string;
  members: Device[]; // the other devices
}

type Msg =
  | { t: "hello"; device: Device; members: Device[] }
  | { t: "manifest"; m: Manifest; reply: boolean }
  | { t: "changes"; changes: SyncChange[] }
  | { t: "file"; change: SyncChange; i: number; n: number; data: string }
  | { t: "bye"; device: string }
  | { t: "members"; members: Device[] }
  | { t: "rekey"; secret: string; members: Device[] }
  | { t: "join"; device: Device }
  | { t: "welcome"; secret: string; members: Device[] }
  | { t: "joined" };

export interface LinkState {
  /** this device is linked with at least one other */
  linked: boolean;
  devices: (Device & { online: boolean })[];
  /** whether the meeting point can be reached right now */
  reach: "off" | "connecting" | "ready" | "unreachable";
  /** the code this device is currently showing, if any */
  code: string | null;
}

/** An error whose message can be shown to the person as is. */
export class LinkError extends Error {}

const BATCH = 400_000; // characters of JSON per message
const PIECE = 300_000; // bytes of an attachment per message
const PAIR_ROUNDS = 200_000; // slows down guessing a code
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U

// ---------- small helpers ----------

const text = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const randomHex = (bytes: number) => hex(crypto.getRandomValues(new Uint8Array(bytes)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stretch a secret into a public tag (safe to show the meeting point) and a message key. */
async function derive(secret: string, salt: string, iterations: number) {
  const base = await crypto.subtle.importKey("raw", text.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: text.encode(salt), iterations }, base, 512),
  );
  const key = await crypto.subtle.importKey("raw", bits.slice(32), "AES-GCM", false, ["encrypt", "decrypt"]);
  return { tag: hex(bits.slice(0, 16)), key };
}

async function seal(key: CryptoKey, msg: Msg): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, text.encode(JSON.stringify(msg))));
  const out = new Uint8Array(12 + body.length);
  out.set(iv);
  out.set(body, 12);
  return out;
}

/** null: not sealed with this key (a stranger, or a wrong code) */
async function unseal(key: CryptoKey, data: unknown): Promise<Msg | null> {
  try {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : null;
    if (!bytes || bytes.length < 13) return null;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    const msg = JSON.parse(new TextDecoder().decode(plain)) as Msg;
    return msg && typeof msg === "object" && typeof msg.t === "string" ? msg : null;
  } catch {
    return null;
  }
}

const isDevice = (d: unknown): d is Device =>
  !!d &&
  typeof (d as Device).id === "string" &&
  /^[0-9a-f]{16,64}$/.test((d as Device).id) &&
  typeof (d as Device).name === "string";
const tidy = (d: Device): Device => ({ id: d.id, name: d.name.slice(0, 40) });

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

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android 手機" : "Android 平板";
  if (/Windows/.test(ua)) return "Windows 電腦";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Linux/.test(ua)) return "Linux 電腦";
  return "裝置";
}

/** Where devices meet. The default is the public PeerJS broker; tests point this at their own. */
function meetingPoint(): PeerOptions {
  let custom: string | null = null;
  try {
    custom = localStorage.getItem("slate:broker");
  } catch {
    /* storage unavailable */
  }
  if (!custom) return { debug: 0 };
  const [host, port] = custom.split(":");
  return { host, port: Number(port), path: "/", secure: false, debug: 0 };
}

/** Resolves once the meeting point knows us. */
const opened = (p: Peer) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LinkError("連不上配對服務，請確認這台裝置有網路後再試一次。")), 15_000);
    p.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    p.once("error", (e) => {
      clearTimeout(timer);
      reject(
        e.type === "unavailable-id"
          ? new LinkError("這組連結碼正在使用中，請重新產生一組。")
          : new LinkError("連不上配對服務，請確認這台裝置有網路後再試一次。"),
      );
    });
  });

/** Send one sealed message, waiting first if the channel is backed up (large attachments). */
async function sendSealed(conn: DataConnection, key: CryptoKey, msg: Msg) {
  const data = await seal(key, msg);
  while (conn.open && (conn.dataChannel?.bufferedAmount ?? 0) > 4_000_000) await sleep(40);
  if (!conn.open) throw new Error("connection closed");
  await conn.send(data);
}

// ---------- state ----------

let db: AppDB;
let me: Device = { id: "", name: "" };
let group: Group | null = null;
let groupKey: CryptoKey | null = null;
let peer: Peer | null = null;
let generation = 0; // bumped on every (dis)connect, so late callbacks of an old link do nothing
let ticker: ReturnType<typeof setInterval> | undefined;
let ticks = 0;
let watch: { unsubscribe(): void } | null = null;
let sendTimer: ReturnType<typeof setTimeout> | undefined;
let pairing: { code: string; peer: Peer; timer: ReturnType<typeof setTimeout> } | null = null;

interface Live {
  conn: DataConnection;
  dialer: string; // id of the device that opened this connection
  send(msg: Msg): Promise<void>;
}
const conns = new Map<string, Live>(); // by device id; only devices that proved they hold the key
const dialing = new Set<string>();
const incoming = new Map<string, string[]>(); // attachment pieces, by sender:file id

let work: Promise<unknown> = Promise.resolve();
/** one thing at a time, in arrival order */
const queue = (job: () => Promise<unknown>) => {
  work = work.then(job).catch((e) => console.warn("sync:", e));
  return work;
};

let state: LinkState = { linked: false, devices: [], reach: "off", code: null };
let reach: LinkState["reach"] = "off";
const listeners = new Set<() => void>();
function emit() {
  state = {
    linked: !!group,
    devices: (group?.members ?? []).map((d) => ({ ...d, online: conns.has(d.id) })),
    reach,
    code: pairing?.code ?? null,
  };
  for (const l of listeners) l();
}
export function useLink(): LinkState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

async function saveGroup(g: Group | null) {
  group = g;
  if (g) await db.meta.put({ key: "link:group", value: g });
  else await db.meta.delete("link:group");
  emit();
}

async function mergeMembers(found: Device[]) {
  if (!group) return;
  let changed = false;
  const members = [...group.members];
  for (const d of found.filter(isDevice).map(tidy)) {
    if (d.id === me.id) continue;
    const at = members.findIndex((m) => m.id === d.id);
    if (at < 0) members.push(d);
    else if (members[at].name !== d.name) members[at] = d;
    else continue;
    changed = true;
  }
  if (changed) await saveGroup({ ...group, members });
}

// ---------- talking to linked devices ----------

const post = async (to: string, msg: Msg): Promise<number> => {
  const targets = to === "*" ? [...conns.values()] : conns.has(to) ? [conns.get(to)!] : [];
  let delivered = 0;
  for (const t of targets) {
    try {
      await t.send(msg);
      delivered++;
    } catch {
      /* gone: whatever was not delivered is picked up by the next exchange */
    }
  }
  return delivered;
};

/** Send changes to one device ("*" = all that are connected). Resolves to false if nobody received them. */
async function sendChanges(to: string, changes: SyncChange[]): Promise<boolean> {
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
}

async function onMessage(from: string, msg: Msg) {
  if (msg.t === "manifest") {
    // the other device told us what it has: give it whatever it lacks
    const changes = await newerThan(db, msg.m);
    if (changes.length && (await sendChanges(from, changes)) && conns.size === 1) await markSent(db, changes);
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
  } else if (msg.t === "bye") {
    if (group && msg.device === from) {
      await saveGroup({ ...group, members: group.members.filter((m) => m.id !== from) });
      conns.get(from)?.conn.close();
    }
  } else if (msg.t === "members") {
    await mergeMembers(Array.isArray(msg.members) ? msg.members : []);
    void dialMissing(generation);
  } else if (msg.t === "rekey") {
    if (!group || typeof msg.secret !== "string" || !/^[0-9a-f]{64}$/.test(msg.secret) || !Array.isArray(msg.members)) return;
    const members = msg.members.filter(isDevice).map(tidy).filter((m) => m.id !== me.id);
    if (!members.some((m) => m.id === from)) return;
    await saveGroup({ secret: msg.secret, members });
    setTimeout(() => void connect(), 0); // everyone meets again under the new secret
  }
}

/** Full exchange: used when a device appears, when the network returns, and once a minute as a safety net. */
const exchange = (to = "*") =>
  queue(async () => {
    if (conns.size === 0) return;
    await post(to, { t: "manifest", m: await manifestOf(db), reply: true });
  });

const sendUnsent = () =>
  queue(async () => {
    if (conns.size === 0) return;
    const changes = await unsent(db);
    if (changes.length && (await sendChanges("*", changes))) await markSent(db, changes);
  });

/** Take charge of a connection to (what claims to be) a linked device. */
function adopt(conn: DataConnection, outgoing: boolean, run: number) {
  const key = groupKey!;
  let them: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  const send = (msg: Msg) => {
    const sent = chain.then(() => sendSealed(conn, key, msg));
    chain = sent.catch(() => undefined);
    return sent;
  };
  const drop = () => {
    if (them && conns.get(them)?.conn === conn) {
      conns.delete(them);
      emit();
    }
    if (them) dialing.delete(them);
  };
  conn.on("open", () => {
    if (run === generation && group) void send({ t: "hello", device: me, members: group.members }).catch(() => undefined);
  });
  conn.on("data", (data) =>
    queue(async () => {
      if (run !== generation || !group) return;
      const msg = await unseal(key, data);
      if (!msg) return void conn.close(); // does not hold our key
      if (msg.t !== "hello") {
        if (them && conns.get(them)?.conn === conn) await onMessage(them, msg);
        return;
      }
      if (!isDevice(msg.device) || msg.device.id === me.id) return void conn.close();
      const id = msg.device.id;
      // holding the key is not enough: the device must also be one we were told about
      if (!group.members.some((m) => m.id === id)) return void conn.close();
      const dialer = outgoing ? me.id : id;
      const existing = conns.get(id);
      if (existing && existing.conn !== conn) {
        // both sides dialled at once: the connection opened by the smaller id stays
        const keep = me.id < id ? me.id : id;
        if (dialer !== keep) return void conn.close();
        existing.conn.close();
      }
      them = id;
      dialing.delete(id);
      conns.set(id, { conn, dialer, send });
      await mergeMembers([msg.device, ...(Array.isArray(msg.members) ? msg.members : [])]);
      emit();
      await post(id, { t: "manifest", m: await manifestOf(db), reply: true });
    }),
  );
  conn.on("close", drop);
  conn.on("error", drop);
}

async function dialMissing(run: number) {
  if (run !== generation || !group || !peer || peer.destroyed || peer.disconnected) return;
  for (const m of group.members) {
    if (conns.has(m.id) || dialing.has(m.id)) continue;
    dialing.add(m.id);
    setTimeout(() => dialing.delete(m.id), 15_000);
    const { tag } = await derive(group.secret, "slate-device:" + m.id, 1);
    if (run !== generation || !peer || peer.destroyed || peer.disconnected) return;
    adopt(peer.connect("slate-" + tag, { reliable: true }), true, run);
  }
}

function disconnect() {
  generation++;
  clearInterval(ticker);
  clearTimeout(sendTimer);
  watch?.unsubscribe();
  watch = null;
  for (const c of conns.values()) c.conn.close();
  conns.clear();
  dialing.clear();
  incoming.clear();
  peer?.destroy();
  peer = null;
  reach = "off";
  emit();
}

async function openPeer(run: number) {
  if (run !== generation || !group) return;
  reach = "connecting";
  emit();
  const { tag } = await derive(group.secret, "slate-device:" + me.id, 1);
  const { Peer } = await import("peerjs");
  if (run !== generation) return;
  peer?.destroy();
  const p = new Peer("slate-" + tag, meetingPoint());
  peer = p;
  p.on("open", () => {
    if (run !== generation) return;
    reach = "ready";
    emit();
    void dialMissing(run);
  });
  p.on("connection", (c) => {
    if (run === generation) adopt(c, false, run);
    else c.close();
  });
  p.on("disconnected", () => {
    if (run !== generation) return;
    reach = "unreachable";
    emit();
  });
  p.on("error", (e) => {
    if (run !== generation) return;
    if (e.type === "peer-unavailable") return void dialing.clear(); // that device is simply not open right now
    // "unavailable-id": this device is already connected from another tab or window
    reach = "unreachable";
    emit();
  });
}

/** Bring the link up for the current group (or down, if there is none). */
async function connect() {
  disconnect();
  if (!group) return;
  const run = generation;
  groupKey = (await derive(group.secret, "slate-group", 1)).key;
  if (run !== generation) return;

  // local edits go out as they happen
  watch = liveQuery(async () => {
    let waiting = await db.tombs.where("dirty").equals(1).count();
    for (const t of SYNC_TABLES) waiting += await db.table(t).where("dirty").equals(1).count();
    return waiting;
  }).subscribe((waiting) => {
    if (!waiting) return;
    clearTimeout(sendTimer);
    sendTimer = setTimeout(sendUnsent, 700);
  });

  const tick = () => {
    if (run !== generation) return;
    ticks++;
    if (!peer || peer.destroyed) void openPeer(run);
    else if (peer.disconnected) peer.reconnect();
    else {
      void dialMissing(run);
      if (ticks % 3 === 0) void exchange();
    }
  };
  ticker = setInterval(tick, 20_000);
  await openPeer(run);
}

// ---------- public ----------

let started = false;
/** Called once at startup: reconnects to the devices this one is already linked with. */
export async function startLink(database: AppDB) {
  if (started) return;
  started = true;
  db = database;
  const saved = (await db.meta.get("link:device"))?.value as Device | undefined;
  if (saved && isDevice(saved)) me = saved;
  else {
    me = { id: randomHex(12), name: deviceName() };
    await db.meta.put({ key: "link:device", value: me });
  }
  const g = (await db.meta.get("link:group"))?.value as Group | undefined;
  group = g && typeof g.secret === "string" && Array.isArray(g.members) ? g : null;
  emit();
  window.addEventListener("online", () => {
    if (!group) return;
    if (!peer || peer.destroyed) void openPeer(generation);
    else if (peer.disconnected) peer.reconnect();
    void exchange();
  });
  if (group) void connect();
}

/** Remember what the sample content looked like, so an untouched device can be told apart later. */
export async function rememberSeed(database: AppDB) {
  await database.meta.put({ key: "link:seed", value: await manifestOf(database) });
}
async function untouchedSeed(): Promise<boolean> {
  const seed = (await db.meta.get("link:seed"))?.value as Manifest | undefined;
  if (!seed) return false;
  const now = await manifestOf(db);
  const keys = Object.keys(now);
  return keys.length === Object.keys(seed).length && keys.every((k) => seed[k] === now[k]);
}

export function cancelPairing() {
  if (!pairing) return;
  clearTimeout(pairing.timer);
  pairing.peer.destroy();
  pairing = null;
  emit();
}

const formatCode = (c: string) => c.slice(0, 4) + "-" + c.slice(4);
const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Show a code on this device; resolves with it once the other device can use it. */
export async function beginPairing(): Promise<string> {
  cancelPairing();
  const pick = crypto.getRandomValues(new Uint8Array(8));
  const code = Array.from(pick, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  const { tag, key } = await derive(code, "slate-pair", PAIR_ROUNDS);
  const { Peer } = await import("peerjs");
  const p = new Peer("slate-pair-" + tag, meetingPoint());
  try {
    await opened(p);
  } catch (e) {
    p.destroy();
    throw e;
  }
  pairing = { code: formatCode(code), peer: p, timer: setTimeout(cancelPairing, 10 * 60_000) };
  p.on("connection", (c) => {
    let done = false;
    c.on("data", async (data) => {
      const msg = await unseal(key, data);
      if (done) return;
      if (!msg || msg.t !== "join" || !isDevice(msg.device)) return void c.close(); // wrong code
      done = true;
      const joiner = tidy(msg.device);
      const wasLinked = !!group;
      const g: Group = group ?? { secret: randomHex(32), members: [] };
      const others = g.members.filter((m) => m.id !== joiner.id);
      try {
        await sendSealed(c, key, { t: "welcome", secret: g.secret, members: [me, ...others] });
      } catch {
        done = false;
        return;
      }
      await saveGroup({ secret: g.secret, members: [...others, joiner] });
      await sleep(1500); // let the answer arrive before the pairing channel goes away
      cancelPairing();
      if (wasLinked) {
        // tell the devices already linked, so they accept the new one
        void queue(() => post("*", { t: "members", members: [...others, joiner] }));
        void dialMissing(generation);
      } else void connect();
    });
  });
  emit();
  return pairing.code;
}

/**
 * Link this device using a code shown on another one.
 * Resolves to true when this device only held untouched sample content, which was dropped
 * so the two devices do not end up with the sample pages twice.
 */
export async function joinWithCode(input: string): Promise<boolean> {
  const code = normalizeCode(input);
  if (code.length !== 8) throw new LinkError("連結碼是 8 個字元，請再確認一次。");
  cancelPairing();
  const { tag, key } = await derive(code, "slate-pair", PAIR_ROUNDS);
  const { Peer } = await import("peerjs");
  const p = new Peer(meetingPoint());
  try {
    await opened(p);
    const notFound = new LinkError("找不到這組連結碼。請確認另一台裝置還停在顯示連結碼的畫面，而且輸入無誤。");
    const c = p.connect("slate-pair-" + tag, { reliable: true });
    const welcome = await new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new LinkError("兩台裝置連不起來。請讓兩台連上同一個 Wi-Fi 後再試一次。")),
        25_000,
      );
      const fail = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      p.on("error", (e) => fail(e.type === "peer-unavailable" ? notFound : new LinkError("連線中斷，請再試一次。")));
      c.on("open", () => void sendSealed(c, key, { t: "join", device: me }).catch(() => undefined));
      c.on("data", async (data) => {
        const msg = await unseal(key, data);
        clearTimeout(timer);
        if (msg) resolve(msg);
        else reject(notFound);
      });
      c.on("close", () => fail(notFound));
    });
    if (welcome.t !== "welcome" || typeof welcome.secret !== "string" || !Array.isArray(welcome.members)) throw notFound;
    const replaced = await untouchedSeed();
    if (replaced) await wipeLocal(db);
    await db.meta.delete("link:seed");
    await sendSealed(c, key, { t: "joined" }).catch(() => undefined);
    await saveGroup({
      secret: welcome.secret,
      members: welcome.members.filter(isDevice).map(tidy).filter((m) => m.id !== me.id),
    });
    void connect();
    return replaced;
  } finally {
    setTimeout(() => p.destroy(), 500);
  }
}

/**
 * Cut one device off (lost phone, sold laptop). The group moves to a new secret that the
 * removed device never receives, so it can no longer connect or pose as another device.
 * Only devices connected right now get the new secret; resolves to how many of the
 * remaining devices were missed and must be linked again with a code.
 */
export async function removeDevice(id: string): Promise<number> {
  if (!group) return 0;
  const remaining = group.members.filter((m) => m.id !== id);
  const secret = randomHex(32);
  const reached: Device[] = [];
  await queue(async () => {
    // only those connected right now can be told; the rest are left on the old secret
    const online = remaining.filter((m) => conns.has(m.id));
    for (const m of online) {
      if (await post(m.id, { t: "rekey", secret, members: [me, ...online.filter((r) => r.id !== m.id)] })) reached.push(m);
    }
  });
  await sleep(500); // let the new secret leave before the old connections are closed
  if (reached.length === 0) {
    disconnect();
    await saveGroup(null);
  } else {
    await saveGroup({ secret, members: reached });
    await connect();
  }
  return remaining.length - reached.length;
}

/** Stop syncing on this device. Its data stays; the other devices forget it. */
export async function unlink() {
  cancelPairing();
  await queue(() => post("*", { t: "bye", device: me.id }));
  await sleep(200);
  disconnect();
  await saveGroup(null);
}
