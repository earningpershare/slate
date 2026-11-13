// Rewrites the tool definitions inside public/slate-mcp.mjs from src/lib/ai/tools.ts.
// Run after changing a tool's name, description or schema: npm run make-mcp
import { spawnSync } from "node:child_process";

const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "src/lib/ai/mcp.test.ts"], {
  stdio: "inherit",
  env: { ...process.env, MAKE_MCP: "1" },
});
process.exit(r.status ?? 1);
