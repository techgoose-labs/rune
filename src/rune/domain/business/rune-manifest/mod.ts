// Rune manifest: walk a parsed rune AST, compute files to scaffold, render
// templates, return a plan. Idempotent — never produces a plan entry for a path
// that already exists in the project file set.

import {
  type BoundaryStepNode,
  type CseNode,
  type DtoNode,
  type EntNode,
  type NonNode,
  parse,
  type PlyNode,
  type ReqNode,
  type SrvNode,
  type StepLike,
  type StepNode,
  type TypNode,
} from "@rune/domain/business/rune-parse/mod.ts";
import {
  applyCase,
  type Binding,
  bindings,
  canonicalSpecPath,
  CORE_SPEC_REL,
  isCoreSpec,
  isProjectSpec,
  moduleFromSpecPath,
  processName,
  transformName,
  typFileName,
} from "@rune/domain/business/rune-bindings/mod.ts";
import {
  collectNounMethods,
  type MethodSig,
  renderImpl,
  renderParams,
  toPascal,
} from "@rune/domain/business/rune-sig/mod.ts";
import {
  type FieldSource,
  TYP_MODIFIERS,
} from "@rune/domain/business/rune-modifiers/mod.ts";
import type { Artifact } from "@rune/domain/business/artifact/mod.ts";

export interface FilePlan {
  path: string;
  content: string;
}

export interface ManifestPlan {
  module: string;
  rune: string;
  toCreate: FilePlan[];
  // Spec-owned files (sig.ts) rewritten on every run, even if they already exist.
  toRegenerate: FilePlan[];
  // Create-once files that already exist (preserved). Carry their freshly-generated content so
  // `rune sync --regen <path>` can offer it as a `.new` sibling without re-running the manifest.
  toSkip: FilePlan[];
  errors: string[];
}

/** How a generated file behaves across re-runs. */
export type Lifecycle =
  | "regenerate" // spec-owned: rewritten in full every run (the contract, e.g. sig.ts)
  | "create-once"; // dev-owned: written once, then never overwritten (your bodies)

/** Per-role policy. `role` keys are template names (DEFAULT_TEMPLATES) plus the
 * two signature roles "business-sig"/"adapter-sig". Registry-driven (WO-8) so the
 * regenerate-vs-protect-vs-prune behaviour is describable in the Studio, not
 * hard-coded here. */
export interface TemplatePolicy {
  lifecycle?: Lifecycle;
  /** Whether `sync --prune` may delete this role's slot when the spec drops it. */
  prunable?: boolean;
}

/** Optional artifact-driven overrides (WO-4a/4b). When omitted, the engine's
 * static defaults apply — so existing callers and the L3 goldens are unchanged. */
export interface ManifestOptions {
  /** Layout bindings (placeholder -> rune element), e.g. from artifact.bindings. */
  bindings?: Record<string, Binding>;
  /** Codegen body templates keyed by name (see DEFAULT_TEMPLATES), e.g. from
   * artifact.codegen.templates. Merged over the defaults, so a partial map only
   * overrides the keys it provides. */
  codegen?: Record<string, string>;
  /** Per-role lifecycle/prune policy, e.g. from artifact.codegen.policies.
   * Merged over DEFAULT_POLICIES; defaults preserve current behavior. */
  policies?: Record<string, TemplatePolicy>;
  /** Enforce that every boundary `service:noun.verb(...)` resolves to a declared
   * [SRV] (shared from core.rune or local) — an undeclared service becomes a
   * plan error. The user-facing entrypoints (check/sync/manifest/dev) set this;
   * raw codegen callers (studio preview, golden capture) leave it off. */
  strictServices?: boolean;
  /** The absolute project root the entrypoint resolved. Diagnostics-only: paired
   * with `coreSpecFound` to name the root in the root-resolution error below. */
  projectRoot?: string;
  /** Whether the entrypoint found a core spec FILE under `projectRoot` (see
   * coreSpecExists). When `strictServices` finds undeclared services and this is
   * explicitly `false`, the planner emits ONE root-resolution diagnostic — the
   * resolved root almost certainly doesn't point at the rune project, so no
   * core.rune could declare anything — instead of N "undeclared service" errors
   * that send the user to edit an already-correct spec/core. Left `undefined` by
   * raw codegen callers, who keep the per-service behavior. */
  coreSpecFound?: boolean;
}

/** Map a loaded artifact to the engine's options: layout bindings, codegen
 * templates, and per-role lifecycle/prune policies. Lets the CLI (manifest/sync)
 * drive generation from an edited keywords.json — the same artifact the Studio
 * edits — instead of the static engine defaults. */
export function artifactToOptions(artifact: Artifact): ManifestOptions {
  return {
    bindings: artifact.bindings as ManifestOptions["bindings"],
    codegen: artifact.codegen?.templates,
    policies: artifact.codegen?.policies as ManifestOptions["policies"],
  };
}

/** A file the spec no longer declares, classified by who owns it. `spec`-owned
 * files (regenerated contracts) are safe to prune; `dev`-owned files hold
 * hand-written bodies and need an explicit --force. */
export interface DeletePlan {
  path: string;
  owned: "spec" | "dev";
}

// Plan a manifest run. Pure: no I/O. The caller decides whether to actually write.
export function planManifest(
  runePath: string,
  runeText: string,
  existingFiles: Set<string>,
  opts: ManifestOptions = {},
  // The project's shared `[SRV]` set, loaded from src/core/core.rune by the
  // entrypoint. Merged below so a module's boundary steps resolve their service
  // metadata (transport/env/docs) without re-declaring `[SRV]` locally. Pure:
  // the loading happens in the entrypoint, keeping this planner I/O-free.
  sharedSrvs?: Map<string, SrvNode>,
): ManifestPlan {
  // The DTO file-name slot is resolved from the artifact when supplied; falling
  // back to the engine's static binding keeps generated output byte-identical
  // (L3 holds) until a caller deliberately mutates the artifact (L6).
  const nameBinding = opts.bindings?.["<name>"] ?? bindings["<name>"];
  // Codegen templates come from the artifact when supplied, else the engine
  // defaults — merged so a partial override only changes the keys it names.
  // Set on a module-level slot read by the (synchronous) render helpers below.
  activeTemplates = opts.codegen
    ? { ...DEFAULT_TEMPLATES, ...opts.codegen }
    : DEFAULT_TEMPLATES;
  // Per-role policy: registry overrides merged over the engine defaults. Set on a
  // module-level slot so the (synchronous) adders + resolvePolicy() can read it.
  activePolicies = opts.policies ?? null;
  const ast = parse(runeText);
  const module = ast.module ?? moduleFromSpecPath(runePath);
  const errors: string[] = ast.errors.map((e) =>
    `${runePath}:${e.line + 1}: ${e.message}`
  );
  const plan: ManifestPlan = {
    module: module ?? "",
    rune: runePath,
    toCreate: [],
    toRegenerate: [],
    toSkip: [],
    errors,
  };
  if (!module) {
    plan.errors.push(
      `${runePath}: no [MOD] directive and could not derive module name`,
    );
    return plan;
  }

  const wantedFiles = new Map<string, string>(); // create-if-absent (lifecycle: create-once)
  const regenFiles = new Map<string, string>(); // spec-owned, always (re)written (lifecycle: regenerate)
  const emitted = new Set<string>(); // first writer wins — replaces the per-adder de-dupe guards
  const nounMethods = collectNounMethods(ast);

  // Route an emitted file into create-once vs regenerate by its role's policy.
  const emit: Emit = (role, path, content) => {
    if (emitted.has(path)) return;
    emitted.add(path);
    if (resolvePolicy(role).lifecycle === "regenerate") {
      regenFiles.set(path, content);
    } else wantedFiles.set(path, content);
  };

  // All faults declared on each noun's boundary steps, so one data adapter's
  // smk.test covers every boundary fault (not just the first step's).
  const boundaryFaults = collectBoundaryFaults(ast);
  // Faults on each noun's UNTAGGED (business) steps, so the business test.ts
  // gets a Deno.test stub per fault — mirroring smk.test/int.test, which already
  // scaffold their faults. Without this, rune-fault-coverage flags every
  // business-step fault with no stub for the dev to fill.
  const businessFaults = collectBusinessFaults(ast);

  // The spec's type declarations, by name: [TYP] nodes (primitive + modifiers
  // drive field types, validator decorators, and the coordinator seam asserts)
  // and [DTO] nodes (nested-DTO resolution + isCore-aware import paths).
  const typMap = new Map(ast.typs.map((t) => [t.name, t]));
  const dtoByName = new Map(ast.dtos.map((d) => [d.name, d]));
  // [NON] prose by noun — threaded so business/data class docs carry the domain
  // object's meaning instead of discarding it (E12/E18).
  const nonByNoun = new Map(ast.nons.map((n) => [n.name, n]));
  // [SRV] declarations by name — adapter methods document their backing
  // service/transport/env from these (E20). Shared services from core.rune come
  // first; a local `[SRV]` (the core spec itself, or a not-yet-migrated module)
  // overrides on name collision.
  const srvByName = new Map<string, SrvNode>(sharedSrvs ?? []);
  for (const s of ast.srvs) srvByName.set(s.name, s);

  // STRICT [SRV] placement (entrypoint policy) — the check/sync twin of the
  // rune-service-core-only lint rule, so `rune check` and `rune lint` agree:
  // inside a project, [SRV] is declared exactly once, in src/core/core.rune.
  // Gated like the lint rule (project spec, not core — drafts judged by their
  // canonical name so authors catch it at check time); standalone specs (docs,
  // corpus fixtures — not project paths) still accept a self-contained [SRV].
  // The local decls stay merged above so this surfaces as ONE clear error, not
  // a cascade of "undeclared service" red herrings.
  if (opts.strictServices) {
    const canonical = canonicalSpecPath(runePath);
    if (isProjectSpec(canonical) && !isCoreSpec(canonical)) {
      for (const s of ast.srvs) {
        plan.errors.push(
          `[SRV] (${s.transport})${s.name} declared in a module spec (line ${
            s.line + 1
          }) — shared services must be declared once in ${CORE_SPEC_REL} ` +
            `(rune-service-core-only)`,
        );
      }
    }
  }
  const types: TypeContext = {
    typMap,
    dtoByName,
    nameBinding,
    nonByNoun,
    srvByName,
    coreSrvNames: new Set(sharedSrvs?.keys() ?? []),
  };

  // STRICT service resolution (entrypoint policy): every boundary
  // `service:noun.verb(...)` must resolve to a declared [SRV] — shared (from
  // core.rune, merged into srvByName) or local. An undeclared service is a hard
  // error surfaced by `rune check`/`manifest`/`sync`/`dev`. Raw codegen callers
  // (studio preview, golden capture) leave opts.strictServices off.
  if (opts.strictServices) {
    const usedServices = new Map<string, number>(); // service -> first line
    const collectUsedServices = (
      steps: StepLike[] | CseNode["steps"],
    ): void => {
      for (const s of steps) {
        if (s.kind === "boundary") {
          if (!usedServices.has(s.service)) usedServices.set(s.service, s.line);
        } else if (s.kind === "ply") {
          for (const c of s.cases) collectUsedServices(c.steps);
        }
      }
    };
    for (const req of ast.reqs) collectUsedServices(req.steps);
    const undeclared = [...usedServices].filter(([s]) => !srvByName.has(s));
    if (undeclared.length > 0 && opts.coreSpecFound === false) {
      // No core.rune ANYWHERE under the resolved root — so nothing could declare
      // these services. That's a root-resolution problem (the root doesn't point
      // at the rune project, e.g. the spec is staged above it), NOT a spec error.
      // Emit ONE diagnostic that names the root + the fix, instead of N
      // red-herrings telling the user to edit a core.rune that's correct and
      // simply elsewhere. (Only fires when the entrypoint explicitly reports the
      // core absent; raw codegen callers leave coreSpecFound undefined and keep
      // the per-service errors below.)
      const root = opts.projectRoot ?? ".";
      const names = undeclared.map(([s]) => `"${s}"`).join(", ");
      const plural = undeclared.length > 1;
      plan.errors.push(
        `${runePath}: no core.rune found under the resolved project root ` +
          `"${root}" — shared services live in its src/core/core.rune and none ` +
          `was found there, so the boundary service${
            plural ? "s" : ""
          } ${names} ` +
          `cannot be resolved. The root is usually mis-resolved here (e.g. the ` +
          `spec is staged above the rune project): pass \`--root <project-dir>\` ` +
          `— the dir whose src/core/core.rune declares ${
            plural ? "them" : "it"
          } ` +
          `— or move the spec into that project. rune resolves the root from the ` +
          `spec's path; see \`rune sync --help\`.`,
      );
    } else {
      for (const [service, line] of undeclared) {
        plan.errors.push(
          `${runePath}:${
            line + 1
          }: undeclared service "${service}" — declare ` +
            `it as \`[SRV] (TRANSPORT)${service}: <ENV,…>\` in src/core/core.rune`,
        );
      }
    }
  }

  // Collect intended files by element type. Poly nouns are gathered UP FRONT
  // (across all [REQ]s, including nested cases) so the business-class guard in
  // walkStepsForFiles is order-independent — a noun whose untagged step appears
  // in an earlier [REQ] than its [PLY] must still be excluded from a concrete
  // business class.
  const polyNouns = new Set<string>();
  const collectPoly = (steps: StepLike[] | CseNode["steps"]): void => {
    for (const s of steps) {
      if (s.kind === "ply") {
        polyNouns.add(s.noun);
        for (const c of s.cases) collectPoly(c.steps);
      }
    }
  };
  for (const req of ast.reqs) collectPoly(req.steps);
  for (const req of ast.reqs) {
    addCoordinator(emit, module, req, runePath, types);
    walkStepsForFiles(
      req.steps,
      module,
      emit,
      nounMethods,
      polyNouns,
      runePath,
      boundaryFaults,
      businessFaults,
      types,
      plan.errors,
    );
  }
  for (const dto of ast.dtos) {
    addDto(emit, module, dto, runePath, types);
  }
  for (const typ of ast.typs) addTyp(emit, module, typ, runePath, types);
  // Shared service clients: only the core module (src/core/core.rune) declares
  // `[SRV]`, and it generates one create-once client per service into
  // src/core/data/<name>. Module specs reference these through their data
  // adapters; they never re-emit them (their ast.srvs is empty under the
  // core-only rule, and the module guard keeps a stray local `[SRV]` from
  // minting a client outside core).
  if (module === "core") {
    for (const srv of ast.srvs) addCoreService(emit, srv, runePath);
  }
  // Entrypoints: group [ENT]s by surface into one keep controller; compute each
  // ent's order/dependsOn/bind from the DTO field graph across all ents.
  if (ast.ents.length > 0) {
    // A surface is either HTTP request/response [ENT]s or a WebSocket [ENT:ws] socket.
    const httpEnts = ast.ents.filter((e) => e.kind !== "ws");
    const wsEnts = ast.ents.filter((e) => e.kind === "ws");
    const externalTypes = new Set(
      ast.typs.filter((t) => t.isExternal).map((t) => t.name),
    );
    // The process graph (order/dependsOn/bind) is an HTTP-flow concept — WS topics are
    // independent message handlers, so only the HTTP ents participate.
    const entProcess = computeEntProcess(httpEnts, dtoByName, externalTypes);
    // Ambiguous ENT→[REQ] delegation: a [REQ] is chosen by its (input, output) DTO pair, so two
    // [REQ]s with the SAME signature make the pick silent and type-correct-but-wrong. Reject it
    // rather than first-wins — the spec must disambiguate.
    for (const ent of ast.ents) {
      if (ent.delegate) {
        // Explicit delegation ([ENT] body [REQ]) resolves the pick — no ambiguity; just confirm
        // the named [REQ] exists.
        const found = ast.reqs.some((r) =>
          r.noun === ent.delegate!.noun && r.verb === ent.delegate!.verb
        );
        if (!found) {
          plan.errors.push(
            `${runePath}: [ENT] ${ent.surface}.${ent.action} delegates to [REQ] ` +
              `${ent.delegate.noun}.${ent.delegate.verb}, which is not defined`,
          );
        }
        continue;
      }
      const matches = ast.reqs.filter(
        (r) => r.input === ent.input && r.output === ent.output,
      );
      if (matches.length > 1) {
        plan.errors.push(
          `${runePath}: [ENT] ${ent.surface}.${ent.action}(${ent.input}): ${ent.output} is ` +
            `ambiguous — ${matches.length} [REQ]s share that signature (${
              matches.map((r) => `${r.noun}.${r.verb}`).join(", ")
            }); give them distinct (input): output signatures so the delegation is unambiguous`,
        );
      }
    }
    const bySurface = new Map<string, EntNode[]>();
    for (const ent of httpEnts) {
      const list = bySurface.get(ent.surface) ?? [];
      list.push(ent);
      bySurface.set(ent.surface, list);
    }
    const wsBySurface = new Map<string, EntNode[]>();
    for (const ent of wsEnts) {
      const list = wsBySurface.get(ent.surface) ?? [];
      list.push(ent);
      wsBySurface.set(ent.surface, list);
    }
    // A surface can't be both an HTTP controller and a WebSocket socket.
    for (const surface of wsBySurface.keys()) {
      if (bySurface.has(surface)) {
        plan.errors.push(
          `${runePath}: surface "${surface}" is declared as both an HTTP [ENT] and a ` +
            `WebSocket [ENT:ws] — give them distinct surfaces`,
        );
      }
    }
    for (const [surface, ents] of bySurface) {
      addEntrypointSurface(
        emit,
        module,
        surface,
        ents,
        ast.reqs,
        entProcess,
        runePath,
        types,
      );
    }
    for (const [surface, ents] of wsBySurface) {
      addWsSocketSurface(
        emit,
        module,
        surface,
        ents,
        ast.reqs,
        runePath,
        types,
      );
    }
  }
  if (ast.reqs.length > 0) {
    // The shared services this module actually references (used boundary service
    // names ∩ the merged [SRV] set) — surfaced in the module front-door so a
    // reader sees its backing-service dependencies even though they are declared
    // once in core.rune, not here.
    const usedSrvs: SrvNode[] = [];
    const seenSrv = new Set<string>();
    for (const methods of nounMethods.values()) {
      for (const m of methods) {
        if (m.service && !seenSrv.has(m.service) && srvByName.has(m.service)) {
          seenSrv.add(m.service);
          usedSrvs.push(srvByName.get(m.service)!);
        }
      }
    }
    addModRoot(
      emit,
      module,
      ast.reqs,
      runePath,
      ast.nons,
      ast.typs,
      usedSrvs,
      ast.moduleDescription,
    );
  }

  // Split into toCreate / toSkip based on existence; regenerate-lifecycle files always (re)write.
  for (const [path, content] of wantedFiles) {
    if (existingFiles.has(path)) plan.toSkip.push({ path, content });
    else plan.toCreate.push({ path, content });
  }
  for (const [path, content] of regenFiles) {
    plan.toRegenerate.push({ path, content });
  }
  // Stable ordering for output.
  plan.toCreate.sort((a, b) => a.path.localeCompare(b.path));
  plan.toRegenerate.sort((a, b) => a.path.localeCompare(b.path));
  plan.toSkip.sort((a, b) => a.path.localeCompare(b.path));

  return plan;
}

