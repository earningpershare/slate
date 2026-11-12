// Slate as a web service: serves the built app, signs people in, and passes sync
// messages between the devices of one account while they are online together.
// It never stores anyone's notes: what a device sends is handed straight to that
// account's other connected devices and then forgotten. No dependencies.
//
//   node server/slate-server.mjs                    start the service
//   node server/slate-server.mjs users              list accounts
//   node server/slate-server.mjs passwd <name>      set a new password (prints a temporary one)
//   node server/slate-server.mjs remove <name>      delete an account
//
// Environment:
//   PORT=5183              SLATE_DATA=./server-data     where accounts.json lives
//   SLATE_SIGNUP=open      open | invite | closed       who may create an account
//   SLATE_INVITE=...       the code new people must enter when SLATE_SIGNUP=invite
//   SLATE_SECURE=1         mark the session cookie HTTPS-only (set this when served over HTTPS)
//   SLATE_TRUST_PROXY=1    take the visitor's address from X-Forwarded-For (behind a reverse proxy)
//
// On the public internet this must sit behind HTTPS (a reverse proxy or a hosting
// platform that terminates TLS): passwords and notes travel in the request body.
//
// The only file written is accounts.json: names, scrypt password hashes, sessions.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const DATA = path.resolve(process.env.SLATE_DATA ?? path.join(ROOT, "server-data"));
const ACCOUNTS = path.join(DATA, "accounts.json");
const PORT = Number(process.env.PORT ?? 5183);
const SIGNUP = ["open", "invite", "closed"].includes(process.env.SLATE_SIGNUP ?? "") ? process.env.SLATE_SIGNUP : "open";
const INVITE = process.env.SLATE_INVITE ?? "";
const MAX_MESSAGE = 16 * 1024 * 1024; // one relayed message
const SECURE = process.env.SLATE_SECURE === "1";
const TRUST_PROXY = process.env.SLATE_TRUST_PROXY === "1";
const SESSION_DAYS = 180;
const COOKIE = "slate_session";
const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 5 };

fs.mkdirSync(DATA, { recursive: true });

// ---------- files on disk ----------

const writeAtomic = (file, data) => {
  fs.writeFileSync(file + ".tmp", data);
  fs.renameSync(file + ".tmp", file); // replaced in one step: a crash cannot leave half a file
};

const readJson = (file, fallback) => {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // never carry on as if a file we cannot read were empty
    const kept = file + ".unreadable-" + Date.now();
    fs.renameSync(file, kept);
    console.log("無法讀取 " + file + "，已另存為 " + kept);
    return fallback;
  }
};

/** @type {{ serverId: string, users: Record<string, any>, sessions: Record<string, { user: string, expires: number }> }} */
const accounts = readJson(ACCOUNTS, { serverId: crypto.randomUUID(), users: {}, sessions: {} });
const saveAccounts = () => writeAtomic(ACCOUNTS, JSON.stringify(accounts));

// ---------- devices online right now ----------

/** userId -> (peerId -> open event stream). Lives in memory only. */
const online = new Map();
const peersOf = (userId) => online.get(userId) ?? new Map();
const emit = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
/** Tell every device of this account which other devices are connected. */
const announce = (userId) => {
  const peers = peersOf(userId);
  for (const [id, res] of peers) emit(res, "peers", [...peers.keys()].filter((p) => p !== id));
};

// ---------- accounts ----------

const cleanName = (raw) => String(raw ?? "").trim().toLowerCase();
const NAME_OK = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const findUser = (name) => Object.values(accounts.users).find((u) => u.name === name);

