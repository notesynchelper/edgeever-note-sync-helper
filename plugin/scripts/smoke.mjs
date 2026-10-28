import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// The sources are TypeScript with extension-less imports, so bundle the smoke
// entry for Node instead of asking Node to resolve them itself.
const dir = await mkdtemp(join(tmpdir(), "edgeever-smoke-"));
const outfile = join(dir, "smoke.mjs");

try {
  await build({
    entryPoints: [new URL("./smoke.ts", import.meta.url).pathname],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    logLevel: "warning",
    // Node-targeted dependencies keep their CommonJS `require` calls; give the
    // ESM bundle a real require so those still resolve.
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  });
  const module = await import(pathToFileURL(outfile).href);
  await module.main();
} finally {
  await rm(dir, { recursive: true, force: true });
}