// ---- step traversal ----

/** Emit a generated file under its role's lifecycle policy. First writer per
 * path wins (replaces the old per-adder `out.has(...)` de-dupe guards). */
type Emit = (role: string, path: string, content: string) => void;

/** The spec's [TYP]/[DTO] declarations + the <name> binding, threaded into the
 * renderers so signatures, seam asserts, and import paths resolve. */
interface TypeContext {
  typMap: Map<string, TypNode>;
  dtoByName: Map<string, DtoNode>;
  nameBinding: Binding;
  nonByNoun: Map<string, NonNode>;
  srvByName: Map<string, SrvNode>;
  /** Names of SHARED services (declared in core.rune, merged in via sharedSrvs).
   * Only these get a `src/core/data/<name>` client import in an adapter — a
   * legacy local `[SRV]` keeps the JSDoc-only behaviour (it has no shared client
   * to point at). */
  coreSrvNames: Set<string>;
}

function walkStepsForFiles(
  steps: StepLike[] | CseNode["steps"],
  module: string,
  emit: Emit,
  nounMethods: Map<string, MethodSig[]>,
  polyNouns: Set<string>,
  runePath: string,
  boundaryFaults: Map<string, string[]>,
  businessFaults: Map<string, string[]>,
  types: TypeContext,
  errors: string[],
): void {
  for (const step of steps) {
    if (step.kind === "step") {
      // Untagged step → business feature (unless the noun is also a [PLY]).
      if (!polyNouns.has(step.noun)) {
        addBusinessFeature(
          emit,
          module,
          step.noun,
          nounMethods.get(step.noun) ?? [],
          businessFaults.get(step.noun) ?? step.faults,
          runePath,
          types,
        );
      }
    } else if (step.kind === "boundary") {
      addAdapter(
        emit,
        module,
        step,
        nounMethods.get(step.noun) ?? [],
        runePath,
        boundaryFaults.get(step.noun) ?? step.faults,
        types,
      );
    } else if (step.kind === "ply") {
      polyNouns.add(step.noun);
      addPolyFeature(emit, module, step, runePath, types, errors);
      for (const cse of step.cases) {
        walkStepsForFiles(
          cse.steps,
          module,
          emit,
          nounMethods,
          polyNouns,
          runePath,
          boundaryFaults,
          businessFaults,
          types,
          errors,
        );
      }
    }
  }
}

// ---- per-element adders ----

function addCoordinator(
  emit: Emit,
  module: string,
  req: ReqNode,
  runePath: string,
  types: TypeContext,
): void {
  const dir = `src/${module}/domain/coordinators/${
    processName(req.noun, req.verb)
  }`;
  emit(
    "coordinator-mod",
    `${dir}/mod.ts`,
    renderCoordinator(req, module, runePath, types),
  );
  // E33/E36: the ordered recipe (with its spec-line provenance) as a comment
  // block in the int-test, so the test author sees the flow under test.
  const recipe = stepRecipe(req.steps);
  const recipeBlock = recipe.length > 0
    ? `\n// Recipe (from [REQ] ${req.noun}.${req.verb} @ ${runePath}:${
      req.line + 1
    }):\n${recipe.map((l) => `//   ${l}`).join("\n")}\n`
    : "";
  emit(
    "coordinator-int-test",
    `${dir}/int.test.ts`,
    render(tpl("coordinator-int-test"), {
      req,
      runePath,
      faults: collectAllFaults(req),
      recipe: recipeBlock,
    }),
  );
}

function addBusinessFeature(
  emit: Emit,
  module: string,
  noun: string,
  methods: MethodSig[],
  faults: string[],
  runePath: string,
  types: TypeContext,
): void {
  const kebab = applyCase(noun, "kebab");
  const dir = `src/${module}/domain/business/${kebab}`;
  // Business classes are pure (no I/O): sync signatures.
  emit(
    "business-impl",
    `${dir}/mod.ts`,
    renderImpl(noun, methods, {
      typMap: types.typMap,
      dtoByName: types.dtoByName,
      module,
      nameBinding: types.nameBinding,
      runePath,
      nonByNoun: types.nonByNoun,
    }),
  );
  emit(
    "business-test",
    `${dir}/test.ts`,
    renderBusinessTest(
      noun,
      methods,
      faults,
      runePath,
      types.nonByNoun.get(noun)?.description,
    ),
  );
}

function addPolyFeature(
  emit: Emit,
  module: string,
  ply: PlyNode,
  runePath: string,
  types: TypeContext,
  errors: string[],
): void {
  // A [PLY] with no [CSE] has zero variants: the poly-mod barrel would re-export
  // `./implementations//mod.ts` (a double-slash path to a module that is never
  // emitted), and firstVariant would be "" — the generated project fails to
  // resolve. Surface it as a manifest error and emit nothing for this PLY.
  if (ply.cases.length === 0) {
    errors.push(
      `${runePath}:${
        ply.line + 1
      }: [PLY] ${ply.noun}.${ply.verb} requires at ` +
        `least one [CSE] (a polymorphic step needs ≥1 variant case)`,
    );
    return;
  }
  const noun = applyCase(ply.noun, "kebab");
  const dir = `src/${module}/domain/business/${noun}`;
  // Render the poly signature the same way the sig/impl split does: PascalCase
  // class identifiers, params typed `name: unknown`, and an `unknown` return —
  // so the generated base + variants type-check (method presence is the contract;
  // DTO parity is enforced separately). Templates read these off `ply` unchanged.
  const typedPly = {
    ...ply,
    noun: toPascal(ply.noun),
    params: renderParams(ply.params),
    output: "unknown",
  };
  // E35/E48: dispatch docs — the variant roster, the [NON] domain prose, and the
  // REAL spec signature (the abstract method is typed to `unknown` for safety).
  const variants = ply.cases.map((c) => c.name).join(", ");
  const nonDesc = types.nonByNoun.get(ply.noun)?.description;
  const nonDoc = nonDesc ? `// ${typedPly.noun}: ${nonDesc}\n` : "";
  const realSig = `${ply.verb}(${ply.params.join(", ")}): ${ply.output}`;
  const polyCtx = { ply: typedPly, runePath, variants, nonDoc, realSig };
  emit(
    "poly-base-mod",
    `${dir}/base/mod.ts`,
    render(tpl("poly-base-mod"), polyCtx),
  );
  emit(
    "poly-base-test",
    `${dir}/base/test.ts`,
    render(tpl("poly-base-test"), polyCtx),
  );
  const firstVariant = ply.cases[0]?.name ?? "";
  emit(
    "poly-mod",
    `${dir}/poly-mod.ts`,
    render(tpl("poly-mod"), {
      ply: typedPly,
      runePath,
      firstVariant: applyCase(firstVariant, "kebab"),
    }),
  );
  // @-aliased import from a variant up to its base — variants live two levels
  // below `dir` (implementations/<variant>/), so a relative import would be
  // "../../base/…" which the import-aliases rule forbids.
  const baseImport = `@/${dir}/base/mod.ts`;
  for (const cse of ply.cases) {
    const caseDir = `${dir}/implementations/${applyCase(cse.name, "kebab")}`;
    const typedCse = { ...cse, name: toPascal(cse.name) };
    emit(
      "poly-impl-mod",
      `${caseDir}/mod.ts`,
      render(tpl("poly-impl-mod"), {
        ply: typedPly,
        cse: typedCse,
        runePath,
        baseImport,
      }),
    );
    emit(
      "poly-impl-test",
      `${caseDir}/test.ts`,
      render(tpl("poly-impl-test"), { ply: typedPly, cse: typedCse, runePath }),
    );
  }
}

function addAdapter(
  emit: Emit,
  module: string,
  step: { service: string; noun: string; faults: string[]; line: number },
  methods: MethodSig[],
  runePath: string,
  faults: string[],
  types: TypeContext,
): void {
  const kebab = applyCase(step.noun, "kebab");
  const dir = `src/${module}/domain/data/${kebab}`;
  // Data adapters do I/O: Promise-wrapped returns (the coordinator awaits).
  emit(
    "adapter-impl",
    `${dir}/mod.ts`,
    renderImpl(step.noun, methods, {
      async: true,
      typMap: types.typMap,
      dtoByName: types.dtoByName,
      module,
      nameBinding: types.nameBinding,
      runePath,
      nonByNoun: types.nonByNoun,
      srvByName: types.srvByName,
      sharedSrvNames: types.coreSrvNames,
    }),
  );
  // Cover every fault declared on ANY boundary step for this noun, not just the
  // first one — one adapter serves all of the noun's boundary calls, and
  // rune-fault-coverage expects a test for each declared fault.
  // E34: list the boundary methods this adapter fronts (+ backing service) as a
  // comment, so the smoke test names what it must reach.
  const methodList = methods.length > 0
    ? "\n// Boundary methods to reach:\n" +
      methods.map((m) => {
        const svc = m.service ? ` (service: ${m.service})` : "";
        return `//   ${toPascal(step.noun)}.${m.verb}(${
          m.params.join(", ")
        })${svc}`;
      }).join("\n") + "\n"
    : "";
  emit(
    "adapter-smk-test",
    `${dir}/smk.test.ts`,
    render(tpl("adapter-smk-test"), { step, runePath, faults, methodList }),
  );
}

function addDto(
  emit: Emit,
  module: string,
  dto: DtoNode,
  runePath: string,
  types: TypeContext,
): void {
  const fileName = transformName(dto.name, types.nameBinding);
  const dir = dto.isCore ? "src/core/dto" : `src/${module}/dto`;
  emit("dto", `${dir}/${fileName}.ts`, renderDto(dto, runePath, module, types));
}

function addTyp(
  emit: Emit,
  module: string,
  typ: TypNode,
  runePath: string,
  types: TypeContext,
): void {
  // Disambiguate against a same-dir [DTO] that strips to the same stem (e.g.
  // [TYP] principal vs [DTO] PrincipalDto): the [DTO] keeps `dto/principal.ts`,
  // this [TYP] becomes `dto/principal-type.ts`, so neither clobbers the other.
  const dtoNamesSameDir = [...types.dtoByName.values()]
    .filter((d) => !!d.isCore === !!typ.isCore)
    .map((d) => d.name);
  const fileName = typFileName(typ.name, dtoNamesSameDir, types.nameBinding);
  const dir = typ.isCore ? "src/core/dto" : `src/${module}/dto`;
  emit("typ", `${dir}/${fileName}.ts`, renderTyp(typ, runePath, module, types));
}

// The shared client for one `[SRV]`, generated ONCE from core.rune into the
// shared kernel's data slot src/core/data/<name>/mod.ts ("adapter for an
// external system", mirroring the isCore dto/ path). A `[SRV]` carries no
// methods — the per-noun data adapters hold the queries — so the client is a
// connection/config seam: an `<Name>Service` class documenting its transport,
// env vars, and @docs link for the dev to wire. create-once, so `sync` never
// clobbers a filled-in client.
function addCoreService(emit: Emit, srv: SrvNode, runePath: string): void {
  const kebab = applyCase(srv.name, "kebab");
  const cls = `${toPascal(srv.name)}Service`;
  const env = srv.envVars.length ? ` — env: ${srv.envVars.join(", ")}` : "";
  const doc = [`${srv.name} (transport ${srv.transport})${env}`];
  if (srv.description) doc.push(jsdocSafe(srv.description));
  if (srv.docsLink) doc.push(`@see ${srv.docsLink}`);
  const lines = [
    `// Generated by rune manifest from ${runePath}.`,
    "// Shared service client. Scaffolded once; fill in the body. `sync` preserves this file.",
    "",
    "/**",
    ...doc.map((d) => ` * ${d}`),
    " */",
    `export class ${cls} {`,
    srv.envVars.length
      ? `  // Wire this client from env: ${srv.envVars.join(", ")}`
      : "  // Wire this client.",
    "}",
    "",
  ];
  emit("core-service", `src/core/data/${kebab}/mod.ts`, lines.join("\n"));
  // The shared-kernel data slot requires a connectivity smoke test (canonical
  // src/core/data/<service>/smk.test.ts). A placeholder mirroring the module
  // adapter smk.test — the dev fills it in once the client is wired.
  const test = [
    `// Generated by rune manifest from ${runePath}.`,
    "// Edit the body. Re-running manifest will not overwrite this file.",
    "",
    `Deno.test("${srv.name} — connectivity", () => {`,
    `  // TODO: smoke test that ${cls} can reach ${srv.name} (transport ${srv.transport})`,
    "});",
    "",
  ];
  emit(
    "core-service-test",
    `src/core/data/${kebab}/smk.test.ts`,
    test.join("\n"),
  );
}