async function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = await scrypt(password, Buffer.from(salt, "hex"), 64, SCRYPT);
  return { salt, hash: hash.toString("hex") };
}
async function passwordMatches(user, password) {
  const { hash } = await hashPassword(password, user.salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(user.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// compared against when the name does not exist, so a miss takes as long as a wrong password
const decoy = await hashPassword(crypto.randomBytes(16).toString("hex"));

const tokenHash = (token) => crypto.createHash("sha256").update(token).digest("hex");

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  accounts.sessions[tokenHash(token)] = { user: userId, expires: Date.now() + SESSION_DAYS * 86_400_000 };
  saveAccounts();
  res.setHeader(
    "set-cookie",
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${SECURE ? "; Secure" : ""}`,
  );
}
const sessionToken = (req) =>
  (req.headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === COOKIE)?.[1] ?? "";

function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const key = tokenHash(token);
  const s = accounts.sessions[key];
  if (!s) return null;
  if (s.expires < Date.now() || !accounts.users[s.user]) {
    delete accounts.sessions[key];
    saveAccounts();
    return null;
  }
  return accounts.users[s.user];
}
const endSessions = (userId, exceptTokenHash) => {
  for (const [k, s] of Object.entries(accounts.sessions)) {
    if (s.user === userId && k !== exceptTokenHash) delete accounts.sessions[k];
  }
};

// Too many wrong passwords (per address and per name) or sign-ups (per address): wait before trying again.
const attempts = new Map();
const tooMany = (key, limit, windowMs) => {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.until < now) return false;
  return a.count >= limit;
};
const strike = (key, windowMs) => {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || a.until < now) attempts.set(key, { count: 1, until: now + windowMs });
  else a.count++;
};
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (a.until < now) attempts.delete(k);
  let dropped = false;
  for (const [k, s] of Object.entries(accounts.sessions)) {
    if (s.expires < now) {
      delete accounts.sessions[k];
      dropped = true;
    }
  }
  if (dropped) saveAccounts();
}, 10 * 60_000).unref();

// ---------- http helpers ----------

const addressOf = (req) =>
  (TRUST_PROXY && String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()) || req.socket.remoteAddress || "?";

const send = (res, status, body, headers = {}) => {
  const raw = typeof body === "string" || Buffer.isBuffer(body);
  res.writeHead(status, {
    "content-type": raw ? "text/plain; charset=utf-8" : "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(raw ? body : JSON.stringify(body));
};
const fail = (status, error) => Object.assign(new Error(error), { status, code: error });

const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(fail(413, "too-large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
const readJsonBody = async (req, limit = 64 * 1024) => {
  try {
    return JSON.parse((await readBody(req, limit)).toString("utf8")) ?? {};
  } catch (e) {
    throw e.status ? e : fail(400, "bad-json");
  }
};

// ---------- API ----------

const publicUser = (u) => (u ? { id: u.id, name: u.name } : null);

async function api(req, res, url) {
  const route = url.pathname.slice("/api/".length);
  const method = req.method ?? "GET";

  if (route === "info" && method === "GET") {
    return send(res, 200, { app: "slate", serverId: accounts.serverId, signup: SIGNUP, user: publicUser(currentUser(req)) });
  }

  // Everything below changes or reveals something. Browsers only attach this header to
  // same-origin script requests, so a page on another site cannot make these calls for you.
  // (The event stream is exempt: EventSource cannot set headers, it only reads, and the
  // SameSite=Strict session cookie is not sent along with requests from other sites.)
  if (req.headers["x-slate"] !== "1" && route !== "relay/events") throw fail(400, "header");
  const ip = addressOf(req);

  if (route === "register" && method === "POST") {
    if (SIGNUP === "closed") throw fail(403, "signup-closed");
    if (tooMany("reg:" + ip, 10)) throw fail(429, "slow-down");
    const body = await readJsonBody(req);
    const name = cleanName(body.name);
    const password = String(body.password ?? "");
    if (SIGNUP === "invite") {
      const given = Buffer.from(String(body.invite ?? ""));
      const want = Buffer.from(INVITE);
      if (!INVITE || given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
        strike("reg:" + ip, 3_600_000);
        throw fail(403, "invite");
      }
    }
    if (!NAME_OK.test(name)) throw fail(400, "name");
    if (password.length < 8 || password.length > 200) throw fail(400, "password");
    if (findUser(name)) throw fail(409, "taken");
    strike("reg:" + ip, 3_600_000);
    const user = { id: crypto.randomBytes(12).toString("hex"), name, createdAt: Date.now(), ...(await hashPassword(password)) };
    accounts.users[user.id] = user;
    startSession(res, user.id);
    return send(res, 200, { user: publicUser(user) });
  }

  if (route === "login" && method === "POST") {
    const body = await readJsonBody(req);
    const name = cleanName(body.name);
    const keys = ["login:" + ip, "login:" + name];
    // strict per account; looser per address, which many people may share
    if (tooMany(keys[0], 40) || tooMany(keys[1], 8)) throw fail(429, "slow-down");
    const user = findUser(name);
    const ok = await passwordMatches(user ?? decoy, String(body.password ?? ""));
    if (!user || !ok) {
      for (const k of keys) strike(k, 5 * 60_000);
      throw fail(401, "credentials"); // same answer whether the name or the password was wrong
    }
    startSession(res, user.id);
    return send(res, 200, { user: publicUser(user) });
  }

  if (route === "logout" && method === "POST") {
    const token = sessionToken(req);
    if (token && accounts.sessions[tokenHash(token)]) {
      delete accounts.sessions[tokenHash(token)];
      saveAccounts();
    }
    res.setHeader("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${SECURE ? "; Secure" : ""}`);
    return send(res, 200, { ok: true });
  }

  const user = currentUser(req);
  if (!user) throw fail(401, "signed-out");

  if (route === "password" && method === "POST") {
    const body = await readJsonBody(req);
    const key = "login:" + user.name;
    if (tooMany(key, 8)) throw fail(429, "slow-down");
    if (!(await passwordMatches(user, String(body.current ?? "")))) {
      strike(key, 5 * 60_000);
      throw fail(401, "credentials");
    }
    const next = String(body.next ?? "");
    if (next.length < 8 || next.length > 200) throw fail(400, "password");
    Object.assign(user, await hashPassword(next));
    endSessions(user.id, tokenHash(sessionToken(req))); // every other device has to sign in again
    saveAccounts();
    const mine = url.searchParams.get("peer");
    for (const [id, stream] of peersOf(user.id)) if (id !== mine) stream.end();
    return send(res, 200, { ok: true });
  }

  // ----- relay: only ever between the devices of the signed-in account -----

  if (route === "relay/events" && method === "GET") {
    const peer = url.searchParams.get("peer") ?? "";
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(peer)) throw fail(400, "peer");
    let peers = online.get(user.id);
    if (!peers) online.set(user.id, (peers = new Map()));
    if (peers.size >= 16 && !peers.has(peer)) throw fail(429, "too-many-devices");
    peers.get(peer)?.end();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "x-accel-buffering": "no", // ask reverse proxies not to hold the stream back
      connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    peers.set(peer, res);
    announce(user.id);
    const beat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(beat);
      if (peers.get(peer) === res) {
        peers.delete(peer);
        if (!peers.size) online.delete(user.id);
        announce(user.id);
      }
    });
    return;
  }

  if (route === "relay/send" && method === "POST") {
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "*";
    const peers = peersOf(user.id);
    if (!peers.has(from)) throw fail(409, "not-connected");
    const raw = (await readBody(req, MAX_MESSAGE)).toString("utf8");
    try {
      JSON.parse(raw);
    } catch {
      throw fail(400, "bad-json");
    }
    let delivered = 0;
    for (const [id, target] of peers) {
      if (id === from || (to !== "*" && to !== id)) continue;
      // forwarded as received and not kept anywhere
      target.write(`event: msg\ndata: {"from":${JSON.stringify(from)},"msg":${raw}}\n\n`);
      delivered++;
    }
    return send(res, 200, { delivered });
  }

  throw fail(404, "route");
}

