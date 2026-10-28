import { build } from "esbuild";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";

const pluginDir = new URL("..", import.meta.url);
const repoRoot = new URL("../../", import.meta.url);
const manifestUrl = new URL("manifest.json", repoRoot);
const packageUrl = new URL("package.json", pluginDir);
const distUrl = new URL("dist/", pluginDir);

const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const pkg = JSON.parse(await readFile(packageUrl, "utf8"));

if (manifest.version !== pkg.version) {
  throw new Error(`manifest.json version ${manifest.version} does not match package.json version ${pkg.version}`);
}
if (manifest.entry !== "./main.js") {
  throw new Error('GitHub distribution requires "entry": "./main.js"');
}

const banner = `/*! ${manifest.name} v${manifest.version} | MIT License | https://github.com/notesynchelper/edgeever-note-sync-helper */`;

await mkdir(distUrl, { recursive: true });

await build({
  entryPoints: [new URL("src/main.ts", pluginDir).pathname],
  outfile: new URL("dist/main.js", pluginDir).pathname,
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  sourcemap: false,
  minify: true,
  legalComments: "none",
  banner: { js: banner },
  logLevel: "warning",
});

await copyFile(manifestUrl, new URL("dist/manifest.json", pluginDir));

const mainUrl = new URL("dist/main.js", pluginDir);
const main = await readFile(mainUrl, "utf8");
const size = (await stat(mainUrl)).size;

if (size > 5 * 1024 * 1024) throw new Error(`dist/main.js is ${size} bytes, above the 5 MB host limit`);
if (/^\s*import[\s{*]/m.test(main) || /\bfrom\s*["']\.\.?\//.test(main)) {
  throw new Error("dist/main.js must be a single self-contained bundle without relative imports");
}
if (!/export\s*\{[^}]*as default/.test(main) && !/export\s+default/.test(main)) {
  throw new Error("dist/main.js must export the plugin as its default export");
}

const builtManifest = JSON.parse(await readFile(new URL("dist/manifest.json", pluginDir), "utf8"));
if (JSON.stringify(builtManifest) !== JSON.stringify(manifest)) {
  throw new Error("dist/manifest.json does not match the repository manifest.json");
}

console.log(`built dist/main.js (${(size / 1024).toFixed(1)} KiB) and dist/manifest.json v${manifest.version}`);