// The rune parser accepts arbitrary prose in a description (rune-parse:610-614)
// once inline `//` comments are stripped — including the JSDoc comment-close
// sequence `*/` (which is not a `//` comment, so it survives). Interpolated verbatim into a
// `/** ... */` block it would terminate the comment early and dump the rest as
// bare tokens — an uncompilable .ts. Break the sequence with a zero-width space
// so the prose still reads the same in an editor but the comment stays open.
function jsdocSafe(description: string): string {
  return description.replaceAll("*/", "*​/");
}

// TS primitives / keywords that may legitimately appear in a `[TYP]` union — a
// union containing any of these is a REAL type union (e.g. `string | number`),
// NOT a string-literal enum, so its members are left unquoted (enumMembers).
const TS_TYPE_TOKENS = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "object",
  "null",
  "undefined",
  "void",
  "unknown",
  "any",
  "never",
  "true",
  "false",
  "Uint8Array",
  "Date",
]);

// A bare-word union like `GET | POST | DELETE` (or `draft | sent | declinedBot`)
// is a STRING-LITERAL ENUM: each member is a value, not a TS type reference, so
// it must be quoted — emitted bare it compiles to `Cannot find name 'GET'`
// (TS2304). Returns the members when `typeName` is such an enum, else null: a
// real type union (`string | number`, `FooDto | BarDto`), an already-quoted
// union, or any non-union passes through verbatim.
function enumMembers(typeName: string): string[] | null {
  if (!typeName.includes("|")) return null;
  const parts = typeName.split("|").map((p) => p.trim());
  if (parts.length < 2) return null;
  for (const p of parts) {
    if (!/^[A-Za-z_$][\w$]*$/.test(p)) return null; // quoted / numeric / generic
    if (TS_TYPE_TOKENS.has(p)) return null; // a real primitive union
    if (/Dto$/.test(p)) return null; // a union of DTO references
  }
  return parts;
}

// The members of an enum [TYP] as a TS array literal: `["GET", "POST", …]` —
// shared by the field type, the @IsIn validator, and the @ApiProperty enum hint.
function enumList(members: string[]): string {
  return `[${members.map((m) => JSON.stringify(m)).join(", ")}]`;
}

// Map a rune [TYP] primitive to a TS type + the class-validator decorator that
// validates it. Unknown/unmapped types keep their TS spelling with no decorator.
function tsFor(
  typeName: string | undefined,
): { ts: string; dec: string | null } {
  switch (typeName) {
    case "string":
      return { ts: "string", dec: "IsString" };
    case "number":
      return { ts: "number", dec: "IsNumber" };
    case "boolean":
      return { ts: "boolean", dec: "IsBoolean" };
    case undefined:
      // No [TYP] matched the field name — emit `unknown` with no validator.
      // renderDto flags these with a `// TODO: tighten` marker so the gap stays visible.
      return { ts: "unknown", dec: null };
    default: {
      // A bare-word union is a string-literal enum — quote the members so it
      // type-checks (`"GET" | "POST"`); renderDto/renderTyp validate it with
      // @IsIn. Anything else (a nested [DTO], a generic) passes through verbatim.
      const members = enumMembers(typeName);
      if (members) {
        return {
          ts: members.map((m) => JSON.stringify(m)).join(" | "),
          dec: null,
        };
      }
      return { ts: typeName, dec: null };
    }
  }
}

// The example modifier's value as a typed TS literal: numeric for number
// types, true/false for booleans, a quoted string otherwise.
function exampleLiteral(value: string, typeName: string | undefined): string {
  if (typeName === "number" && /^-?\d+(\.\d+)?$/.test(value)) return value;
  if (typeName === "boolean" && (value === "true" || value === "false")) {
    return value;
  }
  return JSON.stringify(value);
}

// Resolve a [DTO] property's base name to a nested DTO class. Precedence: the
// name IS a DTO verbatim; then an exact `[TYP] <name>` is AUTHORITATIVE — it
// resolves through its declared type (which only names a DTO when the [TYP]
// aliases one; a primitive [TYP] yields `undefined`, so the field is NOT
// nested); only with no `[TYP]` do we fall back to the `pascal(name)+"Dto"`
// convention. Without this order a field whose name collides with a same-stem
// [DTO] (e.g. `principal` <-> `PrincipalDto`) was wrongly nested — often
// self-referentially — instead of taking its declared [TYP] primitive.
function nestedDtoFor(
  base: string,
  types: TypeContext,
): DtoNode | undefined {
  const verbatim = types.dtoByName.get(base);
  if (verbatim) return verbatim;
  const typ = types.typMap.get(base);
  if (typ) return types.dtoByName.get(typ.typeName);
  return types.dtoByName.get(`${toPascal(base)}Dto`);
}

// The isCore-aware directory a DTO class is generated into.
function dtoDir(name: string, module: string, types: TypeContext): string {
  return types.dtoByName.get(name)?.isCore
    ? "src/core/dto"
    : `src/${module}/dto`;
}

