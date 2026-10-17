#!/usr/bin/env -S deno run -A
// The verification oracle (see rune/new/studio/verification.md).
//
//   deno task verify              # run the whole ladder, exit 0/1
//   deno task verify --gate L3    # run one gate
//   deno task verify --update-goldens   # recapture goldens (intentional only)
//
// Every gate is a deterministic pass/fail. The gate — not a human spot-check —
// is the done-signal. Goldens are captured from TODAY's engine and are the
// baseline P3 must preserve; an unreviewed golden diff is the failure mode to
// guard against, so --update-goldens is explicit and its output must be
// reviewed in the diff.

import { dirname, fromFileUrl, join, relative } from "#std/path";
import { parse } from "@rune/domain/business/rune-parse/mod.ts";
import { planManifest } from "@rune/domain/business/rune-manifest/mod.ts";
import { corpusParity } from "@rune/domain/business/diagnostics/corpus.ts";
import { rules, runPipeline } from "@rune/mod-root.ts";
import { getIgnoredPaths } from "@rune/domain/data/project/mod.ts";
import { validateArtifact } from "@rune/domain/business/artifact/validate.ts";
import {
  annotateAndFilter,
  resolveSettings,
} from "@rune/domain/business/lint-config/mod.ts";
import {
  applyOverlay,
  overlayIsCompliant,
} from "@rune/domain/business/governance/mod.ts";
import { migrate } from "@rune/domain/business/migrate/mod.ts";
import { generate as studioGenerate } from "../rune-studio/lib/engine.ts";
import { buildGrammar } from "./generate-core.mjs";
import type { EntryResult } from "@core/dto/types.ts";

// Deterministic lint: never depend on whether the Rust LSP binary is present.
Deno.env.set("SHAPE_NO_LSP", "1");

const ROOT = fromFileUrl(new URL("../", import.meta.url));
const CORPUS = join(ROOT, "fixtures/corpus");
const GOLDEN = join(ROOT, "fixtures/golden");
const PROJECTS = join(ROOT, "fixtures/projects");
// Post-reorg layout: engine at src/; keywords.json + grammar/queries under lang/;
// gen scripts under scripts/; studio under rune-studio/. (Was a nested rune/new/... tree.)

// L4 fixture projects fall in two kinds:
//  - GEN_FIXTURES: materialised (deterministically) from a [MOD] corpus spec,
//    then linted — proves the engine's own generated output stays lint-clean.
//  - STATIC_FIXTURES: hand-authored trees with deliberate violations — proves
//    the linter actually fires (an empty golden would otherwise be vacuous).
const GEN_FIXTURES = ["module-billing", "module-catalog", "entrypoint"];
const STATIC_FIXTURES = ["dirty"];
const LINT_FIXTURES = [...GEN_FIXTURES, ...STATIC_FIXTURES];

const update = Deno.args.includes("--update-goldens");
const gateArg = (() => {
  const i = Deno.args.indexOf("--gate");
  return i !== -1 ? (Deno.args[i + 1] ?? "").toLowerCase() : null;
})();

// ---- helpers ---------------------------------------------------------------

function listRune(dir: string): string[] {
  const out: string[] = [];
  for (const e of Deno.readDirSync(dir)) {
    if (e.isFile && e.name.endsWith(".rune")) out.push(join(dir, e.name));
  }
  return out.sort();
}

const validSpecs = listRune(join(CORPUS, "valid"));
const invalidSpecs = listRune(join(CORPUS, "invalid"));
const stem = (p: string) => p.split("/").pop()!.replace(/\.rune$/, "");

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

async function writeGolden(path: string, content: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, content);
}

