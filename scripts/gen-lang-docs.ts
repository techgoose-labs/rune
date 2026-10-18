#!/usr/bin/env -S deno run -A
// gen-lang-docs.ts — the language reference, generated from the registry
// (REQ-028) and the LLM language card (REQ-029).
//
//   deno run -A scripts/gen-lang-docs.ts          # write
//   deno run -A scripts/gen-lang-docs.ts --check  # exit 1 when anything would change (the drift gate)
//
// `lang/keywords.json` is the one source: the tag, modifier, transport, fault,
// indent and rule tables are rendered between `<!-- rune:gen <name> -->` …
// `<!-- /rune:gen -->` markers in lang/docs/spec.md and lang/docs/constraints.md
// (the prose around them is hand-written), and lang/docs/card.md is written
// whole — grammar by example (the valid corpus), the tables, the rule catalogue
// with messages and fixes, and the invalid corpus as error → fix pairs, each
// pair being what `rune check` really reports for that fixture.

import { registry } from "@rune/domain/business/registry/mod.ts";
import { planManifest } from "@rune/domain/business/rune-manifest/mod.ts";
import { renderFinding } from "@rune/domain/business/diagnostics/mod.ts";
import type { Finding } from "@rune/domain/business/diagnostics/mod.ts";

const ROOT = new URL("../", import.meta.url);
const CORPUS = new URL("fixtures/corpus/", ROOT);
const check = Deno.args.includes("--check");

const code = (s: string) => `\`${s}\``;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function table(headers: string[], rows: string[][]): string {
  const out = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];
  for (const r of rows) out.push(`| ${r.map(cell).join(" | ")} |`);
  return out.join("\n");
}

// ---- the tables ------------------------------------------------------------

function tagsTable(): string {
  return table(
    ["Tag", "Indent", "Syntax", "Meaning"],
    registry.tags.map((t) => [
      code(t.tag),
      String(t.indent),
      code(t.syntax ?? ""),
      t.summary ?? t.description ?? "",
    ]),
  );
}

function modifiersTable(): string {
  return table(
    ["Modifier", "Applies to", "Kind", "Requires", "Decorator (scalar)", "Decorator (array)", "Meaning"],
    registry.modifiers.map((m) => [
      code(m.syntax ?? m.token),
      m.appliesTo.map((t) => code(`[${t.toUpperCase()}]`)).join(", "),
      m.kind,
      m.base ? code(m.base) : "—",
      m.call ? code(m.call.replace("{value}", "N")) : "—",
      m.eachCall ? code(m.eachCall.replace("{value}", "N")) : "—",
      m.description ?? "",
    ]),
  );
}

function transportsTable(): string {
  return table(
    ["Transport", "Meaning"],
    registry.transports.map((t) => [code(t.id), t.summary]),
  );
}

function faultsTable(): string {
  const f = registry.faults;
  return [
    `Fault lines are written ${code(f.syntax)}: ${f.summary}`,
    "",
    table(
      ["Well-known fault", "HTTP status", "Meaning"],
      f.wellKnown.map((w) => [code(w.id), String(w.status), w.summary]),
    ),
  ].join("\n");
}

function indentTable(): string {
  const i = registry.indent;
  return [
    i.summary ?? "",
    "",
    table(
      ["Line", "Column"],
      [
        ["`[REQ]` `[ENT]` `[DTO]` `[TYP]` `[NON]` `[SRV]` `[MOD]`", "0"],
        ["steps, `[NEW]`, `[RET]`, `[PLY]`", String(i.step)],
        ["faults (`!` lines)", String(i.fault)],
        ["`[CSE]` and the steps inside a case", String(i.case)],
        ["faults inside a case", String(i.caseFault)],
        ["descriptions, `@docs`", String(i.description)],
        ["an `[ENT]` body `[REQ]`", String(i.body)],
      ],
    ),
    "",
    `Lines are at most ${registry.columns.max} characters.`,
  ].join("\n");
}

function rulesTable(target: "spec" | "generated" = "spec"): string {
  return table(
    ["Rule", "Severity", "Message", "Fix", "Why"],
    registry.lint.filter((r) => r.target === target).map((r) => [
      code(r.id),
      r.severity,
      code(r.message),
      r.fix ? code(r.fix) : "—",
      r.doc ?? "",
    ]),
  );
}

export const SECTIONS: Record<string, () => string> = {
  tags: tagsTable,
  modifiers: modifiersTable,
  transports: transportsTable,
  faults: faultsTable,
  indent: indentTable,
  rules: () => rulesTable("spec"),
  "generated-rules": () => rulesTable("generated"),
};