// A DTO is a class-validator / class-transformer class. Field types come from
// the [TYP] declarations (no more `unknown`), each typed field gets its
// validator plus the decorators of its [TYP] constraint modifiers, and fields
// naming another [DTO] become @ValidateNested/@Type(() => X) members.
function renderDto(
  dto: DtoNode,
  runePath: string,
  module: string,
  types: TypeContext,
): string {
  const validators = new Set<string>();
  const nestedImports = new Set<string>();
  let hasNested = false;
  let hasApiProperty = false;
  const fields = dto.properties.map((raw) => {
    // A property may carry the documented modifiers: `(s)` (array of the base
    // type, property name pluralized — `taskId(s)` -> `taskIds: taskId[]`) and
    // `?` (optional). Resolve the base name to its [TYP] for the field type.
    // `(s?)` — array whose ELEMENTS may be null (dirty inbound data); distinct from a whole-field
    // `?` (optional). Strip the array token first so a trailing `?` still reads as whole-optional.
    const lenientArray = /\(s\?\)/.test(raw);
    const array = lenientArray || /\(s\)/.test(raw);
    const withoutArray = raw.replace(/\(s\??\)/g, "");
    const optional = withoutArray.includes("?");
    const base = withoutArray.replace(/\?/g, "").trim();
    const name = array ? `${base}s` : base;
    const decorators: string[] = [];
    // Per-field doc/provenance comments emitted ABOVE the decorator stack so a
    // dev sees the field's meaning, its [TYP] origin, and its modifiers inline
    // (E23/E24/E25/E28). JSDoc first so editor hover attaches to the field.
    const lead: string[] = [];
    if (optional) {
      validators.add("IsOptional");
      decorators.push("@IsOptional()");
    }
    if (array) {
      validators.add("IsArray");
      decorators.push("@IsArray()");
    }

    // Nested DTO field: validated recursively. class-transformer's @Type tells
    // assert's plainToInstance which class the plain sub-object becomes.
    const nested = nestedDtoFor(base, types);
    if (nested) {
      hasNested = true;
      if (nested.name !== dto.name) nestedImports.add(nested.name);
      if (nested.description) {
        lead.push(`/** ${jsdocSafe(nested.description)} */`);
      }
      if (array) {
        lead.push(
          `// rune: ${base}(${
            lenientArray ? "s?" : "s"
          }) — array of [DTO] ${nested.name}` +
            (lenientArray ? " (elements not validated — may be null)" : ""),
        );
      }
      // `(s?)` keeps @IsArray() (pushed above) but drops @ValidateNested so a null/dirty element
      // passes — class-validator has no per-element "nullable", so leniency = no element check.
      if (!lenientArray) {
        validators.add("ValidateNested");
        decorators.push(
          array ? "@ValidateNested({ each: true })" : "@ValidateNested()",
        );
      }
      decorators.push(`@Type(() => ${nested.name})`);
      const ts = array ? `${nested.name}[]` : nested.name;
      return { name, ts, decorators, optional, lead };
    }

    const typ = types.typMap.get(base);
    const { ts: baseTs, dec } = tsFor(typ?.typeName);
    // A union element (`"a" | "b"`, `x | y`) must be parenthesized before `[]`,
    // else `"a" | "b"[]` parses as `"a" | ("b"[])`. Non-unions keep bare `T[]`.
    const ts = array
      ? (baseTs.includes("|") ? `(${baseTs})[]` : `${baseTs}[]`)
      : baseTs;
    // A field whose base resolves to no [TYP] lands as `unknown` with no
    // validator — @Allow() keeps it on the instance (assert validates with
    // whitelist: true, which strips undecorated properties), and the marker
    // keeps the un-validated gap visible.
    if (baseTs === "unknown") {
      validators.add("Allow");
      decorators.unshift(
        `// TODO: tighten — "${base}" has no [TYP], left as ${ts}`,
        `// Add \`[TYP] ${base}: <type>\` to the .rune to type it.`,
        "@Allow()",
      );
      return { name, ts, decorators, optional, lead };
    }
    // [TYP] field: doc comment from the type's description, a provenance line
    // echoing the (singular) base declaration, and notes for ext / array.
    if (typ?.description) lead.push(`/** ${jsdocSafe(typ.description)} */`);
    if (typ) {
      const provTag = typ.modifiers.length > 0
        ? `[TYP:${typ.modifiers.join(",")}]`
        : "[TYP]";
      lead.push(`// rune declares: ${provTag} ${base}: ${typ.typeName}`);
    }
    if (typ?.isExternal) {
      lead.push("// rune: [TYP:ext] — supplied by another module / the caller");
    }
    if (array) {
      lead.push(
        `// rune: ${base}(${
          lenientArray ? "s?" : "s"
        }) — array of [TYP] ${base}` +
          (lenientArray ? " (elements not validated — may be null)" : ""),
      );
    }
    // The [TYP]'s constraint modifiers, in source order. `int` REPLACES the
    // IsNumber base check (class-validator's IsInt subsumes it). Alongside the
    // validators we accumulate ONE merged @ApiProperty options object (E27).
    // Keys/values are restricted to what #api-doc's Schema type actually accepts
    // (@danet/swagger): NO `required`/`isArray` (not Schema keys — optionality
    // and arrays are carried by @IsOptional/@IsArray + the TS type), and `format`
    // only for valid DataFormat values (uuid/email/uri are NOT — their
    // @IsUUID/@IsEmail/@IsUrl validators enforce them instead).
    const constraints: string[] = [];
    const api: string[] = [];
    // Per-element schema hints for an ARRAY field. OpenAPI applies `minimum`/
    // `maximum`/`type` placed on an array property to the array itself (bounds
    // are silently ignored; a scalar `type` even overrides the array type),
    // contradicting number[]/@IsArray. So for arrays these nest under `items`
    // — mirroring the per-element validators (@Min(..,{each:true})). Scalars
    // stay on the property.
    const itemHint: string[] = [];
    const pushHint = (h: string) => (array ? itemHint : api).push(h);
    if (typ?.description) {
      api.push(`description: ${JSON.stringify(typ.description)}`);
    }
    let baseDec = dec;
    for (const mod of typ?.modifiers ?? []) {
      const eq = mod.indexOf("=");
      const id = eq === -1 ? mod : mod.slice(0, eq);
      const value = eq === -1 ? null : mod.slice(eq + 1);
      // example=<v> → schema example: keep's runner/cake fill required, unbound
      // input fields from it, so a field nothing produces stops being a 422.
      if (id === "example" && value !== null && value !== "") {
        const lit = exampleLiteral(value, typ?.typeName);
        api.push(`example: ${array ? `[${lit}]` : lit}`);
        continue;
      }
      const spec = TYP_MODIFIERS.get(id);
      if (!spec?.decorator) continue; // ext/core — placement, not validation
      if (id === "int") baseDec = null;
      // `(s?)` is lenient: skip per-element validators (they would reject a null element).
      if (!lenientArray) {
        validators.add(spec.decorator);
        constraints.push(array ? spec.eachCall(value) : spec.call(value));
      }
      // Schema hints — only keys/values valid on @danet/swagger's Schema. For
      // arrays these describe each ELEMENT, so route them under `items`.
      if (id === "min") pushHint(`minimum: ${value}`);
      else if (id === "max") pushHint(`maximum: ${value}`);
      else if (id === "positive") pushHint("exclusiveMinimum: 0");
      else if (id === "int") pushHint(`type: "integer"`);
      else if (id === "nonempty" && !array) api.push("minLength: 1");
    }
    // A bare-word union [TYP] (`GET | POST | …`) is a string-literal enum: the
    // field is typed as the quoted union (tsFor) and validated with @IsIn rather
    // than left to @Allow(). `(s)` arrays validate per element; `(s?)` skips the
    // element check (like the modifier constraints) but still documents the enum.
    const enumVals = typ ? enumMembers(typ.typeName) : null;
    if (enumVals) {
      const list = enumList(enumVals);
      if (!lenientArray) {
        validators.add("IsIn");
        constraints.push(
          array ? `@IsIn(${list}, { each: true })` : `@IsIn(${list})`,
        );
      }
      pushHint(`enum: ${list}`);
    }
    if (typ?.typeName === "Uint8Array") {
      api.push(`type: "string"`, `format: "binary"`);
    }
    if (itemHint.length > 0) api.push(`items: { ${itemHint.join(", ")} }`);
    // `(s?)` arrays keep only @IsArray() (emitted above) — the element type check is dropped so
    // dirty inbound data (e.g. a null in pathway_tags) is tolerated instead of hard-422ing.
    if (baseDec && !lenientArray) {
      validators.add(baseDec);
      if (!array) {
        decorators.push(`@${baseDec}()`);
      } else if (baseDec === "IsNumber") {
        // IsNumber(options?, validationOptions?) — `each` is a validation option,
        // so it belongs in the SECOND arg. `@IsNumber({ each: true })` puts it in
        // IsNumberOptions (TS2353). IsString/IsBoolean take only validationOptions,
        // so their single-arg each-form is already correct.
        decorators.push(`@IsNumber({}, { each: true })`);
      } else {
        decorators.push(`@${baseDec}({ each: true })`);
      }
    }
    decorators.push(...constraints);
    // A [TYP] resolving to a non-primitive (union, generic, Uint8Array) is
    // typed at compile time but has no validator — @Allow() keeps it past
    // assert's whitelist instead of letting it be silently stripped.
    if (!baseDec && constraints.length === 0) {
      validators.add("Allow");
      decorators.push("@Allow()");
    }
    // The single merged @ApiProperty, unshifted so it leads the decorator stack.
    if (api.length > 0) {
      hasApiProperty = true;
      decorators.unshift(`@ApiProperty({ ${api.join(", ")} })`);
    }
    return { name, ts, decorators, optional, lead };
  });

  const lines: string[] = [];
  lines.push(`// Generated by rune manifest from ${runePath}.`);
  lines.push(
    "// Edit the body. Re-running manifest will not overwrite this file.",
  );
  lines.push("");
  if (hasNested) {
    // @Type reads Reflect metadata at decoration time — the side-effect import
    // must come first.
    lines.push(`import "reflect-metadata";`);
    lines.push(`import { Type } from "class-transformer";`);
  }
  if (validators.size > 0) {
    lines.push(
      `import { ${[...validators].sort().join(", ")} } from "class-validator";`,
    );
  }
  if (hasApiProperty) {
    lines.push(`import { ApiProperty } from "#api-doc";`);
  }
  for (const n of [...nestedImports].sort()) {
    const file = transformName(n, types.nameBinding);
    lines.push(
      `import { ${n} } from "@/${dtoDir(n, module, types)}/${file}.ts";`,
    );
  }
  if (hasNested || validators.size > 0) lines.push("");
  // Class JSDoc carries the [DTO] prose + a visibility tag; a provenance line
  // names the source declaration (E26). Guarded so an undescribed DTO still
  // gets the visibility tag rather than an empty /** */.
  lines.push("/**");
  if (dto.description) lines.push(` * ${jsdocSafe(dto.description)}`);
  lines.push(dto.isCore ? " * @public cross-module contract" : " * @internal");
  if (dto.isOpen) {
    lines.push(
      " * @remarks [DTO:open] — opaque inbound payload: the declared fields below (and any",
      " * declared nested DTO) are validated; this DTO's undeclared fields ride through.",
    );
  }
  lines.push(" */");
  const dtoTag = dto.isOpen
    ? "[DTO:open]"
    : dto.isCore
    ? "[DTO:core]"
    : "[DTO]";
  lines.push(
    `// rune declares: ${dtoTag} ${dto.name}: ${dto.properties.join(", ")}`,
  );
  lines.push(`export class ${dto.name} {`);
  if (dto.isOpen) {
    // keep's assert reads this marker: it validates the declared fields strictly, then re-attaches
    // this payload's undeclared top-level fields, so an opaque inbound body rides through. Delete
    // it for strict mode.
    lines.push("  static readonly __keepOpen = true;");
    if (fields.length) lines.push("");
  }
  fields.forEach((f, i) => {
    if (i > 0) lines.push("");
    for (const d of f.lead) lines.push(`  ${d}`);
    for (const d of f.decorators) lines.push(`  ${d}`);
    lines.push(`  ${f.name}${f.optional ? "?" : "!"}: ${f.ts};`);
  });
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// A [TYP] is a named alias for its declared primitive — or for a [DTO]
// (resolution case (c)), in which case the class must be imported or the
// alias would not type-check.
function renderTyp(
  typ: TypNode,
  runePath: string,
  module: string,
  types: TypeContext,
): string {
  const { ts } = tsFor(typ.typeName);
  const tag = typ.modifiers.length > 0
    ? `[TYP:${typ.modifiers.join(",")}]`
    : "[TYP]";
  const lines = [
    // +1 → the [TYP] line in the spec (E30).
    `// Generated by rune manifest from ${runePath}:${typ.line + 1}.`,
    "// Edit the body. Re-running manifest will not overwrite this file.",
    "",
  ];
  if (types.dtoByName.has(typ.typeName)) {
    const file = transformName(typ.typeName, types.nameBinding);
    lines.push(
      `import type { ${typ.typeName} } from "@/${
        dtoDir(typ.typeName, module, types)
      }/${file}.ts";`,
      "",
    );
  }
  // E29: description as JSDoc (guarded — undescribed [TYP] emits no /** */).
  if (typ.description) lines.push(`/** ${jsdocSafe(typ.description)} */`);
  lines.push(`// rune declares: ${tag} ${typ.name}: ${typ.typeName}`);
  // E30: which class-validator decorators this type's modifiers put on every
  // DTO field of this type — so the [TYP] file documents its own enforcement.
  const enforced: string[] = [];
  for (const mod of typ.modifiers) {
    const eq = mod.indexOf("=");
    const id = eq === -1 ? mod : mod.slice(0, eq);
    const value = eq === -1 ? null : mod.slice(eq + 1);
    if (id === "example") continue; // not a validator
    const spec = TYP_MODIFIERS.get(id);
    if (!spec?.decorator) continue; // ext/core — placement, not validation
    enforced.push(spec.call(value));
  }
  if (enforced.length > 0) {
    lines.push(`// enforced on DTO fields: ${enforced.join(", ")}`);
  }
  // A bare-word union [TYP] is a string-literal enum (tsFor quotes the members);
  // DTO fields of this type are validated with @IsIn rather than left unchecked.
  const enumVals = enumMembers(typ.typeName);
  if (enumVals) {
    lines.push(`// enforced on DTO fields: @IsIn(${enumList(enumVals)})`);
  }
  if (typ.isExternal) {
    lines.push(
      "// [TYP:ext] — produced OUTSIDE this module; entrypoints wire it as a",
      "// $external input",
    );
  }
  if (typ.isCore) {
    lines.push(
      "// core: shared across modules — narrow with cross-module care.",
    );
  }
  lines.push(`export type ${toPascal(typ.name)} = ${ts};`, "");
  return lines.join("\n");
}

function camel(name: string): string {
  const p = toPascal(name);
  return p.length ? p[0].toLowerCase() + p.slice(1) : p;
}

// One test stub per method, so the test file mirrors the class instead of a
// single catch-all placeholder — plus one stub per fault declared on this noun's
// untagged steps, so rune-fault-coverage has a case to verify (smk.test/int.test
// scaffold their faults the same way). `faults` is in first-seen order, deduped.
function renderBusinessTest(
  noun: string,
  methods: MethodSig[],
  faults: string[],
  runePath: string,
  nonDesc?: string,
): string {
  const pascal = toPascal(noun);
  const L: string[] = [];
  L.push(`// Generated by rune manifest from ${runePath}.`);
  L.push("// Edit the body. Re-running manifest will not overwrite this file.");
  if (nonDesc) L.push(`// ${pascal}: ${nonDesc}`); // [NON] subject (E32)
  L.push("");
  L.push(`import { ${pascal} } from "./mod.ts";`);
  // fault -> the method that declares it, so the fault stub names its raiser.
  const faultVerb = new Map<string, string>();
  for (const m of methods) {
    for (const f of m.faults ?? []) {
      if (!faultVerb.has(f)) faultVerb.set(f, m.verb);
    }
  }
  if (methods.length > 0) {
    // A comment-only Arrange/Act/Assert skeleton (E32). Comment-only because a
    // live `new Id().generate()` is TS2576 and DTO-arg calls don't compile here.
    for (const m of methods) {
      const sig = `${m.verb}(${m.params.join(", ")})${
        m.output ? `: ${m.output}` : ""
      }`;
      L.push("");
      L.push(`Deno.test("${pascal}.${m.verb}", () => {`);
      L.push(
        m.isStatic
          ? `  // Arrange — (static) ${pascal}.${m.verb}`
          : `  // Arrange — const subject = new ${pascal}();`,
      );
      L.push(`  // Act — ${sig}`);
      L.push(
        m.output && m.output !== "void"
          ? `  // Assert — TODO: assert the ${m.output} result`
          : "  // Assert — TODO: assert the side effect",
      );
      L.push("});");
    }
  } else {
    L.push("");
    L.push(`Deno.test("${pascal}.placeholder", () => {`);
    L.push("  // TODO: test");
    L.push("});");
  }
  for (const fault of faults) {
    const raiser = faultVerb.get(fault);
    L.push("");
    L.push(`Deno.test("${fault}", () => {`);
    if (raiser) L.push(`  // raised by ${pascal}.${raiser}`);
    L.push(`  // TODO: exercise the "${fault}" fault path`);
    L.push("});");
  }
  L.push("");
  return L.join("\n");
}

// How a seam value is validated at runtime: a Dto name → assert(Cls, …); a
// [TYP] alias to a primitive → assert.<prim>(…) (the alias type IS the
// primitive, no cast needed); anything else has no runtime contract.
type Seam =
  | { kind: "dto"; cls: string }
  | {
    kind: "primitive";
    fn: "string" | "number" | "boolean" | "uint8Array";
    ts: string;
  }
  | { kind: "opaque" };

function seamFor(type: string, typMap: Map<string, TypNode>): Seam {
  if (/Dto$/.test(type)) return { kind: "dto", cls: type };
  switch (typMap.get(type)?.typeName) {
    case "string":
      return { kind: "primitive", fn: "string", ts: "string" };
    case "number":
      return { kind: "primitive", fn: "number", ts: "number" };
    case "boolean":
      return { kind: "primitive", fn: "boolean", ts: "boolean" };
    case "Uint8Array":
      return { kind: "primitive", fn: "uint8Array", ts: "Uint8Array" };
  }
  return { kind: "opaque" };
}

// The TS spelling of a seam type: primitive [TYP] aliases collapse to their
// primitive; Dto and opaque names keep their spelling.
function seamTs(type: string, typMap: Map<string, TypNode>): string {
  const seam = seamFor(type, typMap);
  return seam.kind === "primitive" ? seam.ts : type;
}

// Every fault declared in a step subtree, paired with the `noun.verb` that
// raises it — for @throws docs on coordinators and endpoints. Unlike
// collectAllFaults this keeps the raiser and does NOT dedup (a fault on two
// steps is attributed to both).
function collectFaultRaisers(
  steps: StepLike[] | CseNode["steps"],
): { fault: string; raiser: string }[] {
  const out: { fault: string; raiser: string }[] = [];
  const walk = (ss: StepLike[] | CseNode["steps"]): void => {
    for (const s of ss) {
      if (s.kind === "step" || s.kind === "boundary") {
        for (const f of s.faults) {
          out.push({ fault: f, raiser: `${s.noun}.${s.verb}` });
        }
      } else if (s.kind === "ply") {
        for (const c of s.cases) walk(c.steps);
      }
    }
  };
  walk(steps);
  return out;
}

// The spec's ordered, non-boundary step recipe as bare numbered lines (no indent
// or comment prefix). Boundaries are the shell's reads/writes/sends — only pure
// steps / [NEW] / [RET] / [PLY] dispatch belong in the recipe (E3). Shared by
// the coordinator core and the int-test (E33).
function stepRecipe(steps: StepLike[] | CseNode["steps"]): string[] {
  const out: string[] = [];
  let n = 0;
  for (const s of steps) {
    let line: string | null = null;
    if (s.kind === "step") {
      const sep = s.isStatic ? "::" : ".";
      const ret = s.output ? `: ${s.output}` : "";
      const thr = s.faults.length ? ` -> throws: ${s.faults.join(", ")}` : "";
      line = `${s.noun}${sep}${s.verb}(${s.params.join(", ")})${ret}${thr}`;
    } else if (s.kind === "ctr") {
      line = `[NEW] ${s.className}`;
    } else if (s.kind === "ret") {
      line = `[RET] ${s.value}`;
    } else if (s.kind === "ply") {
      const cases = s.cases.map((c) => c.name).join("|");
      const ret = s.output ? `: ${s.output}` : "";
      line = `[PLY] ${s.noun}.${s.verb}(${s.params.join(", ")})${ret}` +
        ` (cases: ${cases})`;
    }
    if (line) out.push(`${++n}. ${line}`);
  }
  return out;
}

// A coordinator is the imperative SHELL for a [REQ]: it validates the request
// input, loads inputs through the data adapters (boundary steps that RETURN a
// value — validated at the seam), hands them to a pure inner `<verb>Core` (the
// functional CORE — all business logic, no I/O), then takes the dtos the core
// returns and feeds them to the data adapters that produce side effects
// (boundary steps returning `void` — validated before they leave), and
// validates the result. Scaffolded straight from the rune.
// Boundary verbs that READ state — safe to run before the core's guards. Any
// OTHER value-returning boundary verb (set/add/save/assign/charge/…) is a
// value-returning MUTATION: it must run AFTER the core, so the core's guards
// (authority checks, cross-app forbidden escalations) throw before the write
// lands. Prefix-matched on the camelCase word boundary (getRecording reads;
// getaway/checkout do not match get/check).
function isReadVerb(verb: string): boolean {
  return /^(get|list|load|read|fetch|find|lookup|query|search|download|count|peek|check|exists)($|[A-Z_0-9])/
    .test(verb) ||
    /^(is|has|can|assert)[A-Z_0-9]/.test(verb);
}

function renderCoordinator(
  req: ReqNode,
  module: string,
  runePath: string,
  types: TypeContext,
): string {
  const { typMap } = types;
  const isBoundary = (s: StepLike): s is BoundaryStepNode =>
    s.kind === "boundary";
  const boundaries = req.steps.filter(isBoundary);
  const valueSteps = boundaries.filter((s) =>
    s.output !== "void" && s.output !== ""
  );
  // Value-returning boundaries split by verb: read verbs may load pre-core;
  // mutation verbs (role.addGrant, invoice.save, gateway.authorize) are
  // emitted post-core even when their args are all input-fed — emitting a
  // privilege-granting mutation in the reads block put it ABOVE every position
  // where the core's guards could reject it first (the emission-order hazard).
  const readSteps = valueSteps.filter((s) => isReadVerb(s.verb));
  // A boundary with NO declared output is a fire-and-forget side effect: it
  // joins the writes (nothing to bind — the old read path rendered `as ;`),
  // args resolved through the same post-core table.
  const sends = boundaries.filter((s) => s.output === "");
  // A read whose param is a DTO produced mid-flow (not the request input) can't
  // load before the core — it consumes a value the core builds. Such reads run
  // AFTER the core, fed from its output; loading them pre-core would pass the
  // wrong-typed request input (a TS2345 type error in the scaffold). A read is
  // "input-fed" only when every DTO param IS the request input (TYP params are
  // input fields).
  const isInputRead = (r: BoundaryStepNode): boolean =>
    r.params.every((p) => !/Dto$/.test(p) || p === req.input);
  const inputReads = readSteps.filter(isInputRead);
  const coreReads = readSteps.filter((r) => !isInputRead(r));
  const boundaryNouns = [...new Set(boundaries.map((s) => s.noun))];

  // Business classes are generated ONLY for nouns that appear as untagged
  // instance steps (addBusinessFeature, walkStepsForFiles) and aren't [PLY]
  // dispatch nouns (those get an abstract base, not a concrete class). So the
  // core may only `new` those nouns — instantiating req.noun unconditionally
  // imported a never-generated business/<noun>/mod.ts for boundary-only / [RET]
  // / pure-namespace REQs (TS2307).
  const polyNouns = new Set(
    req.steps.filter((s) => s.kind === "ply").map((s) => s.noun),
  );
  const instanceNouns = [
    ...new Set(
      req.steps
        .filter((s): s is StepNode =>
          s.kind === "step" && !polyNouns.has(s.noun)
        )
        .map((s) => s.noun),
    ),
  ];
  // Only nouns with an INSTANCE (non-static) step are constructed in the core.
  // A static-only noun (e.g. `id::generate()`) is called statically, never
  // `new`'d — emitting `const id = new Id()` for it was a latent defect (E4).
  const instanceStepNouns = new Set(
    req.steps
      .filter((s): s is StepNode =>
        s.kind === "step" && !polyNouns.has(s.noun) && !s.isStatic
      )
      .map((s) => s.noun),
  );
  const newNouns = instanceNouns.filter((n) => instanceStepNouns.has(n));

  const readVars = inputReads.map((r) => ({
    name: camel(`${r.noun}-${r.verb}`),
    type: r.output,
    noun: r.noun,
    verb: r.verb,
    params: r.params,
  }));
  // Every boundary step that runs AFTER the core, in SPEC ORDER — the recipe's
  // declared order is the execution contract (a mutation declared before the
  // audit write must land before it). "produce" steps (value-returning
  // mutations + reads consuming core output) bind a seam-asserted local.
  type PostAction =
    | { kind: "write"; step: BoundaryStepNode; field: string }
    | { kind: "send"; step: BoundaryStepNode }
    | {
      kind: "produce";
      step: BoundaryStepNode;
      name: string;
      type: string;
      mutation: boolean;
    };
  const usedFields = new Set<string>();
  const writeFieldFor = (verb: string): string => {
    let f = camel(verb);
    while (usedFields.has(f)) f += "X";
    usedFields.add(f);
    return f;
  };
  const usedLocals = new Set(readVars.map((r) => r.name));
  const produceLocalFor = (noun: string, verb: string): string => {
    let n = camel(`${noun}-${verb}`);
    while (usedLocals.has(n)) n += "X";
    usedLocals.add(n);
    return n;
  };
  const postActions: PostAction[] = [];
  for (const s of boundaries) {
    if (s.output === "void") {
      postActions.push({
        kind: "write",
        step: s,
        field: writeFieldFor(s.verb),
      });
    } else if (s.output === "") {
      postActions.push({ kind: "send", step: s });
    } else if (!isReadVerb(s.verb) || !isInputRead(s)) {
      postActions.push({
        kind: "produce",
        step: s,
        name: produceLocalFor(s.noun, s.verb),
        type: s.output,
        mutation: !isReadVerb(s.verb),
      });
    }
  }
  const produces = postActions.filter((a) => a.kind === "produce");
  // When a post-core step produces the REQ's own output, IT is the result
  // source — the core no longer returns `result` (it can't build the output a
  // boundary produces); the coordinator returns that step's asserted value.
  const resultRead =
    [...produces].reverse().find((r) => r.type === req.output) ??
      null;

  const inputSeam = seamFor(req.input, typMap);
  const outputSeam = seamFor(req.output, typMap);
  // Validated input replaces `input` everywhere downstream.
  const inputRef = inputSeam.kind === "opaque" ? "input" : "validInput";
  // The generated field names of the request input DTO — a scalar step param is
  // sourced from `inputRef.<p>` ONLY when it names one of these.
  const inputDto = types.dtoByName.get(req.input);
  const inputFields = new Set(inputDto ? dtoFieldNames(inputDto) : []);
  // Pure value-producer steps keyed by the scalar value they output (DTO outputs
  // go through the post-core read path instead). A boundary param that is neither
  // a request-input field nor a DTO is one of these produced mid-flow values —
  // `settingsKey` from a `settingsKey::current()` step, say.
  const producers = new Map<string, StepNode>();
  for (const s of req.steps) {
    if (
      s.kind === "step" && s.output && s.output !== "void" &&
      !/Dto$/.test(s.output)
    ) {
      if (!producers.has(s.output)) producers.set(s.output, s);
    }
  }
  // Which produced values the SHELL boundaries actually consume — transitively,
  // since one producer may consume another's output. These are hoisted as real
  // local bindings before the reads so a boundary references the binding instead
  // of a bogus `input.<name>` (the value isn't an input field — TS2339).
  const hoisted = new Set<string>();
  const queue: string[] = [];
  const consider = (p: string) => {
    if (
      !/Dto$/.test(p) && !inputFields.has(p) && producers.has(p) &&
      !hoisted.has(p)
    ) {
      hoisted.add(p);
      queue.push(p);
    }
  };
  for (const s of [...inputReads, ...sends, ...coreReads]) {
    s.params.forEach(consider);
  }
  while (queue.length) producers.get(queue.shift()!)!.params.forEach(consider);
  // A whole-DTO param is the coordinator's own input DTO — pass the validated input that's
  // already in scope (`validInput`, or `input` when there's no seam), not `undefined as never`.
  // A scalar param binds to a producer that ACTUALLY carries the field: the validated input
  // when the input DTO DECLARES it (echoes-are-not-producers — the request's own value is
  // authoritative), else a hoisted producer local when produced mid-flow, else the NEAREST
  // prior read whose output DTO declares the field (the 2026-09-04 wrong-DTO bug: a chain
  // `kv:a.get(x): ADto` then `kv:b.get(y): BDto` with `y` a field of ADto but not of the
  // request DTO emitted `validInput.y` — TS2339, whole-tree `deno check` break). A field NO
  // producer carries is a spec gap: emitted as a typed TODO (`undefined as never`) so the
  // gap stays visible without breaking the tree's type-check. An opaque input (no [DTO]
  // decl to consult) keeps the residual `inputRef.<p>`, unchanged from before.
  const priorReadRef = (
    p: string,
    prior: readonly { name: string; type: string }[],
  ): string | null => {
    for (let i = prior.length - 1; i >= 0; i--) {
      const d = types.dtoByName.get(prior[i].type);
      if (d && dtoFieldNames(d).includes(p)) return `${prior[i].name}.${p}`;
    }
    return null;
  };
  const scalarRef = (
    p: string,
    prior: readonly { name: string; type: string }[],
  ): string => {
    if (inputFields.has(p)) return `${inputRef}.${p}`;
    if (hoisted.has(p)) return p;
    const chained = priorReadRef(p, prior);
    if (chained) return chained;
    if (inputDto) {
      return `undefined as never /* TODO(spec): no producer carries '${p}' — ` +
        `not on ${req.input} or a prior read output */`;
    }
    return `${inputRef}.${p}`;
  };
  const stepArgs = (
    params: string[],
    prior: readonly { name: string; type: string }[] = [],
  ): string =>
    params
      .map((p) => /Dto$/.test(p) ? inputRef : scalarRef(p, prior))
      .join(", ");
  // ---- post-core argument resolution (the shared name-resolution table) ----
  //
  // Every post-core call site binds EVERY parameter the step declares, in
  // order, from one table — the same declarations the adapter signature is
  // built from — so the call-site arity always equals the adapter's arity.
  //
  // The locals bound by post-core steps already emitted, so a later step can
  // chain an earlier step's result (ledger.record(AuthDto) consumes the
  // gateway.authorize local — the core runs BEFORE the mutations, so it can
  // never fabricate their results).
  const postLocals: { output: string; local: string }[] = [];
  const lastPostLocal = (name: string): string | null => {
    for (let i = postLocals.length - 1; i >= 0; i--) {
      if (postLocals[i].output === name) return postLocals[i].local;
    }
    return null;
  };
  // Values the core must additionally return because a post-core call site
  // consumes them and nothing else produces them. Registered in emission order;
  // the same key resolves to the same field across call sites.
  const extraOut = new Map<string, { field: string; type: string }>();
  const extraFieldFor = (key: string, type: string): string => {
    const existing = extraOut.get(key);
    if (existing) return existing.field;
    let f = key;
    while (usedFields.has(f)) f += "X";
    usedFields.add(f);
    extraOut.set(key, { field: f, type });
    return f;
  };
  // A scalar param of a post-core step: an input field, a hoisted producer
  // local, a chained post-core result, a pre-core read's output — else the core
  // must mint it (`out.<p>`, typed via its [TYP] seam; red by design).
  const postScalar = (p: string): string => {
    if (inputFields.has(p)) return `${inputRef}.${p}`;
    if (hoisted.has(p)) return p;
    const chained = lastPostLocal(p);
    if (chained) return chained;
    const readLocal = readVars.find((r) => r.type === p);
    if (readLocal) return readLocal.name;
    return `out.${extraFieldFor(p, seamTs(p, typMap))}`;
  };
  // A DTO param of a post-core step: the validated request input, a chained
  // post-core result (already asserted), else a core-built DTO asserted at the
  // seam (`out.<camel(dto)>` — the core returns it).
  const postDto = (p: string, ctx: string): string => {
    if (p === req.input) return inputRef;
    const chained = lastPostLocal(p);
    if (chained) return chained;
    const f = extraFieldFor(camel(p), seamTs(p, typMap));
    return `assert(${p}, out.${f}, ${ctx})`;
  };
  const postArgs = (step: BoundaryStepNode): string =>
    step.params
      .map((p) =>
        /Dto$/.test(p)
          ? postDto(p, `"${step.noun}.${step.verb} ${camel(p)}"`)
          : postScalar(p)
      )
      .join(", ");

  // ---- post-core emission (built FIRST: it decides what the core returns) ----
  //
  // One pass over the boundaries in SPEC ORDER. Emitting populates the shared
  // resolution state (extraOut, coreWriteRet, postLocals), so the core call and
  // its return type — composed after — reflect exactly what the calls consume.
  const coreWriteRet: { field: string; type: string }[] = [];
  const post: string[] = [];
  for (const a of postActions) {
    if (a.kind === "write") {
      const w = a.step;
      const ctx = `"${w.noun}.${w.verb} input"`;
      // The write's PRIMARY param (its first DTO param, else its first param)
      // is the value the core builds for it, returned under the verb-named
      // field — unless an earlier post-core step already produced that exact
      // value (then the write consumes the real, already-asserted result).
      const dtoIdx = w.params.findIndex((p) => /Dto$/.test(p));
      const primaryIdx = dtoIdx === -1 ? 0 : dtoIdx;
      const args = w.params.map((p, i) => {
        if (i !== primaryIdx) {
          return /Dto$/.test(p)
            ? postDto(p, `"${w.noun}.${w.verb} ${camel(p)}"`)
            : postScalar(p);
        }
        const chained = lastPostLocal(p);
        if (chained) return chained;
        const seam: Seam = seamFor(p, typMap);
        coreWriteRet.push({
          field: a.field,
          type: seam.kind === "opaque" ? "unknown" : seamTs(p, typMap),
        });
        return seam.kind === "dto"
          ? `assert(${seam.cls}, out.${a.field}, ${ctx})`
          : seam.kind === "primitive"
          ? `assert.${seam.fn}(out.${a.field}, ${ctx})`
          : `out.${a.field}`;
      });
      post.push(`  await ${camel(w.noun)}Data.${w.verb}(${args.join(", ")});`);
    } else if (a.kind === "send") {
      const s = a.step;
      post.push(`  await ${camel(s.noun)}Data.${s.verb}(${postArgs(s)});`);
    } else {
      const r = a.step;
      const call = `await ${camel(r.noun)}Data.${r.verb}(${postArgs(r)})`;
      const seam = seamFor(a.type, typMap);
      const ctx = `"${r.noun}.${r.verb}"`;
      if (seam.kind === "dto") {
        post.push(`  const ${a.name} = assert(${seam.cls}, ${call}, ${ctx});`);
      } else if (seam.kind === "primitive") {
        post.push(`  const ${a.name} = assert.${seam.fn}(${call}, ${ctx});`);
      } else {
        post.push(
          `  const ${a.name} = ${call} as ${a.type}; // unvalidated: ${a.type} has no runtime contract`,
        );
      }
      postLocals.push({ output: a.type, local: a.name });
    }
  }

  // The core's return type: the values the writes consume, the extra values the
  // post-core calls consume, and the result — unless a post-core step IS the
  // result source. A core left with nothing to return is the guard-only shape:
  // it types `void` and the shell calls it unbound.
  const ret = [
    ...coreWriteRet.map((w) => `${w.field}: ${w.type}`),
    ...[...extraOut.values()].map((e) => `${e.field}: ${e.type}`),
    ...(resultRead ? [] : [`result: ${seamTs(req.output, typMap)}`]),
  ].join("; ");
  const coreIsVoid = ret === "";

  const B: string[] = [];
  // JSDoc: input/output contracts + every fault, attributed to the step that
  // raises it (collectFaultRaisers walks steps directly — collectAllFaults
  // dedups and drops the raiser, which is exactly what @throws needs) (E2).
  const faultRaisers = collectFaultRaisers(req.steps);
  B.push("/**");
  B.push(
    ` * Coordinator for [REQ] ${req.noun}.${req.verb}(${req.input}): ${req.output}.`,
  );
  if (req.input) {
    const inWord = inputSeam.kind === "opaque"
      ? "passed through unvalidated (no [TYP] contract)"
      : "asserted against its contract at the seam";
    B.push(` * @param input ${req.input} — ${inWord}.`);
  }
  const outWord = outputSeam.kind === "opaque"
    ? "passed through unvalidated (no [TYP] contract)"
    : "asserted before return";
  B.push(` * @returns ${req.output} — ${outWord}.`);
  for (const { fault, raiser } of faultRaisers) {
    B.push(` * @throws ${fault} — raised by ${raiser}`);
  }
  B.push(" */");
  B.push(
    `export async function ${req.verb}(input: ${
      seamTs(req.input, typMap)
    }): Promise<${seamTs(req.output, typMap)}> {`,
  );
  const inputCtx = `"${req.noun}.${req.verb} input"`;
  if (inputSeam.kind === "dto") {
    B.push(
      `  const validInput = assert(${inputSeam.cls}, input, ${inputCtx});`,
    );
  } else if (inputSeam.kind === "primitive") {
    B.push(`  const validInput = assert.${inputSeam.fn}(input, ${inputCtx});`);
  }
  for (const n of boundaryNouns) {
    B.push(`  const ${camel(n)}Data = new ${toPascal(n)}Data();`);
  }
  // value producers — pure steps whose scalar output a boundary below consumes.
  // Emitted from the first-wins `producers` map (so a value with two producers
  // binds once) in spec order — a producer feeding another is declared first —
  // making each a real local the reads/sends reference instead of a missing
  // input field. Static steps call the class; instance steps `new` it.
  if (hoisted.size) {
    B.push("");
    B.push(
      "  // value producers — pure steps whose output the boundaries below consume",
    );
    for (const [name, s] of producers) {
      if (!hoisted.has(name)) continue;
      const cls = toPascal(s.noun);
      const call = s.isStatic
        ? `${cls}.${s.verb}(${stepArgs(s.params)})`
        : `new ${cls}().${s.verb}(${stepArgs(s.params)})`;
      B.push(`  const ${name} = ${call};`);
    }
  }
  if (readVars.length) {
    B.push("");
    B.push(
      "  // reads — load inputs through the data adapters (validated at the seam)",
    );
    for (const [i, r] of readVars.entries()) {
      // a read may chain a field off any read already emitted ABOVE it — never
      // off itself or a later one (spec order is the availability order).
      const call = `await ${camel(r.noun)}Data.${r.verb}(${
        stepArgs(r.params, readVars.slice(0, i))
      })`;
      const seam = seamFor(r.type, typMap);
      const ctx = `"${r.noun}.${r.verb}"`;
      if (seam.kind === "dto") {
        B.push(`  const ${r.name} = assert(${seam.cls}, ${call}, ${ctx});`);
      } else if (seam.kind === "primitive") {
        B.push(`  const ${r.name} = assert.${seam.fn}(${call}, ${ctx});`);
      } else {
        B.push(
          `  const ${r.name} = ${call} as ${r.type}; // unvalidated: ${r.type} has no runtime contract`,
        );
      }
    }
  }
  B.push("");
  B.push("  // core — pure business logic, no I/O");
  const coreCall = `${req.verb}Core(${
    [inputRef, ...readVars.map((r) => r.name)].join(", ")
  })`;
  B.push(coreIsVoid ? `  ${coreCall};` : `  const out = ${coreCall};`);
  if (post.length > 0) {
    B.push("");
    B.push(
      "  // after the core — boundary calls in spec order (validated at the seam)",
    );
    if (postActions.some((a) => a.kind !== "produce" || a.mutation)) {
      B.push(
        "  // (guards run in the core above: a throw there prevents every call below)",
      );
    }
    B.push(...post);
  }
  B.push("");
  const outputCtx = `"${req.noun}.${req.verb} output"`;
  if (resultRead) {
    // The output is produced by a post-core boundary — already asserted above.
    B.push(`  return ${resultRead.name};`);
  } else if (outputSeam.kind === "dto") {
    B.push(`  return assert(${outputSeam.cls}, out.result, ${outputCtx});`);
  } else if (outputSeam.kind === "primitive") {
    B.push(`  return assert.${outputSeam.fn}(out.result, ${outputCtx});`);
  } else {
    B.push("  return out.result;");
  }
  B.push("}");
  B.push("");

  const coreParams = [
    `input: ${seamTs(req.input, typMap)}`,
    ...readVars.map((r) => `${r.name}: ${seamTs(r.type, typMap)}`),
  ].join(", ");
  // Describe only the parts this verb actually has, so a no-reads or no-writes
  // coordinator doesn't carry a misleading "the dtos the reads loaded" boilerplate.
  const takesReads = readVars.length ? " and the dtos the reads loaded" : "";
  const returnsClause = [
    coreWriteRet.length ? "the dtos the writes consume" : "",
    extraOut.size ? "the values the post-core calls consume" : "",
    resultRead ? "" : "the result",
  ].filter(Boolean).join(" plus ") ||
    "nothing (the post-core boundary calls produce the flow's values)";
  B.push(
    `// Pure business logic for ${req.noun}.${req.verb} — no I/O. Takes the`,
  );
  B.push(`// request input${takesReads}; returns ${returnsClause}.`);
  B.push(
    `function ${req.verb}Core(${coreParams}): ${
      coreIsVoid ? "void" : `{ ${ret} }`
    } {`,
  );
  for (const n of newNouns) {
    B.push(`  const ${camel(n)} = new ${toPascal(n)}();`);
  }
  // E3: the spec's ordered step recipe as a checklist, so the dev implements
  // exactly what the [REQ] declared. Boundaries are the shell's reads/writes/
  // sends — only pure steps / [NEW] / [RET] / [PLY] dispatch belong in the core.
  const recipe = stepRecipe(req.steps).map((l) => `  //   ${l}`);
  if (recipe.length > 0) {
    B.push(`  // Recipe from [REQ] ${req.noun}.${req.verb} (run in order):`);
    B.push(...recipe);
    B.push("  // TODO: implement the steps above, then build the dtos");
  } else {
    const todoNouns = newNouns.length
      ? newNouns.map((n) => camel(n)).join(", ")
      : "the inputs";
    B.push(`  // TODO: run the pure steps on ${todoNouns}, build the dtos`);
  }
  B.push(`  throw new Error("not implemented");`);
  B.push("}");
  B.push("");

  // ---- compose: header + imports (derived from the finished body) + body ----
  const dtos = dtoImports(
    [
      req.input,
      req.output,
      ...boundaries.flatMap((s) => [s.output, ...s.params]),
    ],
    module,
    types,
  );
  const L: string[] = [];
  // req.line is 0-based; +1 points at the [REQ] line in the spec (E1).
  L.push(`// Generated by rune manifest from ${runePath}:${req.line + 1}.`);
  L.push("// Edit the body. Re-running manifest will not overwrite this file.");
  L.push("");
  // Value imports: the DTO classes are runtime contracts (assert targets).
  for (const d of dtos) {
    L.push(`import { ${d.type} } from "@/${d.dir}/${d.file}.ts";`);
  }
  // The assert runtime is imported exactly when the emitted body calls it.
  if (B.some((l) => /\bassert[.(]/.test(l))) {
    L.push(`import { assert } from "#assert";`);
  }
  for (const n of instanceNouns) {
    L.push(
      `import { ${toPascal(n)} } from "@/src/${module}/domain/business/${
        applyCase(n, "kebab")
      }/mod.ts";`,
    );
  }
  for (const n of boundaryNouns) {
    L.push(
      `import { ${toPascal(n)} as ${
        toPascal(n)
      }Data } from "@/src/${module}/domain/data/${
        applyCase(n, "kebab")
      }/mod.ts";`,
    );
  }
  L.push("");
  L.push(...B);
  return L.join("\n");
}

// The generated field names of a [DTO] (mirrors renderDto: strip `(s)`/`?`,
// pluralize arrays) — used to match producer outputs to consumer inputs.
// Exported for rune-stubs, which mirrors the same producer/consumer matching.
export function dtoFieldNames(dto: DtoNode): string[] {
  return dto.properties.map((raw) => {
    const array = /\(s\??\)/.test(raw);
    const base = raw.replace(/\(s\??\)/g, "").replace(/\?/g, "").trim();
    return array ? `${base}s` : base;
  });
}

interface EntProcess {
  order: number;
  dependsOn: string[];
  bind: Record<string, string | string[]>;
  flows: string[];
  optional: boolean;
}

// The [ENT] bracket modifier names the endpoint's process flow (a branch through the module's
// process, e.g. `[ENT:card]`); `optional` is reserved for steps the emulator/runner attempt but
// don't require.
function entFlow(ent: EntNode): string | null {
  if (!ent.modifier || ent.modifier === "optional") return null;
  return ent.modifier;
}

// Compute each [ENT]'s process metadata from the DTO field graph: an ent depends
// on the earliest-declared EARLIER ent whose OUTPUT DTO produces a field this ent's
// INPUT DTO consumes; `bind` wires that field across. `order` is declaration order.
// PROCESS DIRECTION IS DECLARATION ORDER: producer edges only point backward to
// earlier-declared ents — a `dependsOn` on a later ent would contradict the emitted
// `order` (measured: an inverted create/complete pair walked red and limped green on
// runner retries because the mutator's load-through output was credited as producing
// the minter's input). A field minted only by LATER ents falls back to a `$field`
// bind: it is a genuine external input at that point in the process (surfaced on the
// Module-inputs card; resolved seeds → captures → schema example at send time).
// Two refinements on top of earliest-earlier-producer-wins:
// - producers spread across DIFFERENT flows are branch alternatives — the consumer depends on
//   all of them and binds them as alternatives (first to have run wins at request time);
// - a field nobody produces whose [TYP] is marked `ext` becomes a `$field` external-input
//   bind (the emulator's shared variables / the runner's seeds supply it).
function computeEntProcess(
  ents: EntNode[],
  dtoByName: Map<string, DtoNode>,
  externalTypes: Set<string> = new Set(),
): Map<EntNode, EntProcess> {
  const out = new Map<EntNode, EntProcess>();
  // An ent's IDENTITY in the dependency graph is surface-qualified: two ents on
  // different surfaces can share an `action` (e.g. `alpha.make` and `beta.make`),
  // so keying the graph by bare `action` would collide them — dependsOnReaches
  // would report a phantom self-cycle and drop a real cross-surface producer.
  const entKey = (e: EntNode): string => `${e.surface}.${e.action}`;
  // dependsOn edges committed so far, keyed by ent identity — lets us detect, in
  // declaration order, when a new producer edge would close a cycle.
  const depsByKey = new Map<string, Set<string>>();
  const dependsOnReaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === target) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const d of depsByKey.get(cur) ?? []) stack.push(d);
    }
    return false;
  };
  // What an ent genuinely MINTS: output fields that aren't echoes of its own input. An echoed
  // field (in both the input and output DTO) is not a real source and must not be derived as a
  // producer — that's what poisons the graph into cycles.
  const minted = (e: EntNode): Set<string> => {
    const outDto = dtoByName.get(e.output);
    if (!outDto) return new Set();
    const inDto = dtoByName.get(e.input);
    const echoed = new Set(inDto ? dtoFieldNames(inDto) : []);
    return new Set(dtoFieldNames(outDto).filter((f) => !echoed.has(f)));
  };
  ents.forEach((ent, i) => {
    const inDto = dtoByName.get(ent.input);
    const inFields = inDto ? dtoFieldNames(inDto) : [];
    // `dependsOn` is the EMITTED reference (bare action — resolved within the
    // controller); `dependsOnKeys` is the surface-qualified identity used to
    // grow the cycle-detection graph.
    const dependsOn = new Set<string>();
    const dependsOnKeys = new Set<string>();
    const bind: Record<string, string | string[]> = {};
    for (const field of inFields) {
      // ents is in declaration order; only EARLIER ents qualify as producers (process
      // direction follows declaration order — see the function comment). The reaches
      // guard stays as a belt for transitive shapes, though forward-only edges cannot
      // close a cycle by construction.
      const producers = ents.filter((p, pi) =>
        pi < i && minted(p).has(field) &&
        !dependsOnReaches(entKey(p), entKey(ent))
      );
      if (producers.length === 0) {
        // No earlier producer. If the field is minted only by a LATER ent (or an earlier one the
        // reaches-belt dropped), it is an external input at this point of the process — fall back
        // to a `$field` bind (surfaced on the Module-inputs card; supplied by seeds, a captured
        // same-named output on a later runner pass, or the schema example at send time) rather
        // than emitting a backward dependsOn that contradicts the emitted order; otherwise honor
        // an explicit `ext` type. The plural convention (keep's composition contract): `$name`
        // also resolves at run time from the first element of a captured `name + "s"` collection
        // output, so a plural producer makes the field wireable — the list→item gap auto-closes.
        const mintedElsewhere = ents.some((p) =>
          p !== ent && minted(p).has(field)
        );
        const pluralProducer = ents.some((p) =>
          p !== ent && minted(p).has(`${field}s`)
        );
        if (externalTypes.has(field) || mintedElsewhere || pluralProducer) {
          bind[field] = `$${field}`;
        }
        continue;
      }
      const flows = new Set(producers.map(entFlow).filter((f) => f !== null));
      if (producers.length > 1 && flows.size > 1) {
        // Branch alternatives: whichever branch ran feeds the join.
        for (const p of producers) {
          dependsOn.add(p.action);
          dependsOnKeys.add(entKey(p));
        }
        bind[field] = producers.map((p) => `${p.action}.${field}`);
      } else {
        const producer = producers[0];
        dependsOn.add(producer.action);
        dependsOnKeys.add(entKey(producer));
        bind[field] = `${producer.action}.${field}`;
      }
    }
    depsByKey.set(entKey(ent), dependsOnKeys);
    const flow = entFlow(ent);
    out.set(ent, {
      order: i + 1,
      dependsOn: [...dependsOn],
      bind,
      flows: flow ? [flow] : [],
      optional: ent.modifier === "optional",
    });
  });
  return out;
}

