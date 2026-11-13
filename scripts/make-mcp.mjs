// Refreshes everything people download to connect an MCP client to Slate:
//   public/slate-mcp.mjs   the bridge, with the tool definitions from src/lib/ai/tools.ts written into it
//   public/slate.mcpb      the same bridge packed as a Claude Desktop extension (double-click to install)
// Run after changing a tool's name, description or schema, or the bridge itself: npm run make-mcp
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import zlib from "node:zlib";

const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "src/lib/ai/mcp.test.ts"], {
  stdio: "inherit",
  env: { ...process.env, MAKE_MCP: "1" },
});
if (r.status) process.exit(r.status);

const bridge = fs.readFileSync("public/slate-mcp.mjs", "utf8").replace(/\r\n/g, "\n");
const tools = JSON.parse(/const TOOLS = (\[[\s\S]*?\]);\n\/\* TOOLS-END/.exec(bridge)[1]);
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;

// https://github.com/anthropics/mcpb/blob/main/MANIFEST.md
const manifest = {
  manifest_version: "0.3",
  name: "slate",
  display_name: "Slate",
  version,
  description: "Let Claude work in your Slate workspace: find, read and change your notes, databases and tasks.",
  long_description:
    "Slate is an offline notes, database and task workspace that lives in your browser. This extension lets Claude act in it: search and read pages, write and reorganise notes, fill in databases, add and reschedule tasks.\n\nIt stores nothing itself. It passes each request to the Slate tab open on this computer, which carries it out and asks you before anything is deleted. After installing, tell Claude \"connect my Slate\" and open the link it gives you.",
  author: { name: "Slate (open source)", url: "https://github.com/earningpershare/slate" },
  homepage: "https://slate.16888u.com/",
  repository: { type: "git", url: "https://github.com/earningpershare/slate" },
  license: "GPL-3.0-only",
  icon: "icon.png",
  server: {
    type: "node",
    entry_point: "server/slate-mcp.mjs",
    mcp_config: { command: "node", args: ["${__dirname}/server/slate-mcp.mjs"], env: {} },
  },
  tools: [
    { name: "slate_connect", description: "Give the link that connects Slate in the browser to Claude on this computer." },
    ...tools.map((t) => ({ name: t.name, description: t.description.split(". ")[0].replace(/\.$/, "") + "." })),
  ],
  keywords: ["notes", "tasks", "database", "productivity"],
  compatibility: { platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=18.0.0" } },
};

/** A zip archive with deflated entries and fixed timestamps, so the same input always gives the same file. */
function zip(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const DATE = ((2025 - 1980) << 9) | (1 << 5) | 1; // 2025-01-01
  const parts = [];
  const dir = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const raw = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const body = zlib.deflateRawSync(raw, { level: 9 });
    const n = Buffer.from(name);
    const head = (signature, extra) => {
      const b = Buffer.alloc(extra);
      b.writeUInt32LE(signature, 0);
      return b;
    };
    const local = head(0x04034b50, 30);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DATE, 12);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = head(0x02014b50, 46);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DATE, 14);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, n, body);
    dir.push(central, n);
    offset += 30 + n.length + body.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(dir.length / 2, 8);
  end.writeUInt16LE(dir.length / 2, 10);
  end.writeUInt32LE(dir.reduce((a, d) => a + d.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...dir, end]);
}

fs.writeFileSync(
  "public/slate.mcpb",
  zip({
    "manifest.json": JSON.stringify(manifest, null, 2) + "\n",
    "server/slate-mcp.mjs": bridge,
    "icon.png": fs.readFileSync("public/icon-512.png"),
  }),
);
console.log(`wrote public/slate.mcpb (${fs.statSync("public/slate.mcpb").size} bytes, ${manifest.tools.length} tools, version ${version})`);
