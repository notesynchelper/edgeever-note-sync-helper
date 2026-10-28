/**
 * Read-only smoke check: pulls the newest articles with a real key, renders the
 * default templates and prints what a note would look like. It never writes to
 * the workspace and never prints the key.
 */
import { ArticleClient } from "../src/api/client";
import { renderNote } from "../src/sync/processor";
import { normalizeSettings } from "../src/settings";
import { hashText } from "../src/util/hash";

const SAMPLE_SIZE = 3;

function maskKey(key: string): string {
  if (key.length <= 4) return "***";
  return `${key.slice(0, 2)}***${key.slice(-1)} (length ${key.length})`;
}

export async function main(): Promise<void> {
  const key = (process.env.NOTEHELPER_API_KEY || "").trim();
  if (!key) {
    throw new Error("Set NOTEHELPER_API_KEY in the environment before running the smoke check.");
  }

  console.log(`key: ${maskKey(key)}`);
  const client = new ArticleClient({
    apiKey: key,
    fetchImpl: (input, init) => fetch(input, init),
    pageSize: SAMPLE_SIZE,
    timeoutMs: 30_000,
  });

  const { items, endpoint, requests } = await client.fetchAll("");
  console.log(`articles: ${items.length} (requests: ${requests}, entry point: ${new URL(endpoint).hostname})`);

  const settings = normalizeSettings({});
  const sample = items.slice(0, SAMPLE_SIZE);
  for (const [index, item] of sample.entries()) {
    const rendered = await renderNote(item, settings, hashText);
    console.log("");
    console.log(`#${index + 1} ${rendered.title}`);
    console.log(`    folder : ${rendered.notebookPath}`);
    console.log(`    images : ${rendered.imageCount}`);
    console.log(`    tags   : ${rendered.tags.join(", ") || "(none)"}`);
    console.log(`    hash   : ${rendered.renderedHash.slice(0, 12)}…`);
    if (index === 0) {
      const head = rendered.markdown.split("\n").slice(0, 9).join("\n");
      console.log("    note head:");
      for (const line of head.split("\n")) console.log(`      ${line}`);
    }
  }
  console.log("");
  console.log("smoke ok (read-only)");
}