// Field-source binding (OpenAPI's parameter model): a `[TYP:from=path|path*|query|header]`
// modifier on an input-DTO field declares where that field is populated from at the HTTP
// boundary. Body is the default (no `from=`), so untouched DTOs route exactly as before.
// Returns the sourced fields in DECLARATION order — the order path segments append to the route.
function inputFieldSources(
  inputDtoName: string,
  types: TypeContext,
): Array<{ field: string; source: FieldSource }> {
  const dto = types.dtoByName.get(inputDtoName);
  if (!dto) return [];
  const out: Array<{ field: string; source: FieldSource }> = [];
  for (const raw of dto.properties) {
    // Mirror renderDto's property parsing so the field name matches the emitted DTO property.
    const array = /\(s\??\)/.test(raw);
    const base = raw.replace(/\(s\??\)/g, "").replace(/\?/g, "").trim();
    const name = array ? `${base}s` : base;
    const mod = types.typMap.get(base)?.modifiers.find((m) =>
      m.startsWith("from=")
    );
    if (!mod) continue;
    out.push({ field: name, source: mod.slice("from=".length) as FieldSource });
  }
  return out;
}

// The HTTP sub-path for an [ENT] under its controller surface. The base is the kebab action;
// each path-sourced field appends a `:field` segment in declaration order, and a `path*`
// (catch-all remainder) appends a trailing `:field{.+}` — Hono's slash-capturing named param. It
// always trails (a catch-all must be last) regardless of where the path* field sits in the DTO.
// keep's doc builder rewrites `{.+}` to the paren form for swagger (path-to-regexp can't parse the
// brace form) while Hono serves the brace form, so the route is both routable and documentable.
function entRoutePath(
  action: string,
  sources: Array<{ field: string; source: FieldSource }>,
): string {
  const segs = [applyCase(action, "kebab")];
  let catchAll: string | null = null;
  for (const { field, source } of sources) {
    if (source === "path") segs.push(`:${field}`);
    else if (source === "path*") catchAll = field;
  }
  if (catchAll) segs.push(`:${catchAll}{.+}`);
  return segs.join("/");
}

