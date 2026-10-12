import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { displayPath, parseCli, resolveInput } from "./lib/cli";
import { LEVEL_NAMES, parseLine, redact } from "./lib/logFormats";

/**
 * npm run logs
 *
 * Cross-platform log reader for big files. Streams line by line and understands the formats that
 * appear in the container pilot's combined log: pino JSON (loan-api), nginx access and error lines
 * (gateway), Docker events, and plain lines with a leading timestamp (docs-search). Lines may carry
 * a `service | ` prefix as written by `docker compose logs`.
 *
 * Think of it as grep, head, tail and `sort | uniq -c` in one tool that behaves the same in
 * PowerShell and zsh. The file is never loaded into memory as a whole, so a log with hundreds of
 * thousands of lines is fine. The file itself is only read, never changed.
 *
 * Usage:
 *   npx tsx ops/tools/logs.ts --file <log> [options]
 *   npm run logs -- --file <log> [options]          (the `--` passes the options on to the tool)
 *
 * Examples (all filters can be combined; a line is printed only when it passes every one):
 *   --count                                          overview first: how many lines per service, level, msg, status
 *   --service gateway --status 5xx --tail 5          the last five 5xx responses of the gateway
 *   --level error --from 2026-10-05T07:00:00Z --to 2026-10-05T08:00:00Z --head 20
 *   --grep ln-1001 --grep ln-1002                    lines matching either expression (here: two loan ids)
 *   --msg "loan created" --line-numbers              pino lines by message, with line numbers to cite as evidence
 *   --redact                                         mask personal data before you copy lines anywhere
 *
 * Good to know:
 *   - Times are compared in UTC. Logs use `Z`; convert local times (e.g. CEST = UTC+2) first.
 *   - `--to` is exclusive: --from 07:00 --to 08:00 covers exactly one hour.
 *   - Levels follow pino's numbers: 30 info, 40 warn, 50 error. nginx and Docker lines get a level
 *     derived from their status or severity, so `--level error` works across all services.
 *   - `--line-numbers` gives the position in the original file, also when filters skip lines.
 *
 * Exit codes: 0 after reading the file, 2 when --level, --from or --to cannot be understood.
 */
const { values } = parseCli(
  "npm run logs",
  "Filters, counts and redacts application and container logs; no external tools needed, same options in every shell.",
  {
    file: {
      type: "string",
      default: "logs/app.log",
      description: "Log file to read",
    },
    service: {
      type: "string",
      description:
        "Only lines of this service prefix (gateway, loan-api, docs-search, docker)",
    },
    level: {
      type: "string",
      description:
        "Minimum level: 30/40/50 or info/warn/error (nginx and docker lines are mapped)",
    },
    from: {
      type: "string",
      description:
        "Only lines at or after this ISO time (UTC), e.g. 2026-10-05T07:00:00Z",
    },
    to: {
      type: "string",
      description: "Only lines before this ISO time (UTC)",
    },
    grep: {
      type: "string",
      multiple: true,
      description:
        "Only lines matching this regular expression (case-insensitive); several --grep mean OR",
    },
    msg: {
      type: "string",
      description: "Only pino lines whose msg contains this text",
    },
    status: {
      type: "string",
      description: "Only lines with this HTTP status, e.g. 502 or 5xx",
    },
    redact: {
      type: "boolean",
      default: false,
      description:
        "Mask applicant names, e-mail addresses and token= query values",
    },
    count: {
      type: "boolean",
      default: false,
      description:
        "Print counts by service, level, msg and status instead of lines",
    },
    head: {
      type: "string",
      description: "Print only the first N matching lines",
    },
    tail: {
      type: "string",
      description: "Print only the last N matching lines",
    },
    "line-numbers": {
      type: "boolean",
      default: false,
      description: "Prefix each printed line with its line number in the file",
    },
  },
);

/**
 * Turn the `--level` option into pino's numeric level.
 *
 * @param input a number (`40`) or a name (`warn`, `WARN`); undefined when the option was not given
 * @returns the minimum level to print, or undefined for "no level filter"
 */
function levelThreshold(input?: string): number | undefined {
  if (!input) return undefined;
  if (/^\d+$/.test(input)) return Number(input);
  const level = LEVEL_NAMES[input.toLowerCase()];
  if (level === undefined) {
    console.error(
      `logs: unknown level "${input}"; use 30/40/50 or info/warn/error`,
    );
    process.exit(2);
  }
  return level;
}

/**
 * Does a line's HTTP status pass the `--status` filter?
 *
 *   statusMatches(502, '502') → true      exact status
 *   statusMatches(504, '5xx') → true      any status in the 500–599 class
 *   statusMatches(undefined, '5xx') → false   lines without a status never match a status filter
 *
 * @param status the status parsed from the line, if it has one
 * @param filter the `--status` option; undefined lets every line through
 */