/** Replace every `<!-- rune:gen NAME -->…<!-- /rune:gen -->` block in `doc`. */
export function fillMarkers(doc: string): string {
  return doc.replace(
    /<!-- rune:gen ([a-z-]+) -->[\s\S]*?<!-- \/rune:gen -->/g,
    (_m, name: string) => {
      const render = SECTIONS[name];
      if (!render) throw new Error(`gen-lang-docs: unknown section "${name}"`);
      return `<!-- rune:gen ${name} -->\n${render()}\n<!-- /rune:gen -->`;
    },
  );
}

// ---- the card --------------------------------------------------------------

async function listRune(dir: URL): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith(".rune")) out.push(e.name);
  }
  return out.sort();
}

/** What `rune check` reports for a corpus fixture (checked as src/<stem>/<stem>.rune). */
function findingsFor(stem: string, text: string): Finding[] {
  return planManifest(`src/${stem}/${stem}.rune`, text, new Set()).findings;
}

export async function buildCard(): Promise<string> {
  const L: string[] = [];
  L.push("# Rune — the language card");
  L.push("");
  L.push(
    "GENERATED from lang/keywords.json and fixtures/corpus by scripts/gen-lang-docs.ts — do not edit by hand.",
  );
  L.push("");
  L.push(
    "A `.rune` file is one module: requirements ([REQ]) made of steps, the entrypoints ([ENT]) that dispatch to them, and the data they name ([DTO], [TYP], [NON]). Shared services ([SRV]) live once in `src/core/core.rune`. Every line's kind is its first token; indentation is what `rune fmt` writes. `rune check` is the gate and the editor's diagnostics are its findings, each with a rule id from the catalogue below; `rune check --explain <id>` prints a rule.",
  );
  L.push("");
  L.push("## Grammar by example");
  L.push("");
  L.push("Every spec below checks clean.");
  for (const name of await listRune(new URL("valid/", CORPUS))) {
    const text = await Deno.readTextFile(new URL(`valid/${name}`, CORPUS));
    L.push("", `### ${name}`, "", "```rune", text.trimEnd(), "```");
  }
  L.push("", "## Tags", "", tagsTable());
  L.push("", "## Modifiers", "", modifiersTable());
  L.push("", "## Transports", "", transportsTable());
  L.push("", "## Faults", "", faultsTable());
  L.push("", "## Indentation", "", indentTable());
  L.push("", "## Rules", "", rulesTable("spec"));
  L.push("", "## Errors and their fixes", "");
  L.push("Each spec below is wrong in one way; under it, what `rune check` says.");
  for (const name of await listRune(new URL("invalid/", CORPUS))) {
    const text = await Deno.readTextFile(new URL(`invalid/${name}`, CORPUS));
    const stem = name.replace(/\.rune$/, "");
    const findings = findingsFor(stem, text);
    L.push("", `### ${stem}`, "", "```rune", text.trimEnd(), "```", "");
    for (const f of findings) {
      L.push(`- ${renderFinding({ ...f, path: name })}${f.fix ? ` — fix: ${f.fix}` : ""}`);
    }
  }
  L.push("");
  return L.join("\n");
}

// ---- driver ----------------------------------------------------------------

if (import.meta.main) {
  const targets = ["lang/docs/spec.md", "lang/docs/constraints.md"];
  const changes: string[] = [];
  for (const rel of targets) {
    const url = new URL(rel, ROOT);
    const before = await Deno.readTextFile(url);
    const after = fillMarkers(before);
    if (after !== before) {
      changes.push(rel);
      if (!check) await Deno.writeTextFile(url, after);
    }
  }
  const cardUrl = new URL("lang/docs/card.md", ROOT);
  const card = await buildCard();
  let have: string | null = null;
  try {
    have = await Deno.readTextFile(cardUrl);
  } catch {
    have = null;
  }
  if (have !== card) {
    changes.push("lang/docs/card.md");
    if (!check) await Deno.writeTextFile(cardUrl, card);
  }
  if (check) {
    if (changes.length) {
      console.error(
        `lang docs drift from the registry/corpus: ${changes.join(", ")}\n  → run: deno run -A scripts/gen-lang-docs.ts`,
      );
      Deno.exit(1);
    }
    console.log("lang docs in sync with lang/keywords.json and the corpus.");
  } else {
    console.log(changes.length ? `wrote ${changes.join(", ")}` : "lang docs already up to date.");
  }
}