// Translate an explicit `[ENT]` path template to the served (Hono) sub-path. `{name}` → `:name`,
// `{name*}` (catch-all) → `:name{.+}`; literal segments pass through; a leading `/` is dropped
// (the segment mounts under the controller surface). `/proxy/{target}/{path*}` → `proxy/:target/:path{.+}`.
function translateTemplate(tpl: string): string {
  return tpl
    .replace(/^\//, "")
    .split("/")
    .filter((seg) => seg !== "")
    .map((seg) => {
      const m = seg.match(/^\{(\w+)(\*?)\}$/);
      if (!m) return seg;
      return m[2] ? `:${m[1]}{.+}` : `:${m[1]}`;
    })
    .join("/");
}

// The path/path* sources a `{name}` / `{name*}` template declares (so a field needn't repeat
// `[TYP:from=path]` when the template already names it).
function templateSources(tpl: string): Record<string, FieldSource> {
  const out: Record<string, FieldSource> = {};
  for (const seg of tpl.split("/")) {
    const m = seg.match(/^\{(\w+)(\*?)\}$/);
    if (m) out[m[1]] = m[2] ? "path*" : "path";
  }
  return out;
}

// One keep controller per surface: one `@Endpoint` method per [ENT], delegating to
// the coordinator matched by (input, output) DTO pair. The decorator carries the
// computed order/dependsOn/bind so keep serves it, documents it, and the emulator +
// harness can order and chain it.
function renderEntrypointController(
  module: string,
  surface: string,
  ents: EntNode[],
  reqs: ReqNode[],
  process: Map<EntNode, EntProcess>,
  runePath: string,
  types: TypeContext,
): string {
  const className = `${toPascal(surface)}Controller`;
  const moduleConst = `${camel(surface)}Module`;

  // Value imports (the DTO classes are referenced at runtime in @Endpoint).
  const dtos = dtoImports(
    ents.flatMap((e) => [e.input, e.output]),
    module,
    types,
  );

  // Match each ent to its [REQ] coordinator by (input, output) DTO pair.
  const coordImports = new Set<string>();
  const entCoord = new Map<EntNode, string | null>();
  const entReqNode = new Map<EntNode, ReqNode | null>();
  for (const ent of ents) {
    // An explicit `[ENT]` body `[REQ]` names the exact coordinator; otherwise fall back to the
    // (input, output) signature match.
    const req = ent.delegate
      ? reqs.find((r) =>
        r.noun === ent.delegate!.noun && r.verb === ent.delegate!.verb
      )
      : reqs.find((r) => r.input === ent.input && r.output === ent.output);
    entReqNode.set(ent, req ?? null);
    if (!req) {
      entCoord.set(ent, null);
      continue;
    }
    const alias = `${camel(req.noun)}${toPascal(req.verb)}`;
    coordImports.add(
      `import { ${req.verb} as ${alias} } from "@/src/${module}/domain/coordinators/${
        processName(req.noun, req.verb)
      }/mod.ts";`,
    );
    entCoord.set(ent, alias);
  }

  const L: string[] = [];
  L.push(`// Generated by rune manifest from ${runePath}.`);
  L.push("// Edit the body. Re-running manifest will not overwrite this file.");
  L.push("");
  L.push(
    `import { Endpoint, EndpointController, endpointModule } from "@mrg-keystone/rune";`,
  );
  for (const d of dtos) {
    L.push(`import { ${d.type} } from "@/${d.dir}/${d.file}.ts";`);
  }
  for (const line of coordImports) L.push(line);
  L.push("");
  L.push(`@EndpointController(${JSON.stringify(applyCase(surface, "kebab"))})`);
  L.push(`export class ${className} {`);
  ents.forEach((ent, i) => {
    if (i > 0) L.push("");
    const p = process.get(ent)!;
    // Each endpoint gets a distinct sub-path (the action) so methods on one surface
    // controller don't collide at the same route.
    // An empty input (`({})`) has no request body — omit `input:` (emitting `input: {}` trips
    // keep's Type constraint, TS2740) and generate a no-param handler below.
    const noInput = ent.input === "{}";
    // Field-source binding: path/query/header-sourced input fields route into the URL/headers
    // instead of the JSON body. `sources` (declaration order) drives the route segments, keep's
    // generic binder, the swagger params, and the cake's per-field rendering.
    const fieldSources = noInput ? [] : inputFieldSources(ent.input, types);
    const sources: Record<string, FieldSource> = {};
    for (const fs of fieldSources) sources[fs.field] = fs.source;
    // An explicit `@ METHOD /template` defines the route + verb and contributes its `{name}` /
    // `{name*}` path sources; otherwise the route is auto-derived from the from= path fields.
    const routePath = ent.pathTemplate
      ? translateTemplate(ent.pathTemplate)
      : entRoutePath(ent.action, fieldSources);
    if (ent.pathTemplate) {
      Object.assign(sources, templateSources(ent.pathTemplate));
    }
    const method = ent.method && ent.method !== "post" ? ent.method : null;
    const opts = [
      `path: ${JSON.stringify(routePath)}`,
      ...(method ? [`method: ${JSON.stringify(method)}`] : []),
      ...(noInput ? [] : [`input: ${ent.input}`]),
      `output: ${ent.output}`,
      `order: ${p.order}`,
    ];
    if (p.dependsOn.length) {
      opts.push(`dependsOn: ${JSON.stringify(p.dependsOn)}`);
    }
    if (Object.keys(p.bind).length) {
      opts.push(`bind: ${JSON.stringify(p.bind)}`);
    }
    if (p.flows.length) {
      opts.push(
        `flows: ${JSON.stringify(p.flows.length === 1 ? p.flows[0] : p.flows)}`,
      );
    }
    if (p.optional) opts.push("optional: true");
    if (Object.keys(sources).length) {
      opts.push(`sources: ${JSON.stringify(sources)}`);
    }
    // The OPENNESS MARKER, straight from the spec's `[REQ:open]` (D-3). It
    // reaches the composition root as `x-bedrock-auth` on this operation, and
    // that is the whole of the endpoint's policy — no decorator to hand-apply
    // to generated code, and nothing to re-apply after the next regeneration.
    // Unmarked emits nothing, which bedrock reads as the slot default.
    if (entReqNode.get(ent)?.isOpen) opts.push('access: "open"');
    // E38: a JSDoc block (delegate target, @param/@returns from DTO prose,
    // @throws from the coordinator's faults) plus `//` lines explaining the
    // derived process metadata. The @Endpoint decorator itself stays one line.
    const matched = entReqNode.get(ent) ?? null;
    const dtoDesc = (n: string): string =>
      types.dtoByName.get(n)?.description ?? "";
    const jsdoc: string[] = [];
    if (matched) {
      const how = ent.delegate
        ? "named by the [ENT] body"
        : "matched by input/output signature";
      jsdoc.push(
        `Delegates to coordinator ${matched.noun}.${matched.verb} (${how}).`,
      );
    } else {
      jsdoc.push("No coordinator wired — see the handler body.");
    }
    if (!noInput) {
      const d = dtoDesc(ent.input);
      jsdoc.push(`@param body ${ent.input}${d ? ` — ${d}` : ""}`);
    }
    const od = dtoDesc(ent.output);
    jsdoc.push(`@returns ${ent.output}${od ? ` — ${od}` : ""}`);
    if (matched) {
      for (const { fault, raiser } of collectFaultRaisers(matched.steps)) {
        jsdoc.push(`@throws ${fault} (${raiser})`);
      }
    }
    L.push("  /**");
    for (const d of jsdoc) L.push(`   * ${d}`);
    L.push("   */");
    // Process-metadata prose (derived, so a human reading the route understands
    // why it is ordered/bound the way it is).
    for (const field of Object.keys(p.bind)) {
      const v = p.bind[field];
      if (Array.isArray(v)) {
        L.push(`  // ${field} <- ${v.join(" OR ")} (first branch to run wins)`);
      } else if (v.startsWith("$")) {
        L.push(`  // ${field} <- supplied externally (seed / module input)`);
      } else {
        L.push(`  // ${field} <- ${v}`);
      }
    }
    if (p.dependsOn.length) {
      L.push(`  // Runs after: ${p.dependsOn.join(", ")}.`);
    }
    if (p.flows.length) {
      L.push(
        `  // Only in the "${
          p.flows.join(`", "`)
        }" flow branch (untagged endpoints`,
      );
      L.push("  // run in every flow).");
    }
    if (p.optional) {
      L.push("  // Optional: attempted but never blocks the run.");
    }
    // E37: spec provenance (+1 → the [ENT] line).
    L.push(`  // from ${runePath}:${ent.line + 1}`);
    L.push(`  @Endpoint({ ${opts.join(", ")} })`);
    L.push(
      `  ${ent.action}(${
        noInput ? "" : `body: ${ent.input}`
      }): Promise<${ent.output}> {`,
    );
    const alias = entCoord.get(ent);
    if (alias) {
      L.push(`    return ${alias}(${noInput ? "{}" : "body"});`);
    } else {
      // E39: name the exact coordinator path the dev should create.
      const target = ent.delegate
        ? processName(ent.delegate.noun, ent.delegate.verb)
        : "<noun>-<verb>";
      L.push(`    // No [REQ] matches (${ent.input}): ${ent.output}.`);
      L.push(
        `    // Create src/${module}/domain/coordinators/${target}/mod.ts`,
      );
      L.push(`    throw new Error("not implemented");`);
    }
    L.push(`  }`);
  });
  L.push("}");
  L.push("");
  L.push(
    `export const ${moduleConst} = endpointModule(${
      JSON.stringify(toPascal(module))
    }, [${className}]);`,
  );
  L.push("");
  return L.join("\n");
}

function renderEntrypointE2e(
  module: string,
  surface: string,
  runePath: string,
  ents: EntNode[],
  process: Map<EntNode, EntProcess>,
  typMap: Map<string, TypNode>,
): string {
  const moduleConst = `${camel(surface)}Module`;
  // Collect the surface's $external inputs (bind values like "$memberId") so the
  // generated test seeds them with typed placeholders — green in isolation, no glue.
  const seedNames = new Set<string>();
  for (const ent of ents) {
    const p = process.get(ent);
    if (!p) continue;
    for (const value of Object.values(p.bind)) {
      for (const v of Array.isArray(value) ? value : [value]) {
        if (v.startsWith("$")) seedNames.add(v.slice(1));
      }
    }
  }
  const placeholder = (name: string): string => {
    const typ = typMap.get(name);
    // Prefer the spec's declared example= value over a synthetic stub (E43).
    for (const mod of typ?.modifiers ?? []) {
      if (mod.startsWith("example=")) {
        const v = mod.slice("example=".length);
        if (v) return exampleLiteral(v, typ?.typeName);
      }
    }
    const t = typ?.typeName;
    if (t === "number" || t === "integer") return "7";
    if (t === "boolean") return "true";
    return JSON.stringify(`${name}-stub`);
  };
  const seedEntries = [...seedNames]
    .sort()
    .map((n) => `${n}: ${placeholder(n)}`)
    .join(", ");
  // E44: a legend for the $ext seeds (name -> [TYP] description) and the
  // endpoint chain in @Endpoint order, so the e2e reads as documentation of how
  // the surface runs. Emitted as comments above the one-line exercise call.
  const legend: string[] = [];
  if (seedNames.size > 0) {
    legend.push("      // $ext seeds — replace stub values with real inputs:");
    for (const n of [...seedNames].sort()) {
      const d = typMap.get(n)?.description;
      legend.push(`      //   ${n}${d ? ` — ${d}` : ""}`);
    }
  }
  const ordered = [...ents].sort((a, b) =>
    (process.get(a)?.order ?? 0) - (process.get(b)?.order ?? 0)
  );
  if (ordered.length > 0) {
    legend.push("      // Endpoint chain (by @Endpoint order):");
    for (const e of ordered) {
      const p = process.get(e);
      const deps = p?.dependsOn.length
        ? ` (after ${p.dependsOn.join(", ")})`
        : "";
      legend.push(
        `      //   ${p?.order ?? "?"}. ${e.action} -> ${e.output}${deps}`,
      );
    }
  }
  const exerciseCall = seedEntries
    ? `      const report = await exerciseEndpoints({ api, overrides: { seeds: { ${seedEntries} } } });`
    : "      const report = await exerciseEndpoints({ api });";
  return [
    `// Generated by rune manifest from ${runePath}.`,
    "// Edit the body. Re-running manifest will not overwrite this file.",
    "",
    `import { ${moduleConst} } from "./mod.ts";`,
    `import { bootstrapServer, exerciseEndpoints } from "@mrg-keystone/rune";`,
    `import { assertEquals } from "#std/assert";`,
    "",
    "// Fill the coordinator bodies, then run with RUNE_E2E=1 to drive every endpoint",
    "// to green (orders by @Endpoint order, chains outputs into inputs via bind).",
    "Deno.test({",
    `  name: ${
      JSON.stringify(
        `${module}/${applyCase(surface, "kebab")} — endpoints run and chain`,
      )
    },`,
    `  ignore: !Deno.env.get("RUNE_E2E"),`,
    "  fn: async () => {",
    `    const api = await bootstrapServer(${
      JSON.stringify(module)
    }, ${moduleConst}, { swagger: true });`,
    "    try {",
    ...legend,
    exerciseCall,
    "      assertEquals(report.failed.map((r) => r.id), []);",
    "    } finally {",
    "      await api.stop();",
    "    }",
    "  },",
    "});",
    "",
  ].join("\n");
}

function addEntrypointSurface(
  emit: Emit,
  module: string,
  surface: string,
  ents: EntNode[],
  reqs: ReqNode[],
  process: Map<EntNode, EntProcess>,
  runePath: string,
  types: TypeContext,
): void {
  const dir = `src/${module}/entrypoints/${applyCase(surface, "kebab")}`;
  emit(
    "entrypoint-mod",
    `${dir}/mod.ts`,
    renderEntrypointController(
      module,
      surface,
      ents,
      reqs,
      process,
      runePath,
      types,
    ),
  );
  emit(
    "entrypoint-e2e",
    `${dir}/e2e.test.ts`,
    renderEntrypointE2e(module, surface, runePath, ents, process, types.typMap),
  );
}

// One keep WebSocket controller per [ENT:ws] socket surface: a @WsEndpointController mounted at
// the handshake path, with one @WsEndpoint method per topic. Each topic asserts its inbound
// message against the input DTO and (optionally) returns a reply DTO that Danet sends back to the
// sender. A WS endpoint carries no HTTP verb, so it never enters the OpenAPI document or the
// cake/headless endpoint walk. Topics delegate to a [REQ] coordinator exactly as HTTP ents do.
function renderWsController(
  module: string,
  surface: string,
  ents: EntNode[],
  reqs: ReqNode[],
  runePath: string,
  types: TypeContext,
): string {
  const className = `${toPascal(surface)}Socket`;
  const moduleConst = `${camel(surface)}Module`;

  // Value imports (the DTO classes are referenced at runtime in @WsEndpoint). dtoImports
  // already skips non-DTO names, so a `void` reply or an empty `()` payload imports nothing.
  const dtos = dtoImports(
    ents.flatMap((e) => [e.input, e.output]),
    module,
    types,
  );

  // Match each topic to its [REQ] coordinator by (input, output) DTO pair (or explicit delegate).
  const coordImports = new Set<string>();
  const entCoord = new Map<EntNode, string | null>();
  const entReqNode = new Map<EntNode, ReqNode | null>();
  for (const ent of ents) {
    const req = ent.delegate
      ? reqs.find((r) =>
        r.noun === ent.delegate!.noun && r.verb === ent.delegate!.verb
      )
      : reqs.find((r) => r.input === ent.input && r.output === ent.output);
    entReqNode.set(ent, req ?? null);
    if (!req) {
      entCoord.set(ent, null);
      continue;
    }
    const alias = `${camel(req.noun)}${toPascal(req.verb)}`;
    coordImports.add(
      `import { ${req.verb} as ${alias} } from "@/src/${module}/domain/coordinators/${
        processName(req.noun, req.verb)
      }/mod.ts";`,
    );
    entCoord.set(ent, alias);
  }

  // Every topic on a socket shares the handshake path (declared once on the [ENT:ws] header).
  // Translate `{name}` → `:name` exactly like an HTTP route template; absent ⇒ the kebab surface.
  const tpl = ents.find((e) => e.pathTemplate)?.pathTemplate ?? null;
  const socketPath = tpl ? translateTemplate(tpl) : applyCase(surface, "kebab");

  const L: string[] = [];
  L.push(`// Generated by rune manifest from ${runePath}.`);
  L.push("// Edit the body. Re-running manifest will not overwrite this file.");
  L.push("");
  L.push(
    `import { endpointModule, WsEndpoint, WsEndpointController } from "@mrg-keystone/rune";`,
  );
  for (const d of dtos) {
    L.push(`import { ${d.type} } from "@/${d.dir}/${d.file}.ts";`);
  }
  for (const line of coordImports) L.push(line);
  L.push("");
  L.push(`@WsEndpointController(${JSON.stringify(socketPath)})`);
  L.push(`export class ${className} {`);
  ents.forEach((ent, i) => {
    if (i > 0) L.push("");
    // Empty parens (`verb(): Out`) ⇒ no inbound payload; `void`/empty output ⇒ no reply sent.
    const noInput = ent.input === "{}" || ent.input === "";
    const hasReply = ent.output !== "" && ent.output !== "void";
    const opts = [
      `topic: ${JSON.stringify(ent.action)}`,
      ...(noInput ? [] : [`input: ${ent.input}`]),
      ...(hasReply ? [`output: ${ent.output}`] : []),
    ];
    const matched = entReqNode.get(ent) ?? null;
    const dtoDesc = (n: string): string =>
      types.dtoByName.get(n)?.description ?? "";
    const jsdoc: string[] = [];
    if (matched) {
      const how = ent.delegate
        ? "named by the [ENT:ws] body"
        : "matched by input/output signature";
      jsdoc.push(
        `Topic "${ent.action}" → coordinator ${matched.noun}.${matched.verb} (${how}).`,
      );
    } else {
      jsdoc.push(
        `Topic "${ent.action}" — no coordinator wired, see the handler body.`,
      );
    }
    if (!noInput) {
      const d = dtoDesc(ent.input);
      jsdoc.push(
        `@param data ${ent.input}${
          d ? ` — ${d}` : ""
        } (the inbound message payload)`,
      );
    }
    if (hasReply) {
      const od = dtoDesc(ent.output);
      jsdoc.push(
        `@returns ${ent.output}${
          od ? ` — ${od}` : ""
        } (sent back to the sender)`,
      );
    } else {
      jsdoc.push(`@returns nothing — this topic sends no reply`);
    }
    if (matched) {
      for (const { fault, raiser } of collectFaultRaisers(matched.steps)) {
        jsdoc.push(`@throws ${fault} (${raiser})`);
      }
    }
    L.push("  /**");
    for (const d of jsdoc) L.push(`   * ${d}`);
    L.push("   */");
    // E37: spec provenance (+1 → the topic line).
    L.push(`  // from ${runePath}:${ent.line + 1}`);
    L.push(`  @WsEndpoint({ ${opts.join(", ")} })`);
    const retType = hasReply ? ent.output : "void";
    L.push(
      `  ${ent.action}(${
        noInput ? "" : `data: ${ent.input}`
      }): Promise<${retType}> {`,
    );
    const alias = entCoord.get(ent);
    if (alias) {
      L.push(`    return ${alias}(${noInput ? "{}" : "data"});`);
    } else {
      const target = ent.delegate
        ? processName(ent.delegate.noun, ent.delegate.verb)
        : "<noun>-<verb>";
      L.push(`    // No [REQ] matches (${ent.input || "{}"}): ${ent.output}.`);
      L.push(
        `    // Create src/${module}/domain/coordinators/${target}/mod.ts`,
      );
      L.push(`    throw new Error("not implemented");`);
    }
    L.push(`  }`);
  });
  L.push("}");
  L.push("");
  L.push(
    `export const ${moduleConst} = endpointModule(${
      JSON.stringify(toPascal(module))
    }, [${className}]);`,
  );
  L.push("");
  return L.join("\n");
}

function addWsSocketSurface(
  emit: Emit,
  module: string,
  surface: string,
  ents: EntNode[],
  reqs: ReqNode[],
  runePath: string,
  types: TypeContext,
): void {
  const dir = `src/${module}/entrypoints/${applyCase(surface, "kebab")}`;
  emit(
    "entrypoint-mod",
    `${dir}/mod.ts`,
    renderWsController(module, surface, ents, reqs, runePath, types),
  );
}

function addModRoot(
  emit: Emit,
  module: string,
  reqs: ReqNode[],
  runePath: string,
  nons: NonNode[],
  typs: TypNode[],
  srvs: SrvNode[],
  moduleDescription: string | null,
): void {
  // Each coordinator exports a function named after its verb, so two [REQ]s
  // sharing a verb (access.resolve + rules.resolve) would re-export `resolve`
  // twice → TS2300. Qualify the colliding re-exports with the noun
  // (`resolve as accessResolve`); verbs that are unique in the module stay bare.
  const verbCounts = new Map<string, number>();
  for (const r of reqs) {
    verbCounts.set(r.verb, (verbCounts.get(r.verb) ?? 0) + 1);
  }
  // E10/E46: a module front-door doc — the [MOD] prose, the domain-noun glossary
  // ([NON]), the type vocabulary ([TYP]), and the backing services ([SRV]) —
  // built in JS (the template engine has no conditionals), each section guarded.
  const doc: string[] = [];
  if (moduleDescription) {
    for (const ln of moduleDescription.split("\n")) {
      doc.push(`// ${ln}`.trimEnd());
    }
  }
  const section = (title: string, lines: string[]): void => {
    if (lines.length === 0) return;
    if (doc.length) doc.push("//");
    doc.push(`// ${title}`);
    for (const l of lines) doc.push(`//   ${l}`);
  };
  section(
    "Domain nouns (from [NON]):",
    nons.map((n) => `${n.name}${n.description ? `: ${n.description}` : ""}`),
  );
  section(
    "Type vocabulary (from [TYP]):",
    typs.map((t) =>
      `${t.name}: ${t.typeName}${t.description ? ` — ${t.description}` : ""}`
    ),
  );
  section(
    "Backing services (shared, from src/core/core.rune):",
    srvs.map((s) =>
      `${s.name} (${s.transport})${
        s.envVars.length ? `: ${s.envVars.join(", ")}` : ""
      }`
    ),
  );
  const moduleDoc = doc.length > 0 ? doc.join("\n") + "\n" : "";
  emit(
    "mod-root",
    `src/${module}/mod-root.ts`,
    render(tpl("mod-root"), {
      reqs: reqs.map((r) => {
        const collides = (verbCounts.get(r.verb) ?? 0) > 1;
        const exported = collides ? camel(`${r.noun}-${r.verb}`) : r.verb;
        return {
          binding: exported === r.verb ? r.verb : `${r.verb} as ${exported}`,
          processFile: processName(r.noun, r.verb),
        };
      }),
      module,
      runePath,
      moduleDoc,
    }),
  );
}

/** Dedup'd `{ type, file, dir }` import descriptors for the DTO-typed names:
 * each file resolved via the same <name> binding the dto/ files use, each dir
 * isCore-aware (a [DTO:core] lives in src/core/dto, not the module's dto/). */
function dtoImports(
  names: (string | undefined)[],
  module: string,
  types: TypeContext,
): { type: string; file: string; dir: string }[] {
  const seen = new Set<string>();
  const out: { type: string; file: string; dir: string }[] = [];
  for (const name of names) {
    if (!name || !/Dto$/.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      type: name,
      file: transformName(name, types.nameBinding),
      dir: dtoDir(name, module, types),
    });
  }
  return out;
}