function statusMatches(status: number | undefined, filter?: string): boolean {
  if (!filter) return true;
  if (status === undefined) return false;
  if (/^\dxx$/i.test(filter))
    return Math.floor(status / 100) === Number(filter[0]);
  return status === Number(filter);
}

/**
 * Read the file line by line, apply the filters in order and either print the matching lines
 * or, with `--count`, collect statistics and print them at the end.
 */
async function main() {
  // Validate and convert all options once, before reading the first line.
  const minLevel = levelThreshold(values.level);
  const from = values.from ? Date.parse(values.from) : undefined;
  const to = values.to ? Date.parse(values.to) : undefined;
  if ((values.from && Number.isNaN(from)) || (values.to && Number.isNaN(to))) {
    console.error(
      "logs: --from/--to must be ISO 8601 timestamps, e.g. 2026-10-05T07:00:00Z",
    );
    process.exit(2);
  }
  const patterns = (values.grep ?? []).map(
    (expression) => new RegExp(expression, "i"),
  );
  const head = values.head ? Number(values.head) : undefined;
  const tail = values.tail ? Number(values.tail) : undefined;
  // For --tail we cannot know which lines are "the last N" until the file ends, so we keep only the
  // most recent N matches in this buffer and print it at the end.
  const ring: string[] = [];
  const file = resolveInput(values.file);

  // --count statistics: how often each service, level, msg and status occurs among the matching lines.
  const counts = {
    service: new Map<string, number>(),
    level: new Map<string, number>(),
    msg: new Map<string, number>(),
    status: new Map<string, number>(),
  };
  const bump = (map: Map<string, number>, key: string) =>
    map.set(key, (map.get(key) ?? 0) + 1);

  let lineNumber = 0;
  let matched = 0;
  let unparsableTime = 0;
  // readline + a read stream hands us one line at a time; memory use stays flat whatever the file size.
  const reader = createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    lineNumber++;
    const raw = line.replace(/\r$/, ""); // a CRLF checkout must give the same output as an LF one
    if (!raw.trim()) continue;
    // parseLine() recognises the format (pino, nginx, docker, text) and extracts service, time, level, msg and status.
    const parsed = parseLine(raw);

    // Filters: each `continue` drops the line. Cheap checks come first.
    if (values.service && parsed.service !== values.service) continue;
    if (minLevel !== undefined && parsed.level < minLevel) continue;
    if (from !== undefined || to !== undefined) {
      if (!parsed.time) {
        // A line without a timestamp cannot be placed in a time window; count it and say so at the end.
        unparsableTime++;
        continue;
      }
      const t = Date.parse(parsed.time);
      if (from !== undefined && t < from) continue;
      if (to !== undefined && t >= to) continue;
    }
    if (values.msg && !(parsed.msg ?? "").includes(values.msg)) continue;
    if (!statusMatches(parsed.status, values.status)) continue;
    // --grep works on the raw text, so it also finds words inside JSON fields that are not parsed.
    if (patterns.length && !patterns.some((pattern) => pattern.test(raw)))
      continue;

    matched++;
    if (values.count) {
      bump(counts.service, parsed.service);
      bump(counts.level, String(parsed.level));
      // Non-pino lines have no msg; group them by their format instead, e.g. "(nginx-access)".
      bump(counts.msg, parsed.msg ?? `(${parsed.kind})`);
      if (parsed.status !== undefined)
        bump(counts.status, String(parsed.status));
      continue;
    }
    // Redaction only changes what is printed; the filters above always see the original line.
    const text = values.redact ? redact(raw) : raw;
    const output = values["line-numbers"] ? `${lineNumber}: ${text}` : text;
    if (tail !== undefined) {
      ring.push(output);
      if (ring.length > tail) ring.shift();
      continue;
    }
    console.log(output);
    // --head: stop reading as soon as we have enough, which makes it fast even on a huge file.
    if (head !== undefined && matched >= head) break;
  }
  for (const output of ring) console.log(output);

  if (values.count) {
    console.log(
      `matched ${matched} of ${lineNumber} lines in ${displayPath(file)}`,
    );
    for (const [title, map] of Object.entries(counts)) {
      if (map.size === 0) continue;
      console.log(`\nby ${title}:`);
      // Most frequent first; the top 25 per group keep the output readable.
      for (const [key, value] of [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)) {
        console.log(`  ${String(value).padStart(8)}  ${key}`);
      }
    }
  }
  // Written to stderr so it never mixes with the log lines if you redirect the output to a file.
  if (unparsableTime)
    console.error(
      `logs: ${unparsableTime} line(s) skipped by the time filter because they carry no timestamp`,
    );
}

void main();