/** Flatten lint results to the stable, sorted shape printJson emits. */
function lintToJson(results: EntryResult[]) {
  const flat: { rule: string; path: string; line: number; message: string }[] =
    [];
  for (const r of results) {
    for (const v of r.violations) {
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
  return flat;
}

interface GateResult {
  name: string;
  ok: boolean;
  detail: string;
}

// ---- Drift -----------------------------------------------------------------

async function gateDrift(): Promise<GateResult> {
  const gen = new Deno.Command("deno", {
    args: ["run", "--allow-read", "--allow-write", "scripts/generate.mjs"],
    cwd: ROOT,
    stdout: "null",
    stderr: "piped",
  });
  const g = await gen.output();
  if (!g.success) {
    return {
      name: "Drift",
      ok: false,
      detail: `generate.mjs failed: ${new TextDecoder().decode(g.stderr)}`,
    };
  }
  // The docs are derived too (REQ-028/029): the tables between the markers in
  // spec.md / constraints.md and the whole language card.
  const docs = new Deno.Command("deno", {
    args: ["run", "-A", "scripts/gen-lang-docs.ts"],
    cwd: ROOT,
    stdout: "null",
    stderr: "piped",
  });
  const g2 = await docs.output();
  if (!g2.success) {
    return {
      name: "Drift",
      ok: false,
      detail: `gen-lang-docs.ts failed: ${new TextDecoder().decode(g2.stderr)}`,
    };
  }
  const diff = new Deno.Command("git", {
    args: [
      "diff",
      "--exit-code",
      "--",
      "lang/grammar/grammar.js",
      "lang/queries/highlights.scm",
      "lang/grammar/src/scanner-config.h",
      "lang/docs/spec.md",
      "lang/docs/constraints.md",
      "lang/docs/card.md",
    ],
    cwd: ROOT,
    stdout: "piped",
    stderr: "null",
  });
  const d = await diff.output();
  return d.success
    ? {
      name: "Drift",
      ok: true,
      detail: "regeneration reproduces every derived artifact byte-for-byte",
    }
    : {
      name: "Drift",
      ok: false,
      detail: "derived artifacts differ after regeneration:\n" +
        new TextDecoder().decode(d.stdout),
    };
}

// ---- corpus health ---------------------------------------------------------

async function gateCorpus(): Promise<GateResult> {
  // REQ-014: exact parity — valid checks clean, invalid matches its .diag.json
  // sidecar (id + line). `--update-goldens` captures MISSING sidecars only.
  const bad = await corpusParity(CORPUS, { update });
  return bad.length === 0
    ? {
      name: "corpus",
      ok: true,
      detail:
        `${validSpecs.length} valid check clean; ${invalidSpecs.length} invalid match their .diag.json sidecars exactly`,
    }
    : { name: "corpus", ok: false, detail: bad.join("\n") };
}

// ---- L0 determinism --------------------------------------------------------

async function gateL0(): Promise<GateResult> {
  const bad: string[] = [];
  for (const p of validSpecs) {
    const text = Deno.readTextFileSync(p);
    const rel = `corpus/valid/${stem(p)}.rune`;
    if (stableJson(parse(text)) !== stableJson(parse(text))) {
      bad.push(`parse(${stem(p)}) not stable`);
    }
    if (
      stableJson(planManifest(rel, text, new Set())) !==
        stableJson(planManifest(rel, text, new Set()))
    ) {
      bad.push(`manifest(${stem(p)}) not stable`);
    }
  }
  // The CLI --json lint path must also be byte-stable across two runs.
  for (const name of LINT_FIXTURES) {
    const dir = join(PROJECTS, name);
    const a = await lintCliJson(dir);
    const b = await lintCliJson(dir);
    if (a !== b) bad.push(`lint --json (${name}) not stable across runs`);
  }
  return bad.length === 0
    ? {
      name: "L0",
      ok: true,
      detail:
        "parse, manifest, and lint --json are byte-identical across two runs",
    }
    : { name: "L0", ok: false, detail: bad.join("\n") };
}

/** Run the real CLI --json lint path over a directory (LSP disabled for determinism). */
async function lintCliJson(dir: string): Promise<string> {
  const cmd = new Deno.Command("deno", {
    args: ["run", "-A", "src/bootstrap/mod.ts", dir, "--json"],
    cwd: ROOT,
    env: { SHAPE_NO_LSP: "1" },
    stdout: "piped",
    stderr: "null",
  });
  const out = await cmd.output();
  return new TextDecoder().decode(out.stdout);
}

// ---- L2 parse golden -------------------------------------------------------

async function gateGolden(
  name: string,
  subdir: string,
  produce: (specPath: string) => string,
): Promise<GateResult> {
  const bad: string[] = [];
  for (const p of validSpecs) {
    const goldenPath = join(GOLDEN, subdir, `${stem(p)}.json`);
    const actual = produce(p);
    if (update) {
      await writeGolden(goldenPath, actual);
      continue;
    }
    const expected = await readMaybe(goldenPath);
    if (expected === null) {
      bad.push(`${subdir}/${stem(p)}: no golden (run --update-goldens)`);
    } else if (expected !== actual) {
      bad.push(`${subdir}/${stem(p)}: differs from golden`);
    }
  }
  if (update) {
    return {
      name,
      ok: true,
      detail: `captured ${validSpecs.length} ${subdir} golden(s)`,
    };
  }
  return bad.length === 0
    ? {
      name,
      ok: true,
      detail: `${validSpecs.length} ${subdir} golden(s) match`,
    }
    : { name, ok: false, detail: bad.join("\n") };
}

// ---- L5 conformance: Studio preview == engine ------------------------------

async function gateL5(): Promise<GateResult> {
  const bad: string[] = [];
  // The Rust-binary bridge is retired (ADR 0001).
  if (await fileExists(join(ROOT, "rune-studio/lib/runegen.ts"))) {
    bad.push(
      "lib/runegen.ts still present — the Rust bridge must be retired (ADR 0001)",
    );
  }
  // The Studio's interpreter is a thin wrapper over the engine, so its codegen
  // is byte-identical to engine output. Generate every [MOD] spec both ways
  // (same runePath "spec.rune") and assert byte-equality.
  for (const name of GEN_FIXTURES) {
    const text = Deno.readTextFileSync(join(CORPUS, "valid", `${name}.rune`));
    // Same runePath the Studio wrapper uses, so the comparison is byte-exact.
    const plan = planManifest("specs/spec.rune", text, new Set());
    const engineFiles = [...plan.toCreate, ...plan.toRegenerate].sort((a, b) =>
      a.path.localeCompare(b.path)
    );
    const studioFiles = studioGenerate(text);
    if (stableJson(engineFiles) !== stableJson(studioFiles)) {
      bad.push(
        `${name}: Studio preview differs from engine output (not sharing the interpreter)`,
      );
    }
  }
  return bad.length === 0
    ? {
      name: "L5",
      ok: true,
      detail:
        `Studio interpreter (lib/engine.ts) is the shared engine — preview byte-equals engine output across ${GEN_FIXTURES.length} specs; Rust bridge retired`,
    }
    : { name: "L5", ok: false, detail: bad.join("\n") };
}

// ---- L7 migration + governance (WO-7) --------------------------------------

async function gateL7(): Promise<GateResult> {
  const bad: string[] = [];
  const legacy = JSON.parse(
    await Deno.readTextFile(join(ROOT, "fixtures/artifact/n-1/legacy.json")),
  );
  // It must genuinely be N-1: rejected by the current contract.
  if (validateArtifact(legacy).ok) {
    bad.push("the N-1 fixture validates under N — it is not actually older");
  }
  const { artifact: migrated, applied } = migrate(legacy);
  const v = validateArtifact(migrated);
  if (!v.ok) {
    bad.push(
      `migrated artifact still invalid: ${
        v.errors.map((e) => e.message).join("; ")
      }`,
    );
  }
  // It must still generate under N (using the migrated artifact).
  for (const name of GEN_FIXTURES) {
    const text = Deno.readTextFileSync(join(CORPUS, "valid", `${name}.rune`));
    const plan = planManifest("spec.rune", text, new Set(), {
      bindings: migrated.bindings,
      codegen: migrated.codegen.templates,
    });
    const baseline = planManifest("spec.rune", text, new Set());
    if (plan.errors.length > 0 || stableJson(plan) !== stableJson(baseline)) {
      bad.push(
        `${name}: does not generate identically under migrated artifact`,
      );
    }
  }
  return bad.length === 0
    ? {
      name: "L7",
      ok: true,
      detail:
        `N-1 artifact migrated (${applied.length} step(s)) and the corpus still parses + generates under N`,
    }
    : { name: "L7", ok: false, detail: bad.join("\n") };
}

function gateGovernance(): GateResult {
  // A spec author provably cannot weaken a locked rule (D6).
  const baseline = [
    {
      id: "layer-restrictions",
      type: "layer-restrictions",
      target: "generated" as const,
      severity: "error" as const,
      enabled: true,
      message: "x",
      locked: true,
    },
    {
      id: "module-fragmentation",
      type: "module-fragmentation",
      target: "generated" as const,
      severity: "warning" as const,
      enabled: true,
      message: "y",
      locked: false,
    },
  ];
  const bad: string[] = [];
  // disabling a locked rule is rejected; the rule stays enabled
  const disabled = applyOverlay(baseline, [{
    id: "layer-restrictions",
    enabled: false,
  }], "spec-author");
  if (
    disabled.rules.find((r) => r.id === "layer-restrictions")?.enabled !== true
  ) bad.push("locked rule was disabled by overlay");
  if (disabled.rejected.length !== 1) {
    bad.push("disable attempt not recorded in the audit trail");
  }
  // downgrading severity is rejected
  if (
    overlayIsCompliant(baseline, [{
      id: "layer-restrictions",
      severity: "warning",
    }])
  ) bad.push("locked rule severity downgrade was accepted");
  // a non-locked rule still tunes freely
  const tuned = applyOverlay(baseline, [{
    id: "module-fragmentation",
    enabled: false,
  }]);
  if (
    tuned.rules.find((r) => r.id === "module-fragmentation")?.enabled !== false
  ) bad.push("non-locked rule could not be tuned");
  return bad.length === 0
    ? {
      name: "governance",
      ok: true,
      detail:
        "locked rules cannot be weakened (disable/downgrade rejected + audited); non-locked rules tune freely",
    }
    : { name: "governance", ok: false, detail: bad.join("\n") };
}

// ---- grammar build pipeline (WO-6) -----------------------------------------

async function commandExists(cmd: string): Promise<boolean> {
  try {
    return (await new Deno.Command(cmd, {
      args: ["--version"],
      stdout: "null",
      stderr: "null",
    }).output()).success;
  } catch {
    return false;
  }
}

async function gateGrammar(): Promise<GateResult> {
  if (!(await commandExists("tree-sitter"))) {
    return {
      name: "grammar",
      ok: false,
      detail:
        "tree-sitter CLI not installed — the WO-6 build pipeline requires it",
    };
  }
  const bad: string[] = [];
  const build = new Deno.Command("deno", {
    args: ["run", "-A", "scripts/build-grammar.ts"],
    cwd: ROOT,
    stdout: "null",
    stderr: "piped",
  });
  const r = await build.output();
  if (!r.success) {
    bad.push(
      "build-grammar.ts failed: " +
        new TextDecoder().decode(r.stderr).split("\n").slice(-4).join(" "),
    );
  }

  if (!(await fileExists(join(ROOT, "lang/grammar/rune.wasm")))) {
    bad.push("grammar/rune.wasm not produced");
  }
  if (
    !(await fileExists(join(ROOT, "rune-studio/static/rune-tree-sitter.wasm")))
  ) bad.push("studio static WASM not published");

  // The grammar + highlights are regenerated from the artifact: every tag id
  // must appear as a parse rule and a highlight capture (so a tag/colour change
  // in the artifact recolours both the in-Studio and external editors).
  const reg = JSON.parse(
    await Deno.readTextFile(join(ROOT, "lang/keywords.json")),
  );
  const grammarJson = await Deno.readTextFile(
    join(ROOT, "lang/grammar/src/grammar.json"),
  );
  const highlights = await Deno.readTextFile(
    join(ROOT, "lang/queries/highlights.scm"),
  );
  for (const t of reg.tags as Array<{ id: string }>) {
    if (!grammarJson.includes(`"${t.id}_tag"`)) {
      bad.push(`grammar missing rule for tag "${t.id}"`);
    }
    if (!highlights.includes(`(${t.id}_tag) @rune.tag`)) {
      bad.push(`highlights missing capture for tag "${t.id}"`);
    }
  }
  return bad.length === 0
    ? {
      name: "grammar",
      ok: true,
      detail:
        `regenerated from artifact + compiled to WASM; all ${reg.tags.length} tags have parse rules + highlight captures`,
    }
    : { name: "grammar", ok: false, detail: bad.join("\n") };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---- L1 meta-validation ----------------------------------------------------

async function gateL1(): Promise<GateResult> {
  const bad: string[] = [];
  const ARTIFACT = join(ROOT, "fixtures/artifact");

  // The current registry (live, single source) must validate.
  const reg = JSON.parse(
    await Deno.readTextFile(join(ROOT, "lang/keywords.json")),
  );
  const regResult = validateArtifact(reg);
  if (!regResult.ok) {
    bad.push(
      `live keywords.json rejected: ${
        regResult.errors.map((e) => e.message).join("; ")
      }`,
    );
  }

  // Every valid/ fixture must validate.
  let validCount = 0;
  for (const e of Deno.readDirSync(join(ARTIFACT, "valid"))) {
    if (!e.name.endsWith(".json")) continue;
    validCount++;
    const a = JSON.parse(
      await Deno.readTextFile(join(ARTIFACT, "valid", e.name)),
    );
    const r = validateArtifact(a);
    if (!r.ok) {
      bad.push(
        `valid/${e.name} rejected: ${
          r.errors.map((x) => x.message).join("; ")
        }`,
      );
    }
  }

  // Every invalid/ fixture must be rejected with its expected message.
  const exp = JSON.parse(
    await Deno.readTextFile(join(ARTIFACT, "expectations.json")),
  ) as Record<string, string>;
  for (const [name, sub] of Object.entries(exp)) {
    const a = JSON.parse(
      await Deno.readTextFile(join(ARTIFACT, "invalid", `${name}.json`)),
    );
    const r = validateArtifact(a);
    const hit = !r.ok &&
      r.errors.some((x) => x.message.includes(sub) || x.path.includes(sub));
    if (!hit) {
      bad.push(
        `invalid/${name}: expected a "${sub}" rejection, got ${
          r.ok
            ? "OK"
            : r.errors.map((x) => `[${x.path}] ${x.message}`).join(" | ")
        }`,
      );
    }
  }

  return bad.length === 0
    ? {
      name: "L1",
      ok: true,
      detail: `current registry + ${validCount} valid fixtures accepted; ${
        Object.keys(exp).length
      } crafted-invalid fixtures rejected with precise messages`,
    }
    : { name: "L1", ok: false, detail: bad.join("\n") };
}

// ---- L6 artifact-driven property (the differentiator) ----------------------

async function gitDiffNames(pathspec: string): Promise<string> {
  const cmd = new Deno.Command("git", {
    args: ["diff", "--name-only", "--", pathspec],
    cwd: ROOT,
    stdout: "piped",
    stderr: "null",
  });
  return new TextDecoder().decode((await cmd.output()).stdout);
}

async function gateL6(): Promise<GateResult> {
  // Proves the thesis: mutate ONLY the artifact -> engine output changes in the
  // expected way AND no engine source (src/) changed. A binding mutation here;
  // template/severity mutations are added as those become artifact-driven.
  const bad: string[] = [];
  const srcBefore = await gitDiffNames("src/shape-checker");

  const artifact = JSON.parse(
    await Deno.readTextFile(join(ROOT, "lang/keywords.json")),
  );
  const specPath = join(CORPUS, "valid", "module-billing.rune");
  const text = await Deno.readTextFile(specPath);
  const rel = "corpus/valid/module-billing.rune";

  // Baseline consistency: passing the artifact's (unmutated) bindings must match
  // the engine's default output — so L3 still holds when the engine reads them.
  const planDefault = planManifest(rel, text, new Set());
  const planArtifact = planManifest(rel, text, new Set(), {
    bindings: artifact.bindings,
  });
  if (stableJson(planDefault) !== stableJson(planArtifact)) {
    bad.push(
      "artifact bindings (unmutated) produced different output than the engine default — L3 would break",
    );
  }

  // Mutation: drop the "Dto" suffix-strip from the <name> binding. DTO files
  // should gain a "-dto" segment (IssueDto -> issue-dto.ts, was issue.ts).
  const mutated = structuredClone(artifact.bindings);
  delete mutated["<name>"].stripSuffix;
  const planMutated = planManifest(rel, text, new Set(), { bindings: mutated });

  const pathsA = new Set(planArtifact.toCreate.map((f) => f.path));
  const pathsB = planMutated.toCreate.map((f) => f.path);
  const gained = pathsB.filter((p) =>
    /\/dto\/.*-dto\.ts$/.test(p) && !pathsA.has(p)
  );
  if (stableJson(planArtifact) === stableJson(planMutated)) {
    bad.push("mutating the <name> binding produced no output change");
  } else if (gained.length === 0) {
    bad.push(
      "expected DTO file paths to gain a '-dto' segment after dropping stripSuffix; got: " +
        pathsB.filter((p) => p.includes("/dto/")).join(", "),
    );
  }

  // (b) TEMPLATE mutation (WO-4b). The artifact's codegen templates reproduce
  // the engine default (L3 consistency); editing one changes generated content.
  const tmplBaseline = planManifest(rel, text, new Set(), {
    codegen: artifact.codegen.templates,
  });
  if (stableJson(planDefault) !== stableJson(tmplBaseline)) {
    bad.push(
      "artifact codegen.templates (unmutated) produced different output than the engine default — L3 would break",
    );
  }
  const tmplMutated = structuredClone(artifact.codegen.templates);
  const MARKER = "// L6-TEMPLATE-MUTATION-MARKER";
  tmplMutated["adapter-smk-test"] = MARKER + "\n" +
    tmplMutated["adapter-smk-test"];
  const planTmpl = planManifest(rel, text, new Set(), { codegen: tmplMutated });
  const smkFile = planTmpl.toCreate.find((f) =>
    f.path.endsWith("/smk.test.ts")
  );
  if (!smkFile || !smkFile.content.includes(MARKER)) {
    bad.push(
      "mutating the 'adapter-smk-test' codegen template did not change the generated smoke-test content",
    );
  }

  // (c) GRAMMAR mutation (REQ-031). The parser of record is the grammar built
  // from the artifact's tags table; adding a tag changes the generated grammar
  // (and, after a wasm build, what the engine parses) with no parser edit.
  const withCons = structuredClone(artifact);
  withCons.tags.push({
    id: "cons",
    tag: "[CONS]",
    label: "Construct",
    indent: 4,
    follows: "identifier",
    shapeRule: "unrecognized-line",
  });
  const grammarDefault = buildGrammar(artifact);
  const grammarMutated = buildGrammar(withCons);
  if (grammarDefault.includes("[CONS]")) {
    bad.push("expected the default tag set to produce no [CONS] rule");
  }
  if (!grammarMutated.includes("cons_line") || !grammarMutated.includes("\"[CONS]\"")) {
    bad.push("adding [CONS] to the artifact did not add a grammar rule for it");
  }

  // (d) LINT policy mutation (WO-4d). Rule enabled/severity comes from the
  // artifact's lint array; flipping severity or disabling a rule changes a real
  // lint run with no rule-code change.
  const dirty = join(PROJECTS, "dirty");
  const lintResults = await runPipeline(
    dirty,
    rules,
    await getIgnoredPaths(dirty),
  );
  const annotated = annotateAndFilter(
    lintResults,
    resolveSettings(artifact.lint),
  );
  // severity: module-isolation is "error" in the artifact; flip to "warning".
  const sevMut = structuredClone(artifact.lint);
  const miRule = sevMut.find((r: { type: string }) =>
    r.type === "module-isolation"
  );
  if (miRule) miRule.severity = "warning";
  const annotatedSev = annotateAndFilter(lintResults, resolveSettings(sevMut));
  const before = annotated.find((f) => f.rule === "module-isolation")?.severity;
  const after = annotatedSev.find((f) => f.rule === "module-isolation")
    ?.severity;
  if (!(before === "error" && after === "warning")) {
    bad.push(
      `severity mutation: expected module-isolation error->warning, got ${before}->${after}`,
    );
  }
  // enabled: disable no-relative-import (engine import-aliases) -> findings drop.
  const enMut = structuredClone(artifact.lint);
  const relRule = enMut.find((r: { type: string }) =>
    r.type === "no-relative-import"
  );
  if (relRule) relRule.enabled = false;
  const annotatedDis = annotateAndFilter(lintResults, resolveSettings(enMut));
  const hadAliases = annotated.some((f) => f.rule === "import-aliases");
  const stillAliases = annotatedDis.some((f) => f.rule === "import-aliases");
  if (!(hadAliases && !stillAliases)) {
    bad.push(
      `enabled mutation: expected import-aliases findings to drop when disabled (had=${hadAliases}, still=${stillAliases})`,
    );
  }

  // (e) END-TO-END THROUGH THE UI DATA PATH (WO-7 / L6 e2e). The Studio's
  // registry-driven generate (the same call /api/generate makes after the UI
  // edits data/keywords.json) must reflect a registry edit.
  const e2eSpec = Deno.readTextFileSync(
    join(CORPUS, "valid", "module-billing.rune"),
  );
  const uiA = studioGenerate(e2eSpec, artifact);
  const uiRegMut = structuredClone(artifact);
  delete uiRegMut.bindings["<name>"].stripSuffix; // same edit a UI user could make
  const uiB = studioGenerate(e2eSpec, uiRegMut);
  if (stableJson(uiA) === stableJson(uiB)) {
    bad.push(
      "editing the registry (UI data path) did not change the Studio's engine-backed output",
    );
  }

  const srcAfter = await gitDiffNames("src/shape-checker");
  if (srcBefore !== srcAfter) {
    bad.push("the L6 gate itself changed engine source (src/) — must not");
  }

  return bad.length === 0
    ? {
      name: "L6",
      ok: true,
      detail:
        `binding, codegen-template, parse-recognition, lint-policy, and end-to-end UI-data-path mutations each changed engine behaviour with no src/ change`,
    }
    : { name: "L6", ok: false, detail: bad.join("\n") };
}

// ---- L4 lint golden --------------------------------------------------------

async function gateL4(): Promise<GateResult> {
  const ignored = new Set<string>();
  const bad: string[] = [];
  let captured = 0;
  for (const name of LINT_FIXTURES) {
    const dir = join(PROJECTS, name);
    let results: EntryResult[];
    try {
      const ip = await getIgnoredPaths(dir);
      results = await runPipeline(dir, rules, ip ?? ignored);
    } catch (e) {
      bad.push(`lint(${name}) threw: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    // paths are absolute; make them repo-relative so goldens are portable.
    const rel = results.map((r) => ({ ...r, path: relative(ROOT, r.path) }));
    const actual = stableJson(lintToJson(rel));
    const goldenPath = join(GOLDEN, "lint", `${name}.json`);
    if (update) {
      await writeGolden(goldenPath, actual);
      captured++;
      continue;
    }
    const expected = await readMaybe(goldenPath);
    if (expected === null) {
      bad.push(`lint/${name}: no golden (run --update-goldens)`);
    } else if (expected !== actual) {
      bad.push(`lint/${name}: differs from golden`);
    }
  }
  if (update) {
    return bad.length === 0
      ? { name: "L4", ok: true, detail: `captured ${captured} lint golden(s)` }
      : { name: "L4", ok: false, detail: bad.join("\n") };
  }
  return bad.length === 0
    ? {
      name: "L4",
      ok: true,
      detail: `${LINT_FIXTURES.length} lint golden(s) match`,
    }
    : { name: "L4", ok: false, detail: bad.join("\n") };
}

/** Materialise the L4 fixture project trees from their specs (deterministic). */
async function materialiseFixtures(): Promise<void> {
  for (const name of GEN_FIXTURES) {
    const specPath = join(CORPUS, "valid", `${name}.rune`);
    const text = await Deno.readTextFile(specPath);
    const plan = planManifest(`corpus/valid/${name}.rune`, text, new Set());
    const dir = join(PROJECTS, name);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
    for (const f of [...plan.toCreate, ...plan.toRegenerate]) {
      const abs = join(dir, f.path);
      await Deno.mkdir(dirname(abs), { recursive: true });
      await Deno.writeTextFile(abs, f.content);
    }
  }
}

// ---- driver ----------------------------------------------------------------

async function main() {
  if (update) await materialiseFixtures();

  const all: Array<[string, () => GateResult | Promise<GateResult>]> = [
    ["drift", gateDrift],
    ["corpus", gateCorpus],
    ["l1", gateL1],
    ["l0", gateL0],
    [
      "l2",
      () =>
        gateGolden(
          "L2",
          "parse",
          (p) => stableJson(parse(Deno.readTextFileSync(p))),
        ),
    ],
    [
      "l3",
      () =>
        gateGolden("L3", "manifest", (p) =>
          stableJson(
            planManifest(
              `corpus/valid/${stem(p)}.rune`,
              Deno.readTextFileSync(p),
              new Set(),
            ),
          )),
    ],
    ["l4", gateL4],
    ["l5", gateL5],
    ["l6", gateL6],
    ["l7", gateL7],
    ["governance", gateGovernance],
    ["grammar", gateGrammar],
  ];

  const selected = gateArg
    ? all.filter(([k]) =>
      k === gateArg || k === `l${gateArg.replace(/^l/, "")}`
    )
    : all;
  if (gateArg && selected.length === 0) {
    console.error(
      `unknown gate: ${gateArg} (have: ${
        all.map(([k]) => k).join(", ")
      }, drift)`,
    );
    Deno.exit(2);
  }

  let failed = 0;
  for (const [, run] of selected) {
    const r = await run();
    const tag = r.ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`[${tag}] ${r.name} — ${r.ok ? r.detail : ""}`);
    if (!r.ok) {
      console.log(r.detail.split("\n").map((l) => "       " + l).join("\n"));
      failed++;
    }
  }
  if (update) {
    console.log("\ngoldens updated — review the diff before committing.");
  }
  console.log(
    failed === 0
      ? "\nverify: GREEN"
      : `\nverify: RED (${failed} gate(s) failed)`,
  );
  Deno.exit(failed === 0 ? 0 : 1);
}

await main();
