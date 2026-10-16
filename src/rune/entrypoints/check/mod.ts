import { relative, resolve } from "#std/path";
import { planManifest } from "@rune/domain/business/rune-manifest/mod.ts";
import {
  type Finding,
  renderFinding,
} from "@rune/domain/business/diagnostics/mod.ts";
import {
  coreSpecExists,
  loadCoreSrvs,
  resolveRoot,
} from "@rune/entrypoints/spec-root.ts";
import { explain, registry } from "@rune/domain/business/registry/mod.ts";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const USAGE =
  "Usage: rune check <rune-file> [--root <dir>] [--json]\n       rune check --stdin --path <rune-file> [--root <dir>] [--json]\n       rune check --explain <rule-id>";

/** The channels `rune check` talks through — injectable so tests can capture them. */
export interface CheckIo {
  log: (line: string) => void;
  error: (line: string) => void;
  /** The whole of stdin, for `--stdin`. */
  stdin: () => Promise<string>;
}

const defaultIo: CheckIo = {
  log: console.log,
  error: console.error,
  stdin: async () => {
    const chunks: Uint8Array[] = [];
    for await (const c of Deno.stdin.readable) chunks.push(c);
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return new TextDecoder().decode(out);
  },
};

/** The `--json` report: the one machine-readable form of a check (REQ-013). */
export interface CheckReport {
  path: string;
  ok: boolean;
  findings: Finding[];
}

// `rune check <file.rune>` — validate a spec WITHOUT generating anything. Runs
// the same parser + rules as `rune sync` and the LSP; exit 0 = clean, 2 = errors.
// `--json` prints a CheckReport on stdout; `--stdin --path <file>` checks a
// buffer as if it lived at <file> (root + core.rune resolve from that path), so
// an editor can check an unsaved buffer (REQ-013).
export async function runCheck(
  args: string[],
  io: CheckIo = defaultIo,
): Promise<number> {
  // `--explain <id>` prints the registry's doc for one rule (REQ-030): what it
  // says, what to change, and why it exists — the same text the language card
  // carries, so an agent reading a finding can look its rule up.
  const explainAt = args.indexOf("--explain");
  if (explainAt !== -1) {
    const id = args[explainAt + 1];
    if (!id || id.startsWith("--")) {
      io.error(USAGE);
      return 2;
    }
    const doc = explain(id);
    if (doc === null) {
      io.error(
        `${RED}unknown rule "${id}" — rules: ${
          registry.lint.filter((r) => r.target === "spec").map((r) => r.id).join(", ")
        }${RESET}`,
      );
      return 2;
    }
    io.log(doc);
    return 0;
  }

  let runePath: string | null = null;
  let rootArg: string | null = null;
  let json = false;
  let stdin = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--root" || a === "--path") {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) {
        io.error(USAGE);
        return 2;
      }
      if (a === "--root") rootArg = v;
      else runePath = v;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--stdin") {
      stdin = true;
    } else if (!a.startsWith("--") && runePath === null) {
      runePath = a;
    }
  }
  if (!runePath) {
    io.error(USAGE);
    return 2;
  }

  let text: string;
  if (stdin) {
    text = await io.stdin();
  } else {
    try {
      text = await Deno.readTextFile(resolve(runePath));
    } catch (e) {
      io.error(
        `${RED}error: cannot read ${runePath}: ${
          e instanceof Error ? e.message : e
        }${RESET}`,
      );
      return 2;
    }
  }

  // Resolve the project's shared services (core.rune) so boundary services
  // resolve and strict service-presence is enforced — same as manifest/sync.
  const absRune = resolve(runePath);
  const root = rootArg !== null ? resolve(rootArg) : resolveRoot(absRune);
  const sharedSrvs = await loadCoreSrvs(root, absRune);
  const coreSpecFound = await coreSpecExists(root, absRune);
  const plan = planManifest(
    relative(root, absRune),
    text,
    new Set(),
    { strictServices: true, projectRoot: root, coreSpecFound },
    sharedSrvs,
  );
  // Findings are reported against the path the caller gave, not the root-relative one.
  const findings = plan.findings.map((f) => ({ ...f, path: runePath! }));
  // Warnings are reported but never fail the check: `ok` is "no errors".
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  const ok = errors === 0;

  if (json) {
    const report: CheckReport = { path: runePath, ok, findings };
    io.log(JSON.stringify(report, null, 2));
    return ok ? 0 : 2;
  }
  if (findings.length === 0) {
    io.log(`${GREEN}${runePath}: OK — no errors${RESET}`);
    return 0;
  }
  const count = [
    errors ? `${errors} error(s)` : "",
    warnings ? `${warnings} warning(s)` : "",
  ].filter(Boolean).join(", ");
  io.error(`${BOLD}${ok ? "" : RED}${count} in ${runePath}:${RESET}`);
  for (const f of findings) {
    io.error(`  ${f.severity === "warning" ? "warning: " : ""}${renderFinding(f)}`);
    if (f.fix) io.error(`      fix: ${f.fix}`);
  }
  if (ok) io.log(`${GREEN}${runePath}: OK — no errors${RESET}`);
  return ok ? 0 : 2;
}
