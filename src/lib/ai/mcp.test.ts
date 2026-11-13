// The MCP bridge (public/slate-mcp.mjs) is a single file people download, so it carries its
// own copy of the tool definitions. This keeps that copy identical to src/lib/ai/tools.ts.
// `npm run make-mcp` rewrites it; without that, a difference fails the test.
import "fake-indexeddb/auto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { unzip } from "../importers";
import { slateTools } from "./tools";

const FILE = "public/slate-mcp.mjs";
const BEGIN = "/* TOOLS-BEGIN (generated from src/lib/ai/tools.ts by `npm run make-mcp`; do not edit by hand) */";
const END = "/* TOOLS-END */";

const wanted = slateTools({ toBlocks: () => [], toMarkdown: () => "" }).map((t) => ({
  name: t.name,
  description: t.description,
  schema: t.schema,
  ...(t.danger ? { danger: true } : {}),
}));

describe("the MCP bridge file", () => {
  it("offers exactly the tools the app has", () => {
    const source = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
    const a = source.indexOf(BEGIN);
    const b = source.indexOf(END);
    expect(a >= 0 && b > a).toBe(true);
    const block = `${BEGIN}\nconst TOOLS = ${JSON.stringify(wanted, null, 1)};\n`;
    if (process.env.MAKE_MCP) {
      fs.writeFileSync(FILE, source.slice(0, a) + block + source.slice(b));
      return;
    }
    expect(source.slice(a, b), "public/slate-mcp.mjs is out of date: run `npm run make-mcp`").toBe(block);
  });

  it("is what the Claude Desktop extension contains", async () => {
    if (process.env.MAKE_MCP) return; // being rebuilt right now
    const files = new Map((await unzip(new Uint8Array(fs.readFileSync("public/slate.mcpb")))).map((e) => [e.name, e.data]));
    expect([...files.keys()].sort()).toEqual(["icon.png", "manifest.json", "server/slate-mcp.mjs"]);
    const bridge = fs.readFileSync(FILE, "utf8").replace(/\r\n/g, "\n");
    expect(new TextDecoder().decode(files.get("server/slate-mcp.mjs")), "public/slate.mcpb is out of date: run `npm run make-mcp`").toBe(bridge);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")));
    expect(manifest).toMatchObject({
      manifest_version: "0.3",
      name: "slate",
      author: { name: expect.any(String) },
      icon: "icon.png",
      server: { type: "node", entry_point: "server/slate-mcp.mjs", mcp_config: { command: "node", args: ["${__dirname}/server/slate-mcp.mjs"] } },
    });
    expect(manifest.version).toBe(JSON.parse(fs.readFileSync("package.json", "utf8")).version);
    expect(manifest.tools.map((t: { name: string }) => t.name)).toEqual(["slate_connect", ...wanted.map((t) => t.name)]);
    expect(Buffer.from(files.get("icon.png")!).subarray(1, 4).toString()).toBe("PNG");
  });
});
