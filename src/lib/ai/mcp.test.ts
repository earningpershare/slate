// The MCP bridge (public/slate-mcp.mjs) is a single file people download, so it carries its
// own copy of the tool definitions. This keeps that copy identical to src/lib/ai/tools.ts.
// `npm run make-mcp` rewrites it; without that, a difference fails the test.
import "fake-indexeddb/auto";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
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
});
