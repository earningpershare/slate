// Signing in, and which account the data on this device belongs to.
//
// The app works without an account (everything stays on the device). Signing in
// adds one thing: this device exchanges changes with the same account's other
// devices while they are online together (lib/peers.ts).
import { useSyncExternalStore } from "react";
import type { AppDB } from "../db";
import { connectPeers, type PeerLink } from "./peers";
import { wipeLocal } from "./sync";

export interface Account {
  id: string;
  name: string;
}

export interface Session {
  /** the address this app was loaded from offers accounts */
  server: boolean;
  signup: "open" | "invite" | "closed";
  user: Account | null;
  /** other devices of this account that are online right now */
  peers: number;
  /** signed in as `user`, but the data on this device belongs to this other account */
  conflict: string | null;
  /** was signed in on this device before, and the server no longer accepts it */
  expired: boolean;
}

let state: Session = { server: false, signup: "closed", user: null, peers: 0, conflict: null, expired: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<Session>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
export const session = () => state;
export function useSession(): Session {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

const MESSAGES: Record<string, string> = {
  credentials: "帳號或密碼不正確",
  taken: "這個帳號名稱已經有人用了",
  name: "帳號要 3 到 32 個字，只能用英文字母、數字和 . _ -",
  password: "密碼至少要 8 個字",
  invite: "邀請碼不正確",
  "signup-closed": "目前不開放註冊",
  "slow-down": "嘗試太多次了，請過幾分鐘再試",
  "signed-out": "請重新登入",
};
export class ApiError extends Error {
  constructor(public code: string) {
    super(MESSAGES[code] ?? "伺服器沒有回應，請確認網路後再試");
  }
}

async function post(path: string, body: unknown): Promise<{ user?: Account }> {
  let res: Response;
  try {
    res = await fetch("/api/" + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-slate": "1" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("network");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(String(data?.error ?? "server"));
  return data;
}

// ---- which account this device's data belongs to ----

const BOUND = "sync:account";
const CACHE = "account";
const boundAccount = async (db: AppDB) => ((await db.meta.get(BOUND))?.value as Account | undefined) ?? null;
const remember = (user: Account | null) => {
  try {
    if (user) localStorage.setItem(CACHE, JSON.stringify(user));
    else localStorage.removeItem(CACHE);
  } catch {
    /* storage unavailable */
  }
};
const remembered = (): Account | null => {
  try {
    return JSON.parse(localStorage.getItem(CACHE) ?? "null");
  } catch {
    return null;
  }
};

let link: PeerLink | null = null;
const unlink = () => {
  link?.stop();
  link = null;
};

/** Start exchanging with the account's other devices, unless this device holds someone else's data. */
async function attach(db: AppDB, user: Account) {
  unlink();
  const bound = await boundAccount(db);
  if (bound && bound.id !== user.id) {
    return set({ user, conflict: bound.name, expired: false, peers: 0 });
  }
  await db.meta.put({ key: BOUND, value: user });
  remember(user);
  set({ user, conflict: null, expired: false });
  link = connectPeers(
    db,
    (peers) => set({ peers }),
    () => {
      // the stream was refused: find out whether we are still signed in
      unlink();
      void start(db);
    },
  );
}

let watching = false;

/** Ask the server who we are. Call once before the app renders. */
export async function start(db: AppDB, timeoutMs = 2500): Promise<Session> {
  if (!watching) {
    watching = true;
    // back from offline: sign-in state and the link to other devices need a fresh look
    window.addEventListener("online", () => !link && void start(db));
  }
  let info: { app?: string; signup?: Session["signup"]; user?: Account | null } | null = null;
  try {
    // offline (the installed app opened without a network): do not even ask
    if (navigator.onLine === false) throw new Error("offline");
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch("/api/info", { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    info = await res.json();
  } catch {
    info = null;
  }
  if (info?.app !== "slate") {
    // no account service here, or we are offline: keep showing who this device belongs to
    const known = remembered();
    set({ server: !!known, user: known, peers: 0, conflict: null, expired: false });
    return state;
  }
  set({ server: true, signup: info.signup ?? "closed" });
  if (info.user) await attach(db, info.user);
  else set({ user: null, peers: 0, conflict: null, expired: !!remembered() });
  return state;
}

export async function signIn(
  db: AppDB,
  mode: "login" | "register",
  name: string,
  password: string,
  invite = "",
): Promise<Session> {
  const { user } = await post(mode, { name, password, invite });
  if (!user) throw new ApiError("server");
  await attach(db, user);
  return state;
}

/**
 * Settle a conflict (signed in, but this device holds another account's data):
 * either clear the device and use it for the signed-in account, or sign back out.
 */
export async function resolveConflict(db: AppDB, clearDevice: boolean) {
  const user = state.user;
  if (!user) return;
  if (!clearDevice) return signOut(db, false);
  await wipeLocal(db);
  await db.meta.delete(BOUND);
  await attach(db, user);
}

/** Sign out. With `clearDevice`, also remove this account's data from this device. */
export async function signOut(db: AppDB, clearDevice: boolean) {
  unlink();
  await post("logout", {}).catch(() => undefined);
  remember(null);
  if (clearDevice) {
    await wipeLocal(db);
    await db.meta.delete(BOUND);
  }
  set({ user: null, peers: 0, conflict: null, expired: false });
}

export async function changePassword(current: string, next: string) {
  await post("password", { current, next });
}