/** Map each noun to the union of faults on all its boundary steps (across every
 * [REQ] and [CSE]), in first-seen order. One data adapter serves all of a noun's
 * boundary calls, so its smk.test must cover all their faults. */
function collectBoundaryFaults(
  ast: ReturnType<typeof parse>,
): Map<string, string[]> {
  const byNoun = new Map<string, string[]>();
  const walk = (steps: StepLike[] | CseNode["steps"]) => {
    for (const step of steps) {
      if (step.kind === "boundary") {
        const list = byNoun.get(step.noun) ?? [];
        for (const f of step.faults) if (!list.includes(f)) list.push(f);
        byNoun.set(step.noun, list);
      } else if (step.kind === "ply") {
        for (const cse of step.cases) walk(cse.steps);
      }
    }
  };
  for (const req of ast.reqs) walk(req.steps);
  return byNoun;
}

/** Map each noun to the union of faults on all its UNTAGGED (business) steps,
 * across every [REQ] and [CSE], in first-seen order. One business class serves
 * all of a noun's instance steps, so its test.ts must cover all their faults. */
function collectBusinessFaults(
  ast: ReturnType<typeof parse>,
): Map<string, string[]> {
  const byNoun = new Map<string, string[]>();
  const walk = (steps: StepLike[] | CseNode["steps"]) => {
    for (const step of steps) {
      if (step.kind === "step") {
        const list = byNoun.get(step.noun) ?? [];
        for (const f of step.faults) if (!list.includes(f)) list.push(f);
        byNoun.set(step.noun, list);
      } else if (step.kind === "ply") {
        for (const cse of step.cases) walk(cse.steps);
      }
    }
  };
  for (const req of ast.reqs) walk(req.steps);
  return byNoun;
}

