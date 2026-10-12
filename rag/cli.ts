import { buildIndex, ensureIndex, saveIndex } from "./core/index";
import { search } from "./core/search";
import { ragConfig } from "./config";

/**
 * npm run rag
 *
 * Command-line handbook search. Finds the sections of the operations handbook (docs/handbook/)
 * that best answer a question and prints them, so you (or an AI assistant) read a few relevant
 * paragraphs instead of the whole handbook. The same search runs as a web service on
 * http://localhost:3001 (`npm run rag:serve`) and as the `loan-handbook-search` skill.
 *
 * How it works, in three steps:
 *   1. Index: every Markdown file is split into chunks (one per `##` section, long sections are split
 *      again at paragraphs) and the words of each chunk are counted. The result is cached in rag/index.json.
 *   2. Search: the question is split into words the same way and every chunk is scored with BM25,
 *      a classic ranking formula: rare words that appear often in a short chunk score highest.
 *   3. Report: the best `k` chunks are printed together with a token report that compares their
 *      size with the size of the whole handbook ("how much context did retrieval save?").
 * It is keyword search, not an AI model: use the words the handbook uses (OPS-040, postmortem, S2).
 *
 * Usage:
 *   npm run rag -- "How much can be approved automatically?"   search, print the best chunks
 *   npm run rag -- "..." --k 3 --json                           fewer chunks, machine-readable output
 *   npm run rag:index                                           rebuild the index and print statistics
 *   npx tsx rag/cli.ts "What does OPS-040 require after an S2 incident?" --k 3   the same without npm
 *
 * The index rebuilds itself when a handbook file is newer than the index, so `rag:index` is only
 * needed to see the statistics. Environment variables RAG_DOCS and RAG_INDEX (rag/config.ts)
 * point the tool at another documentation folder or index file.
 *
 * Exit codes: 0 on success, 1 when no question was given.
 */
// Parse command-line arguments and handle the RAG CLI commands - slice(2) means we skip the first two default arguments (node and script path)
const args = process.argv.slice(2);
// Is a switch present? `flag("json")` returns true for `--json`
const flag = (name: string) => args.includes(`--${name}`);
// Value after an option name: `option("k")` returns "3" for `--k 3`
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
// Extract the main query from the command-line arguments, ignoring flags and the value for `--k`.
// Every remaining word is part of the question, so quotes are optional: `npm run rag -- restart policy` works too.
const query = args
  .filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--k")
  .join(" ")
  .trim();

// Handle the `--index` flag to rebuild the index and exit early (this is what `npm run rag:index` runs)
if (flag("index")) {
  const index = buildIndex(ragConfig.docsRoot);
  saveIndex(index, ragConfig.indexPath);
  console.log(
    `Indexed ${index.fileCount} files into ${index.chunks.length} chunks (~${index.totalTokens.toLocaleString()} tokens)`,
  );
  console.log(`Index written to ${ragConfig.indexPath}`);
  process.exit(0);
}

// Ensure that a query is provided, otherwise print usage and exit
if (!query) {
  console.error('Usage: npm run rag -- "<question>" [--k 5] [--json]');
  process.exit(1);
}

// Ensure the search index is available and up-to-date, rebuilding it if necessary
const { index, rebuilt } = ensureIndex(ragConfig.docsRoot, ragConfig.indexPath);
// Parse the number of top results to retrieve from the command-line options, defaulting to the configured value (5)
const k = Number(option("k") ?? ragConfig.defaultK);
// Perform the search using the query and the specified number of top results
const response = search(index, query, k);

// Output the search results in either JSON format or human-readable format.
// JSON is meant for scripts and AI tools: the same { query, results, report } object the web service returns.
if (flag("json")) {
  console.log(JSON.stringify(response, null, 2));
  process.exit(0);
}

// Print a message if the index was rebuilt, then display the query and the search results in a readable format
if (rebuilt) console.log("(index rebuilt because the documentation changed)\n");
console.log(`Query: ${response.query}\n`);
// Iterate over the search results and print each one with its metadata and content.
// The header line reads: rank, document id · section heading [file, BM25 score, approximate size].
// Scores are only comparable within one query; a higher score means a better match.
for (const [i, { chunk, score }] of response.results.entries()) {
  console.log(
    `--- ${i + 1}. ${chunk.docId} · ${chunk.heading}  [${chunk.file}, score ${score}, ~${chunk.tokens} tokens]`,
  );
  console.log(chunk.text.trim());
  console.log();
}
// Print a token report summarizing the number of tokens in the documentation, retrieved context, and the percentage of tokens saved.
// Tokens are estimated as ~4 characters per token (core/tokens.ts), not counted by a real tokenizer, hence "approximate".
const r = response.report;
console.log("=== Token report (approximate) ===");
console.log(
  `Whole documentation: ${r.documentationTokens.toLocaleString()} tokens in ${r.fileCount} files (${r.chunkCount} chunks)`,
);
console.log(
  `Retrieved context:   ${r.retrievedTokens.toLocaleString()} tokens in ${r.retrievedCount} chunks`,
);
console.log(`Saved:               ${r.savedPercent}%`);
