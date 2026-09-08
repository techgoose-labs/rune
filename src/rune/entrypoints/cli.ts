import type { EntryResult } from "@core/dto/types.ts";

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export function parseArgs(
  args: string[],
): { dir: string; module: string | null; suggest: boolean; json: boolean } {
  const json = args.includes("--json");
  // --json implies a machine-readable run: no LLM suggestions, no header noise.
  const suggest = !args.includes("--no-suggest") && !json;

  const moduleIndex = args.indexOf("--module");
  const module = moduleIndex !== -1 && args[moduleIndex + 1]
    ? args[moduleIndex + 1]
    : null;

  // First positional arg (not a flag or flag value) as dir
  const flagValues = new Set<number>();
  if (moduleIndex !== -1) flagValues.add(moduleIndex + 1);
  const positional = args.find((a, i) =>
    !a.startsWith("--") && !flagValues.has(i)
  );

  return { dir: positional ?? ".", module, suggest, json };
}

/**
 * Machine-readable lint output: a stable, sorted array of
 * `{ rule, path, line, message }` — one entry per violation. Agents and the
 * verify harness assert on this, never on the coloured text (verification.md
 * Prereq-1). Sorted so two runs over the same input are byte-identical (L0).
 */
export function printJson(results: EntryResult[]): void {
  const flat: { rule: string; path: string; line: number; message: string }[] =
    [];
  for (const r of results) {
    for (const v of r.violations) {
      // Pull a leading "line N" / "L<n>" hint out of the message when present,
      // else 0 — the message text is always the stable discriminator.
      const m = v.match(/(?:^|\b)(?:line|L)\s*(\d+)/i);
      flat.push({
        rule: r.rule,
        path: r.path,
        line: m ? Number(m[1]) : 0,
        message: v,
      });
    }
  }
  flat.sort((a, b) =>
    a.rule.localeCompare(b.rule) ||
    a.path.localeCompare(b.path) ||
    a.line - b.line ||
    a.message.localeCompare(b.message)
  );
  console.log(JSON.stringify(flat, null, 2));
}

export function printHeader(targetDir: string): void {
  console.log(`${BOLD}Scanning ${targetDir}...${RESET}`);
  console.log();
}

export function printResults(results: EntryResult[]): void {
  if (results.length === 0) {
    console.log(`${BOLD}${CYAN}All clear — no violations found.${RESET}`);
    return;
  }

  const grouped = new Map<string, EntryResult[]>();
  for (const r of results) {
    const list = grouped.get(r.rule) ?? [];
    list.push(r);
    grouped.set(r.rule, list);
  }

  for (const [rule, items] of grouped) {
    console.log(
      `${BOLD}${RED}[${rule}]${RESET} — ${items.length} violation(s)\n`,
    );
    for (const item of items) {
      console.log(`  ${YELLOW}${item.path}${RESET}`);
      for (const v of item.violations) {
        console.log(`    ${RED}• ${v}${RESET}`);
      }
      if (item.suggestion) {
        console.log(`    ${CYAN}→ ${item.suggestion}${RESET}`);
      }
      console.log();
    }
  }

  console.log(
    `${BOLD}${RED}${results.length} total violation(s) found.${RESET}`,
  );
}