function collectAllFaults(req: ReqNode): string[] {
  const out = new Set<string>();
  const walk = (steps: StepLike[] | CseNode["steps"]) => {
    for (const step of steps) {
      if (step.kind === "step" || step.kind === "boundary") {
        for (const f of step.faults) out.add(f);
      } else if (step.kind === "ply") {
        for (const cse of step.cases) walk(cse.steps);
      }
    }
  };
  walk(req.steps);
  return [...out];
}

// ---- template engine ----

function render(template: string, ctx: Record<string, unknown>): string {
  let out = template;
  // {{#each items}}...{{/each}} (no nesting in v1)
  out = out.replace(
    /\{\{#each\s+([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_match, listPath: string, body: string) => {
      const list = resolvePath(ctx, listPath);
      if (!Array.isArray(list)) return "";
      return list.map((item) => substitute(body, { ...ctx, this: item })).join(
        "",
      );
    },
  );
  // Bare {{var}}
  return substitute(out, ctx);
}

function substitute(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{\{([\w.]+)\}\}/g, (_, path: string) => {
    const v = resolvePath(ctx, path);
    return v == null ? "" : String(v);
  });
}

function resolvePath(ctx: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

// ---- inline templates ----

const HEADER = `// Generated by rune manifest from {{runePath}}.
// Edit the body. Re-running manifest will not overwrite this file.\n`;

// Banner for spec-owned files that are regenerated in full every sync (so a pruned coordinator
// can't leave a dead import behind) — the opposite contract from HEADER's "edit the body". No
// {{runePath}} (unlike HEADER): a regenerated file must stay byte-identical across re-syncs even
// after sync relocates the spec, so `rune dev`'s no-change loop touches nothing.
const REGEN_HEADER =
  `// Generated by rune manifest — DO NOT EDIT (regenerated on every \`rune sync\`).\n`;

const COORDINATOR_INT_TEST_TPL = `${HEADER}{{recipe}}
import { {{req.verb}} } from "./mod.ts";

Deno.test("{{req.verb}} — happy path", async () => {
  // TODO: implement happy path test
});
{{#each faults}}

Deno.test("{{this}}", async () => {
  // TODO: assert this fault path
});
{{/each}}
`;

const POLY_BASE_MOD_TPL = `${HEADER}
// Polymorphic base for "{{ply.noun}}". Variants extend this.
{{nonDoc}}// rune signature: {{realSig}}
// Variants (exactly one runs per call): {{variants}}

export abstract class {{ply.noun}}Base {
  abstract {{ply.verb}}({{ply.params}}): {{ply.output}};
}
`;

const POLY_BASE_TEST_TPL = `${HEADER}
// Dispatch coverage — one variant runs per call: {{variants}}
Deno.test("{{ply.noun}} base — placeholder", () => {
  // TODO: tests against the base abstraction
});
`;

// Note: Some templates use ${"keyword"} to break up import/export tokens so the
// linter regexes for barrel-discipline and import-aliases don't false-positive
// on literal template text inside this source file.

const POLY_MOD_TPL = `${HEADER}
// Polymorphic barrel for "{{ply.noun}}". Re-exports the active variant.
${"export"} { default } from "./implementations/{{firstVariant}}/mod.ts";
`;

const POLY_IMPL_MOD_TPL = `${HEADER}
${"import"} { {{ply.noun}}Base } ${"from"} "{{baseImport}}";

// Variant: {{cse.name}}

export default class {{ply.noun}}{{cse.name}} extends {{ply.noun}}Base {
  {{ply.verb}}({{ply.params}}): {{ply.output}} {
    throw new Error("not implemented");
  }
}
`;

const POLY_IMPL_TEST_TPL = `${HEADER}
import {{ply.noun}}{{cse.name}} from "./mod.ts";

Deno.test("{{ply.noun}}/{{cse.name}} — placeholder", () => {
  // Arrange — const variant = new {{ply.noun}}{{cse.name}}();
  // Act — {{ply.verb}}(...)
  // Assert — TODO: assert this variant's behavior
});
`;

const ADAPTER_SMK_TEST_TPL = `${HEADER}{{methodList}}
Deno.test("{{step.noun}} — connectivity", () => {
  // TODO: smoke test that verifies the boundary is reachable
});
{{#each faults}}

Deno.test("{{this}}", async () => {
  // TODO: assert this fault path
});
{{/each}}
`;

const MOD_ROOT_TPL = `${REGEN_HEADER}
{{moduleDoc}}// Public API surface for module "{{module}}".
{{#each reqs}}
${"export"} { {{this.binding}} } from "./domain/coordinators/{{this.processFile}}/mod.ts";
{{/each}}
`;

// ---- artifact-driven codegen templates (WO-4b) ----
//
// The engine's codegen bodies, keyed by name. These ARE the canonical templates
// (mirrored into the artifact's codegen.templates by scripts/gen-codegen-templates.ts).
// planManifest reads the artifact's overrides when given (opts.codegen), else
// these — so generated output is byte-identical until a template is deliberately
// edited in the artifact (L3 holds; mutate-to-prove L6). ONLY the tpl()-honoring
// roles live here: dto/typ/coordinator-mod/entrypoint-mod/entrypoint-e2e/
// business-test (and the rune-sig impls) are rendered programmatically — their
// shape comes from the spec's types, not a substitutable body.
export const DEFAULT_TEMPLATES: Record<string, string> = {
  "coordinator-int-test": COORDINATOR_INT_TEST_TPL,
  "poly-base-mod": POLY_BASE_MOD_TPL,
  "poly-base-test": POLY_BASE_TEST_TPL,
  "poly-mod": POLY_MOD_TPL,
  "poly-impl-mod": POLY_IMPL_MOD_TPL,
  "poly-impl-test": POLY_IMPL_TEST_TPL,
  "adapter-smk-test": ADAPTER_SMK_TEST_TPL,
  "mod-root": MOD_ROOT_TPL,
};

// Templates active for the current (synchronous) planManifest call.
let activeTemplates: Record<string, string> = DEFAULT_TEMPLATES;

function tpl(key: string): string {
  return activeTemplates[key] ?? DEFAULT_TEMPLATES[key];
}

// ---- role lifecycle / prune policy (WO-8) ----
//
// The engine's default policy: only the signature contracts regenerate; every
// other role is dev-owned (create-once) and prunable. The artifact can override
// any role via codegen.policies — so the regenerate/protect/prune behaviour is
// describable in the Studio rather than hard-coded. Defaults below reproduce the
// previous (pre-WO-8) behaviour exactly, so the L3 goldens are unchanged.
export const DEFAULT_POLICIES: Record<string, TemplatePolicy> = {
  "business-sig": { lifecycle: "regenerate", prunable: true },
  "adapter-sig": { lifecycle: "regenerate", prunable: true },
  "business-impl": { lifecycle: "create-once", prunable: true },
  "adapter-impl": { lifecycle: "create-once", prunable: true },
  "business-test": { lifecycle: "create-once", prunable: true },
  "adapter-smk-test": { lifecycle: "create-once", prunable: true },
  "coordinator-mod": { lifecycle: "create-once", prunable: true },
  "coordinator-int-test": { lifecycle: "create-once", prunable: true },
  "poly-base-mod": { lifecycle: "create-once", prunable: true },
  "poly-base-test": { lifecycle: "create-once", prunable: true },
  "poly-mod": { lifecycle: "create-once", prunable: true },
  "poly-impl-mod": { lifecycle: "create-once", prunable: true },
  "poly-impl-test": { lifecycle: "create-once", prunable: true },
  "dto": { lifecycle: "create-once", prunable: true },
  "typ": { lifecycle: "create-once", prunable: true },
  // Shared service clients (src/core/data/<name>/mod.ts) + their smoke tests are
  // dev-owned once scaffolded; prunable:false keeps a filled-in client safe even
  // if a `[SRV]` is removed from core.rune (delete the orphan client by hand).
  "core-service": { lifecycle: "create-once", prunable: false },
  "core-service-test": { lifecycle: "create-once", prunable: false },
  "entrypoint-mod": { lifecycle: "create-once", prunable: true },
  "entrypoint-e2e": { lifecycle: "create-once", prunable: true },
  "mod-root": { lifecycle: "regenerate", prunable: true },
};

// Policies active for the current planManifest call; null → engine defaults.
// rune-sync reads this (via resolvePolicy) immediately after calling planManifest.
let activePolicies: Record<string, TemplatePolicy> | null = null;

/** Resolve a role's effective policy: artifact override → engine default →
 * universal fallback (create-once, prunable). Always returns both fields set. */
export function resolvePolicy(role: string): Required<TemplatePolicy> {
  const override = activePolicies?.[role];
  const base = DEFAULT_POLICIES[role];
  return {
    lifecycle: override?.lifecycle ?? base?.lifecycle ?? "create-once",
    prunable: override?.prunable ?? base?.prunable ?? true,
  };
}

/** Map a prunable file path to the role that governs whether it may be pruned,
 * and whether it is spec- or dev-owned. Used by rune-sync's prune pass so the
 * delete decision honours the same registry policy as generation.
 * `kind` mirrors rune-sync's slot classification: feature dirs vs dto files. */
export function pruneRoleFor(
  slot: {
    kind: "dir";
    category: "business" | "data" | "coordinators" | "entrypoints";
  } | { kind: "file" },
): { role: string; owned: "spec" | "dev" } {
  if (slot.kind === "file") return { role: "dto", owned: "spec" };
  switch (slot.category) {
    case "business":
      return { role: "business-impl", owned: "dev" };
    case "data":
      return { role: "adapter-impl", owned: "dev" };
    case "coordinators":
      return { role: "coordinator-mod", owned: "dev" };
    case "entrypoints":
      return { role: "entrypoint-mod", owned: "dev" };
  }
}