// ---------- the app itself ----------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function serveStatic(res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, "bad path");
  }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(DIST, rel);
  if (!file.startsWith(DIST + path.sep)) return send(res, 403, "forbidden");
  fs.readFile(file, (err, data) => {
    if (err) {
      if (!fs.existsSync(path.join(DIST, "index.html"))) return send(res, 503, "還沒有建置程式：請先執行 npm run build");
      return send(res, 404, "not found");
    }
    send(res, 200, data, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      // hashed assets never change; everything else is re-checked so updates show up
      "cache-control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
  });
}

// ---------- command line ----------

const [command, arg] = process.argv.slice(2);
if (command === "users") {
  const list = Object.values(accounts.users);
  if (!list.length) console.log("還沒有任何帳號");
  for (const u of list) {
    console.log(`${u.name.padEnd(24)} 建立於 ${new Date(u.createdAt).toLocaleDateString("zh-TW")}`);
  }
  process.exit(0);
}
if (command === "passwd" || command === "remove") {
  const user = findUser(cleanName(arg));
  if (!user) {
    console.log("找不到帳號：" + (arg ?? ""));
    process.exit(1);
  }
  if (command === "passwd") {
    const temp = crypto.randomBytes(9).toString("base64url");
    Object.assign(user, await hashPassword(temp));
    endSessions(user.id);
    saveAccounts();
    console.log(`「${user.name}」的新密碼：${temp}　（請對方登入後到設定裡改掉；服務若正在執行需要重新啟動才會生效）`);
  } else {
    endSessions(user.id);
    delete accounts.users[user.id];
    saveAccounts();
    console.log(`已刪除帳號「${user.name}」（它的筆記只存在對方自己的裝置上，不受影響；服務若正在執行需要重新啟動才會生效）`);
  }
  process.exit(0);
}
if (command) {
  console.log("不認得的指令：" + command + "（可用：users、passwd <帳號>、remove <帳號>）");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname.startsWith("/api/")) {
    return void api(req, res, url).catch((e) => {
      if (!e.status) console.log("error", url.pathname, e);
      if (!res.headersSent) send(res, e.status ?? 500, { error: e.code ?? "server" });
      else res.end();
    });
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "method");
  serveStatic(res, url.pathname);
});
server.on("error", (e) => {
  console.log(e.code === "EADDRINUSE" ? `連接埠 ${PORT} 已經被占用：Slate 可能已經在執行。` : String(e));
  process.exit(1);
});
server.listen(PORT, () => {
  console.log(`Slate 服務已啟動：http://localhost:${PORT}`);
  console.log(`  註冊：${{ open: "開放", invite: "需要邀請碼", closed: "關閉" }[SIGNUP]}　帳號檔：${ACCOUNTS}`);
  console.log(`  筆記內容不會存在這裡，只在同一個帳號的裝置之間轉送。`);
  if (SIGNUP === "invite" && !INVITE) console.log("  注意：SLATE_SIGNUP=invite 但沒有設定 SLATE_INVITE，目前沒有人能註冊。");
});
