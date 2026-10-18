// Rune parser: the grammar's wasm (`lang/grammar/rune.wasm`, built from the
// registry) is the one parser of record (REQ-031). This module is the CST → AST
// LOWERING: tree-sitter decides what each line IS (its node type is the tag id
// plus `_line`), the lowering keeps the document state — which [REQ] a step
// belongs to, which [PLY] a case belongs to, which declaration prose describes
// — and reads each node's fields. A line the grammar rejects is an ERROR node;
// its shape (the tag it starts with, a bare fault, …) maps to the registry's
// per-shape rule so a malformed draft still yields an id'd finding (REQ-034).
//
// Pure: text → structured AST. Every finding is a registry rule rendered through
// `message()`; nothing here carries a message of its own.

import { Language, Parser } from "#tree-sitter";
import type { Node } from "#tree-sitter";
import {
  columns,
  FAULT_MARKER,
  FAULT_SHAPE,
  fixFor,
  message,
  modifiers,
  modifiersFor,
  tagById,
  transports,
} from "@rune/domain/business/registry/mod.ts";

await Parser.init();
const language = await Language.load(
  await Deno.readFile(new URL("../../../../../lang/grammar/rune.wasm", import.meta.url)),
);
const parser = new Parser();
parser.setLanguage(language);

/** The ids this module emits (REQ-026: the union of every module's EMITS is the
 * registry's checker list). */
export const EMITS = [
  "mod-name",
  "mod-name-shape",
  "mod-duplicate",
  "req-signature",
  "req-modifier",
  "req-core",
  "ent-signature",
  "ent-method",
  "ent-body-signature",
  "ent-body-modifier",
  "srv-shape",
  "srv-transport",
  "srv-docs-url",
  "srv-docs-duplicate",
  "srv-docs-required",
  "dto-props",
  "dto-modifier",
  "dto-prop-undefined",
  "typ-type",
  "typ-modifier-unknown",
  "typ-modifier-base",
  "typ-modifier-value",
  "typ-modifier-no-value",
  "typ-modifier-choice",
  "from-path-retired",
  "class-retired",
  "non-name",
  "ply-signature",
  "ply-outside-req",
  "ply-nested",
  "cse-name",
  "cse-outside-ply",
  "new-name",
  "ctr-retired",
  "ret-value",
  "boundary-signature",
  "step-outside-req",
  "fault-outside-step",
  "fault-shape",
  "fault-marker",
  "unrecognized-line",
  "line-length",
] as const;
export type ParseErrorId = typeof EMITS[number];

// A [MOD] name becomes a `src/<module>/` directory AND is camel/pascal-cased
// into a JS identifier alias in the generated bootstrap registry. Constrain it
// to the same identifier shape [SRV] names use — a letter/underscore start, then
// letters, digits, `-`, `_` — so a digit-leading or punctuated name can't slip
// through and emit a registry that won't parse or type-check.
export const MOD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export interface RuneAst {
  module: string | null;
  /** Optional [MOD] description (`[MOD] name: prose…` + indented continuation). */
  moduleDescription: string | null;
  reqs: ReqNode[];
  ents: EntNode[];
  dtos: DtoNode[];
  typs: TypNode[];
  nons: NonNode[];
  /** Declared backing services ([SRV] <transport>:<name>: <ENV,…>). */
  srvs: SrvNode[];
  /** The HTTP status each custom fault declared (`! card-expired=402`), by name. */
  faultStatuses: Record<string, number>;
  /** 0-based lines that are [ENT] body `[REQ]` references (REQ-019). */
  bodyLines: number[];
  /** The 0-based line each fault name was last declared on (for findings). */
  faultLines: Record<string, number>;
  errors: ParseError[];
}

export interface ReqNode {
  noun: string;
  verb: string;
  input: string;
  output: string;
  steps: StepLike[];
  /** `[REQ:open]` — the openness marker. True ⇒ this endpoint is reachable
   *  without a credential, and codegen stamps `x-bedrock-auth` on it. */
  isOpen: boolean;
  line: number;
}

export interface EntNode {
  surface: string;
  action: string;
  input: string;
  output: string;
  /**
   * The bracket modifier, e.g. `[ENT:card]` → "card". Codegen reads it as the endpoint's
   * process flow (a named branch); the reserved modifier `optional` marks a step the
   * emulator/runner attempt but don't require. Null for plain `[ENT]`.
   */
  modifier: string | null;
  line: number;
  /**
   * Explicit HTTP verb from an `[ENT] … @ POST /…` clause (lowercased). Null ⇒ POST (the default).
   */
  method?: string | null;
  /**
   * Explicit route template from `@ METHOD <template>` with `{name}` / `{name*}` segments
   * (e.g. `/proxy/{target}/{path*}`). Null ⇒ the route is the action name. A `{name}` segment
   * binds that field from the path, `{name*}` is the catch-all.
   */
  pathTemplate?: string | null;
  /**
   * The [REQ] this ent dispatches to, from the indented `[REQ]` line in its body (REQ-019:
   * the body line is the only link — there is no matching by signature).
   */
  delegate?: { noun: string; verb: string };
}

export type StepLike =
  | StepNode
  | BoundaryStepNode
  | PlyNode
  | CtrNode
  | RetNode;

export interface StepNode {
  kind: "step";
  noun: string;
  verb: string;
  params: string[];
  output: string;
  /** The value's name when the step says `: Type as name` (REQ-020). */
  valueName?: string;
  isStatic: boolean;
  faults: string[];
  line: number;
}

export interface BoundaryStepNode {
  kind: "boundary";
  /** The backing service name (the `<service>:` prefix); resolved to a [SRV]
   * by the rune-service-presence lint rule, not at parse time. */
  service: string;
  noun: string;
  verb: string;
  params: string[];
  output: string;
  valueName?: string;
  isStatic: boolean;
  faults: string[];
  line: number;
}

export interface PlyNode {
  kind: "ply";
  noun: string;
  verb: string;
  params: string[];
  output: string;
  valueName?: string;
  isStatic: boolean;
  cases: CseNode[];
  line: number;
}

export interface CseNode {
  name: string;
  steps: Array<StepNode | BoundaryStepNode | CtrNode | RetNode>;
  line: number;
}

export interface CtrNode {
  kind: "ctr";
  className: string;
  line: number;
}

export interface RetNode {
  kind: "ret";
  value: string;
  line: number;
}

export interface DtoNode {
  name: string;
  properties: string[];
  description: string;
  isCore: boolean;
  /** [DTO:open] — opaque inbound payload: declared fields are validated, undeclared
   * fields pass through (the generated class carries a marker keep's assert reads). */
  isOpen: boolean;
  line: number;
}

export interface TypNode {
  name: string;
  typeName: string;
  description: string;
  isCore: boolean;
  /**
   * `[TYP:ext]` — the value is produced OUTSIDE this module (another module's endpoint, a
   * human). Entrypoint codegen turns unproduced input fields of this type into `$name`
   * external-input binds instead of leaving them unwired.
   */
  isExternal: boolean;
  /**
   * Raw bracket modifiers in source order, e.g. `[TYP:ext,uuid]` →
   * ["ext", "uuid"], `[TYP:min=0,max=100]` → ["min=0", "max=100"]. Includes
   * ext/core; constraint modifiers map to class-validator decorators via the
   * registry's modifier table. Invalid items are dropped (and reported).
   */
  modifiers: string[];
  line: number;
}

export interface NonNode {
  name: string;
  description: string;
  line: number;
}

export interface SrvNode {
  /** Transport — one of the registry's transports. */
  transport: string;
  /** Service name referenced by `<name>:` boundary prefixes. */
  name: string;
  /** Declared environment variable names (comma-separated after the 2nd colon). */
  envVars: string[];
  description: string;
  /** REQUIRED documentation link — the indented `@docs <url>` line under the
   * [SRV]. Empty only on a malformed spec. */
  docsLink: string;
  line: number;
}

export interface ParseError {
  /** Stable rule id (REQ-013) — a registry lint. */
  id: ParseErrorId;
  /** 0-based line. */
  line: number;
  message: string;
  fix?: string;
}

/** The text between a tag's `[TAG:` and `]`, or null for a bare tag. */
function tagModifier(tagText: string): string | null {
  const colon = tagText.indexOf(":");
  return colon === -1 ? null : tagText.slice(colon + 1, -1).trim();
}

/** The raw line text after the tag token, trimmed. */
function restAfter(node: Node, tagText: string, lineText: string): string {
  const i = lineText.indexOf(tagText, node.startPosition.column);
  return lineText.slice((i === -1 ? 0 : i) + tagText.length).trim();
}

export function parse(text: string): RuneAst {
  const ast: RuneAst = {
    module: null,
    moduleDescription: null,
    reqs: [],
    ents: [],
    dtos: [],
    typs: [],
    nons: [],
    srvs: [],
    faultStatuses: {},
    bodyLines: [],
    faultLines: {},
    errors: [],
  };
  const err = (
    id: ParseErrorId,
    line: number,
    vars: Record<string, unknown> = {},
  ): void => {
    ast.errors.push({
      id,
      line,
      message: message(id, vars),
      ...(fixFor(id, vars) ? { fix: fixFor(id, vars) } : {}),
    });
  };
  const syntaxOf = (tagId: string) => tagById.get(tagId)?.syntax ?? "";

  const lines = text.split(/\r?\n/);
  // line-length: the registry's column limit, a reader's rule the engine owns.
  lines.forEach((l, i) => {
    const cols = [...l].length;
    if (cols > columns.max) err("line-length", i, { found: cols });
  });

  const tree = parser.parse(text);
  if (!tree) return ast;
  // One entry per source line: the top-level node that starts on it (or null).
  // A clean node spanning several rows (a multi-line parameter list) claims
  // them all. An ERROR node claims nothing: tree-sitter's recovery may fold the
  // lines after a bad one into it, so every such line is parsed on its own
  // (one line, one tree) and lowered from that — a mistake stays one finding
  // and never hides the lines below it (REQ-034).
  const nodeAt: (Node | null)[] = new Array(lines.length).fill(null);
  const claimed = new Set<number>();
  const errorRows = new Set<number>();
  // A line is one node: a second top-level node on a row (`[MOD] my"module`
  // lowers to a mod_line plus an ERROR holding the rest) means the line is
  // malformed, whatever the first node says.
  const perRow = new Map<number, number>();
  for (const n of tree.rootNode.children) {
    if (n.type === "comment") continue;
    perRow.set(n.startPosition.row, (perRow.get(n.startPosition.row) ?? 0) + 1);
  }
  for (const n of tree.rootNode.children) {
    if (n.type === "comment") continue;
    const row = n.startPosition.row;
    if (n.hasError || (perRow.get(row) ?? 0) > 1) {
      for (let r = row; r <= n.endPosition.row; r++) errorRows.add(r);
      continue;
    }
    if (nodeAt[row] === null) nodeAt[row] = n;
    for (let r = row + 1; r <= n.endPosition.row; r++) claimed.add(r);
  }
  const soloTrees: { delete(): void }[] = [];
  for (const r of errorRows) {
    if (claimed.has(r) || nodeAt[r] !== null) continue;
    const solo = parser.parse(lines[r]);
    if (!solo) continue;
    soloTrees.push(solo);
    const parts = solo.rootNode.children.filter((c: Node | null): c is Node => c !== null && c.type !== "comment");
    if (parts.length === 1 && !parts[0].hasError) nodeAt[r] = parts[0];
  }

  // Block-mode tracking for indented description lines. Any node with a
  // `description` field can be the target (DTO/TYP/NON/SRV + the module).
  let descTarget: { description: string } | null = null;
  // The module's description accumulates here ([MOD] name: prose + continuation);
  // flushed onto ast.moduleDescription after the walk.
  const modDesc = { description: "" };

  // Tree-builder state.
  let currentReq: ReqNode | null = null;
  let currentPly: PlyNode | null = null;
  let plyIndent = 0;
  let currentCse: CseNode | null = null;
  let lastStep: StepNode | BoundaryStepNode | null = null;
  let currentEnt: EntNode | null = null;
  let entIndent = 0;
  // The [SRV] whose description block is currently open — routes an indented
  // `@docs <url>` line to its docsLink. Only "active" while descTarget === it.
  let currentSrv: SrvNode | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (claimed.has(i)) continue;
    const raw = lines[i];
    const indent = countIndent(raw);
    const trimmed = stripInlineComment(raw).trim();
    if (trimmed === "" || trimmed.startsWith("//")) {
      // A blank line ends description blocks and the ent body context.
      if (trimmed === "") {
        descTarget = null;
        currentEnt = null;
      }
      continue;
    }
    const node = nodeAt[i];
    const kind = node === null || node.hasError ? "ERROR" : node.type;
    // A node's own text (joined across rows for a multi-line parameter list).
    const nodeText = node ? node.text.replace(/\s*\r?\n\s*/g, " ").trim() : trimmed;

    // A [REQ] indented under an [ENT] is that ENT's delegation target (the required
    // body line, REQ-019). Any other line ends the ent-body context.
    if (currentEnt) {
      if (indent > entIndent && /^\[REQ\b/.test(trimmed)) {
        ast.bodyLines.push(i);
        if (kind === "req_line") lowerEntBody(node!, trimmed, i, currentEnt, err);
        else err("ent-body-signature", i);
        currentEnt = null;
        descTarget = null;
        continue;
      }
      currentEnt = null;
    }

    // Close [PLY]/[CSE] block when indentation returns to the [PLY]'s own level
    // and the line is not a [CSE] (cases sit deeper). Fault lines never close it.
    if (
      currentPly && indent <= plyIndent && kind !== "cse_line" &&
      kind !== "fault_line"
    ) {
      currentPly = null;
      currentCse = null;
    }

    switch (kind) {
      case "mod_line": {
        const tag = node!.childForFieldName("name")!;
        const name = tag.text;
        const desc = node!.children.find((c: Node | null) => c?.type === "mod_desc")?.text.trim() ?? "";
        if (!MOD_NAME_RE.test(name)) {
          err("mod-name-shape", i, { name });
          descTarget = null;
        } else if (ast.module !== null) {
          err("mod-duplicate", i, { module: ast.module });
          descTarget = null;
        } else {
          ast.module = name;
          if (desc) modDesc.description = desc;
          descTarget = modDesc; // indented continuation appends to the module desc
        }
        continue;
      }
      case "srv_line": {
        const rest = restAfter(node!, "[SRV]", raw);
        const m = rest.match(
          /^\(([A-Za-z_]+)\)([A-Za-z_][A-Za-z0-9_-]*)(?::\s*(.*))?$/,
        );
        if (!m) {
          err("srv-shape", i);
          descTarget = { description: "" }; // its prose does not cascade
          continue;
        }
        const [, transport, name, envStr] = m;
        if (!transports.includes(transport)) {
          err("srv-transport", i, { transport, transports: transports.join("/") });
        }
        const envVars = (envStr ?? "").split(",").map((s) => s.trim()).filter((
          s,
        ) => s !== "");
        const srv: SrvNode = {
          transport,
          name,
          envVars,
          description: "",
          docsLink: "",
          line: i,
        };
        ast.srvs.push(srv);
        descTarget = srv;
        currentSrv = srv;
        continue;
      }
      case "req_line": {
        const tagText = node!.children[0].text;
        const modifier = tagModifier(tagText);
        const isOpen = modifier === "open";
        if (modifier === "core") err("req-core", i);
        else if (modifier !== null && !isOpen) err("req-modifier", i, { modifier });
        const sig = parseReqSignature(nodeText.slice(tagText.length).trim());
        if (!sig) {
          err("req-signature", i, { syntax: syntaxOf("req") });
          currentReq = null;
        } else {
          currentReq = { noun: sig.noun, verb: sig.verb, input: sig.input, output: sig.output, steps: [], isOpen, line: i };
          ast.reqs.push(currentReq);
        }
        currentPly = null;
        currentCse = null;
        lastStep = null;
        descTarget = null;
        continue;
      }
      case "ent_line": {
        const tagText = node!.children[0].text;
        const modifier = tagModifier(tagText);
        const rest = nodeText.slice(tagText.length).trim();
        currentReq = null;
        currentPly = null;
        currentCse = null;
        lastStep = null;
        currentEnt = null;
        descTarget = null;
        const sig = parseReqSignature(rest);
        if (!sig) {
          err("ent-signature", i, { syntax: syntaxOf("ent") });
          continue;
        }
        if (sig.method && !ENT_METHODS.has(sig.method)) {
          err("ent-method", i, { method: sig.method.toUpperCase() });
        }
        const entNode: EntNode = {
          surface: sig.noun,
          action: sig.verb,
          input: sig.input,
          output: sig.output,
          modifier,
          line: i,
          method: sig.method ?? null,
          pathTemplate: sig.pathTemplate ?? null,
        };
        ast.ents.push(entNode);
        currentEnt = entNode; // the next indented [REQ] is its delegate
        entIndent = indent;
        continue;
      }
      case "dto_line": {
        const tagText = node!.children[0].text;
        const modifier = tagModifier(tagText);
        const isCore = modifier === "core";
        const isOpen = modifier === "open";
        if (modifier && !isCore && !isOpen) err("dto-modifier", i, { modifier });
        const rest = restAfter(node!, tagText, raw);
        const colon = rest.indexOf(":");
        const name = rest.slice(0, colon).trim();
        const props = rest.slice(colon + 1).split(",").map((p) => p.trim())
          .filter((p) => p.length > 0);
        const dto: DtoNode = { name, properties: props, description: "", isCore, isOpen, line: i };
        ast.dtos.push(dto);
        descTarget = dto;
        currentReq = null;
        currentPly = null;
        currentCse = null;
        lastStep = null;
        continue;
      }
      case "typ_line": {
        const tagText = node!.children[0].text;
        const rest = restAfter(node!, tagText, raw);
        const colon = rest.indexOf(":");
        const name = rest.slice(0, colon).trim();
        const typeName = rest.slice(colon + 1).trim();
        const mods = lowerTypModifiers(tagModifier(tagText), name, typeName, i, err);
        if (typeName === "Class") err("class-retired", i, { name });
        const typ: TypNode = {
          name,
          typeName,
          description: "",
          isCore: mods.includes("core"),
          isExternal: mods.includes("ext"),
          modifiers: mods,
          line: i,
        };
        ast.typs.push(typ);
        descTarget = typ;
        currentReq = null;
        currentPly = null;
        currentCse = null;
        lastStep = null;
        continue;
      }
      case "non_line": {
        const name = node!.childForFieldName("name")!.text;
        const non: NonNode = { name, description: "", line: i };
        ast.nons.push(non);
        descTarget = non;
        currentReq = null;
        currentPly = null;
        currentCse = null;
        lastStep = null;
        continue;
      }
      case "ply_line": {
        const sig = parseStepSignature(nodeText.slice("[PLY]".length));
        if (!sig) {
          err("ply-signature", i, { syntax: syntaxOf("ply") });
        } else if (currentCse) {
          // One level of polymorphism per step: a [PLY] inside a case is an error
          // and is not opened (its cases would then report cse-outside-ply).
          err("ply-nested", i);
        } else {
          const ply: PlyNode = { kind: "ply", ...sig, cases: [], line: i };
          if (currentReq) currentReq.steps.push(ply);
          else err("ply-outside-req", i);
          currentPly = ply;
          plyIndent = indent;
          currentCse = null;
        }
        lastStep = null;
        descTarget = null;
        continue;
      }
      case "cse_line": {
        const name = node!.childForFieldName("name")!.text;
        if (!currentPly) err("cse-outside-ply", i);
        else {
          const cse: CseNode = { name, steps: [], line: i };
          currentPly.cases.push(cse);
          currentCse = cse;
        }
        lastStep = null;
        descTarget = null;
        continue;
      }
      case "new_line": {
        const className = node!.childForFieldName("name")!.text;
        appendStep({ kind: "ctr", className, line: i }, currentReq, currentPly, currentCse, err, i);
        lastStep = null;
        descTarget = null;
        continue;
      }
      case "ret_line": {
        const value = restAfter(node!, "[RET]", raw);
        appendStep({ kind: "ret", value, line: i }, currentReq, currentPly, currentCse, err, i);
        lastStep = null;
        descTarget = null;
        continue;
      }
      case "boundary_line": {
        const prefix = node!.children[0].text.trim();
        const service = prefix.slice(0, -1);
        const sig = parseStepSignature(nodeText.slice(nodeText.indexOf(prefix) + prefix.length));
        if (!sig) {
          err("boundary-signature", i, { service });
        } else {
          const step: BoundaryStepNode = { kind: "boundary", service, ...sig, faults: [], line: i };
          appendStep(step, currentReq, currentPly, currentCse, err, i);
          lastStep = step;
        }
        descTarget = null;
        continue;
      }
      case "step_line": {
        const sig = parseStepSignature(nodeText)!;
        const step: StepNode = { kind: "step", ...sig, faults: [], line: i };
        appendStep(step, currentReq, currentPly, currentCse, err, i);
        lastStep = step;
        descTarget = null;
        continue;
      }
      case "fault_line": {
        if (!lastStep) {
          err("fault-outside-step", i);
          continue;
        }
        const list = node!.children.find((c: Node | null) => c?.type === "fault_list")?.text ?? "";
        for (const item of list.trim().split(/\s+/).filter(Boolean)) {
          const [name, status, ...more] = item.split("=");
          if (!FAULT_SHAPE.test(name) || more.length > 0 || (status !== undefined && !/^[1-5][0-9]{2}$/.test(status))) {
            err("fault-shape", i, { name: item });
            continue;
          }
          lastStep.faults.push(name);
          ast.faultLines[name] = i;
          if (status !== undefined) ast.faultStatuses[name] = Number(status);
        }
        continue;
      }
      case "srv_docs_line": {
        if (currentSrv && descTarget === currentSrv) {
          const url = trimmed.slice("@docs".length).trim();
          if (url === "") err("srv-docs-url", i, { service: currentSrv.name });
          else if (currentSrv.docsLink) err("srv-docs-duplicate", i, { service: currentSrv.name });
          else currentSrv.docsLink = url;
          continue;
        }
        // An `@docs` under a [DTO]/[TYP]/[NON] stays plain prose.
        if (descTarget && indent > 0) {
          appendDesc(descTarget, trimmed);
          continue;
        }
        err("unrecognized-line", i, { text: trimmed });
        continue;
      }
      case "typ_desc":
      case "dto_desc":
      case "non_desc": {
        if (descTarget && indent > 0) {
          appendDesc(descTarget, trimmed);
          continue;
        }
        // Prose where none belongs: a bare fault line under a step (the
        // pre-marker form, REQ-018) or an unrecognized line.
        if (lastStep && isBareFaultLine(trimmed)) {
          err("fault-marker", i, { names: trimmed });
          continue;
        }
        err("unrecognized-line", i, { text: trimmed });
        continue;
      }
      default: {
        // ERROR / MISSING: classify the line by its shape (REQ-034). A malformed
        // declaration still opens a (discarded) description block, so its prose
        // does not cascade into unrecognized-line findings.
        lowerErrorLine(trimmed, i, lastStep, err, syntaxOf);
        descTarget = /^\[(DTO|TYP|NON|SRV|MOD)\b/.test(trimmed) ? { description: "" } : null;
        continue;
      }
    }
  }

  // Every property used in a [DTO] must resolve to a declared type — no untyped
  // (`unknown`) fields. It may be a [TYP], a nested [DTO] (named directly or via
  // the <Name>Dto convention), after stripping the optional `?` and plural `(s)`/`(s?)`
  // modifiers. (TYP names cover both module and :core typs.)
  const typNames = new Set(ast.typs.map((t) => t.name));
  const dtoNames = new Set(ast.dtos.map((d) => d.name));
  const pascal = (s: string) =>
    s.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1))
      .join("");
  for (const dto of ast.dtos) {
    for (const prop of dto.properties) {
      const clean = prop.replace(/\(s\??\)/g, "").replace(/\?/g, "").trim();
      const resolved = typNames.has(clean) || dtoNames.has(clean) ||
        dtoNames.has(`${pascal(clean)}Dto`);
      if (!resolved) {
        err("dto-prop-undefined", dto.line, { dto: dto.name, prop, base: clean });
      }
    }
  }

  // Every [SRV] MUST declare an `@docs <url>` link.
  for (const srv of ast.srvs) {
    if (!srv.docsLink) err("srv-docs-required", srv.line, { service: srv.name });
  }

  for (const t of soloTrees) t.delete();
  tree.delete();
  ast.moduleDescription = modDesc.description.trim() || null;
  ast.errors.sort((a, b) => a.line - b.line);
  return ast;
}

// ---- lowering helpers ----

type Err = (id: ParseErrorId, line: number, vars?: Record<string, unknown>) => void;

function appendDesc(target: { description: string }, text: string): void {
  target.description = target.description ? `${target.description} ${text}` : text;
}

function lowerEntBody(node: Node, trimmed: string, line: number, ent: EntNode, err: Err): void {
  const tagText = node.children[0].text;
  if (tagModifier(tagText) !== null) {
    err("ent-body-modifier", line);
    return;
  }
  const sig = parseReqSignature(trimmed.slice(tagText.length).trim());
  if (!sig) {
    err("ent-body-signature", line);
    return;
  }
  ent.delegate = { noun: sig.noun, verb: sig.verb };
}

/** The bracket slot of a [TYP]: the valid modifiers in source order; every
 * invalid item is a finding (and dropped). Validation reads the registry's
 * modifier table: base primitive, parameter kind, closed value set. */
function lowerTypModifiers(
  raw: string | null,
  name: string,
  typeName: string,
  line: number,
  err: Err,
): string[] {
  const mods: string[] = [];
  if (raw === null) return mods;
  const allowed = modifiersFor("typ").join(", ");
  for (const item of raw.split(",")) {
    const mod = item.trim();
    if (mod === "") continue;
    const eq = mod.indexOf("=");
    const id = eq === -1 ? mod : mod.slice(0, eq);
    const value = eq === -1 ? null : mod.slice(eq + 1);
    const spec = modifiers.get(id);
    if (!spec) {
      err("typ-modifier-unknown", line, { modifier: id, allowed });
      continue;
    }
    if (spec.param === "number") {
      if (value === null || !/^-?\d+(\.\d+)?$/.test(value)) {
        err("typ-modifier-value", line, { modifier: id, kind: "numeric", example: `${id}=0` });
        continue;
      }
    } else if (spec.param === "text") {
      if (value === null || value === "") {
        err("typ-modifier-value", line, { modifier: id, kind: "text", example: `${id}=${spec.values?.[0] ?? "orders"}` });
        continue;
      }
      if (id === "from" && (value === "path" || value === "path*")) {
        err("from-path-retired", line, { value, name });
        continue;
      }
      if (spec.values && !spec.values.includes(value)) {
        err("typ-modifier-choice", line, { modifier: id, values: spec.values.join(", "), value });
        continue;
      }
    } else if (value !== null) {
      err("typ-modifier-no-value", line, { modifier: id });
      continue;
    }
    if (spec.base && spec.base !== typeName) {
      err("typ-modifier-base", line, { modifier: id, base: spec.base, name, type: typeName });
      continue;
    }
    mods.push(mod);
  }
  return mods;
}

/** A line the grammar rejected: name the rule its shape maps to (REQ-034) —
 * the tag it opens with (the registry's per-tag shape rule, with the tag's
 * modifier checked first), a retired tag, a bare fault line, else unrecognized. */
function lowerErrorLine(
  trimmed: string,
  line: number,
  lastStep: StepNode | BoundaryStepNode | null,
  err: Err,
  syntaxOf: (tagId: string) => string,
): void {
  const tag = trimmed.match(/^\[([A-Z]+)(?::([^\]]*))?\]/);
  if (tag) {
    const literal = `[${tag[1]}]`;
    if (literal === "[CTR]") {
      err("ctr-retired", line, { noun: trimmed.slice(tag[0].length).trim() || "<noun>" });
      return;
    }
    const entry = [...tagById.values()].find((t) => t.tag === literal);
    if (entry) {
      const modifier = tag[2]?.trim() ?? null;
      const rest = trimmed.slice(tag[0].length).trim();
      if (entry.id === "mod" && rest !== "") {
        err("mod-name-shape", line, { name: rest.split(":")[0].trim() });
        return;
      }
      if (entry.id === "req" && modifier === "core") {
        err("req-core", line);
        return;
      }
      if (entry.id === "req" && modifier !== null && modifier !== "open") {
        err("req-modifier", line, { modifier });
        return;
      }
      if (entry.id === "dto" && modifier !== null && modifier !== "core" && modifier !== "open") {
        err("dto-modifier", line, { modifier });
        return;
      }
      err(entry.shapeRule as ParseErrorId, line, { syntax: syntaxOf(entry.id), noun: "<noun>" });
      return;
    }
  }
  if (lastStep && isBareFaultLine(trimmed)) {
    err("fault-marker", line, { names: trimmed });
    return;
  }
  err("unrecognized-line", line, { text: trimmed });
}

/** A pre-marker fault line: space-separated fault names and nothing else. */
function isBareFaultLine(trimmed: string): boolean {
  const parts = trimmed.split(/\s+/);
  return parts.length > 0 && parts.every((p) => FAULT_SHAPE.test(p)) &&
    !trimmed.startsWith(FAULT_MARKER);
}

function countIndent(raw: string): number {
  let n = 0;
  for (const ch of raw) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

function stripInlineComment(raw: string): string {
  // A `//` only starts a comment when it follows whitespace or opens the line —
  // the conventional ` // note` form. A `//` glued to a non-space char is left
  // intact so URLs survive (`@docs https://x` / a URL in a prose description);
  // `://` is never a comment.
  let i = raw.indexOf("//");
  while (i !== -1) {
    const prev = raw[i - 1];
    if (i === 0 || prev === " " || prev === "\t") return raw.slice(0, i);
    i = raw.indexOf("//", i + 2);
  }
  return raw;
}

interface StepSig {
  noun: string;
  verb: string;
  params: string[];
  output: string;
  valueName?: string;
  isStatic: boolean;
}

/** `noun.verb(a, b): Out [as name]` / `Noun::verb(...)`. */
function parseStepSignature(s: string): StepSig | null {
  const trimmed = s.trim();
  const parenOpen = trimmed.indexOf("(");
  const parenClose = trimmed.lastIndexOf(")");
  if (parenOpen === -1 || parenClose === -1 || parenClose < parenOpen) {
    return null;
  }

  const namePart = trimmed.slice(0, parenOpen);
  let sepPos: number;
  let sepLen: number;
  let isStatic: boolean;

  const dblColon = namePart.indexOf("::");
  if (dblColon !== -1) {
    sepPos = dblColon;
    sepLen = 2;
    isStatic = true;
  } else {
    const dot = namePart.indexOf(".");
    if (dot === -1) return null;
    sepPos = dot;
    sepLen = 1;
    isStatic = false;
  }

  const noun = namePart.slice(0, sepPos).trim();
  const verb = namePart.slice(sepPos + sepLen).trim();
  if (noun === "" || verb === "") return null;

  const paramsStr = trimmed.slice(parenOpen + 1, parenClose);
  const params = paramsStr
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Output after `):`, optionally `as <name>`.
  const afterParen = trimmed.slice(parenClose + 1);
  const colonIdx = afterParen.indexOf(":");
  let output = colonIdx === -1 ? "" : afterParen.slice(colonIdx + 1).trim();
  let valueName: string | undefined;
  const as = output.match(/^(.*?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/);
  if (as) {
    output = as[1].trim();
    valueName = as[2];
  }

  return valueName === undefined
    ? { noun, verb, params, output, isStatic }
    : { noun, verb, params, output, valueName, isStatic };
}

interface ReqSig {
  noun: string;
  verb: string;
  input: string;
  output: string;
  /** Explicit HTTP verb (lowercased) from an `[ENT] … @ POST /…` clause. */
  method?: string;
  /** Explicit route template from `@ METHOD <template>` (e.g. `/proxy/{target}/{path*}`). */
  pathTemplate?: string;
}

/** HTTP verbs accepted in an `[ENT] … @ METHOD /…` clause (lowercased). */
const ENT_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function parseReqSignature(s: string): ReqSig | null {
  const trimmed = s.trim();
  const parenOpen = trimmed.indexOf("(");
  const parenClose = trimmed.lastIndexOf(")");
  if (parenOpen === -1 || parenClose === -1 || parenClose < parenOpen) {
    return null;
  }

  // Output is after the LAST colon (so input may contain colons inside `{}`).
  const afterParen = trimmed.slice(parenClose + 1);
  const colonIdx = afterParen.indexOf(":");
  if (colonIdx === -1) return null;
  const output = afterParen.slice(colonIdx + 1).trim();
  const input = trimmed.slice(parenOpen + 1, parenClose).trim();

  // An optional `@ METHOD <template>` clause (`[ENT]` only) sits between the name and `(`:
  //   http.proxy @ POST /proxy/{target}/{path*}(Dto): Dto
  // Everything left of `@` is the noun.verb; `METHOD <template>` declares the route explicitly.
  let namePart = trimmed.slice(0, parenOpen);
  let method: string | undefined;
  let pathTemplate: string | undefined;
  const atIdx = namePart.indexOf("@");
  if (atIdx !== -1) {
    const clause = namePart.slice(atIdx + 1).trim();
    namePart = namePart.slice(0, atIdx);
    const sp = clause.search(/\s/);
    if (sp === -1) {
      method = clause.toLowerCase();
      pathTemplate = "";
    } else {
      method = clause.slice(0, sp).trim().toLowerCase();
      pathTemplate = clause.slice(sp + 1).trim();
    }
  }
  let noun: string;
  let verb: string;

  const dblColon = namePart.indexOf("::");
  if (dblColon !== -1) {
    noun = namePart.slice(0, dblColon).trim();
    verb = namePart.slice(dblColon + 2).trim();
  } else {
    const dot = namePart.indexOf(".");
    if (dot !== -1) {
      noun = namePart.slice(0, dot).trim();
      verb = namePart.slice(dot + 1).trim();
    } else {
      // camelCase form: verbNoun → split at first uppercase char after position 0.
      const name = namePart.trim();
      let split = -1;
      for (let i = 1; i < name.length; i++) {
        if (name[i] >= "A" && name[i] <= "Z") {
          split = i;
          break;
        }
      }
      if (split === -1) return null;
      verb = name.slice(0, split);
      const nounPart = name.slice(split);
      noun = nounPart[0].toLowerCase() + nounPart.slice(1);
    }
  }

  if (noun === "" || verb === "") return null;
  return { noun, verb, input, output, method, pathTemplate };
}

function appendStep(
  step: StepNode | BoundaryStepNode | CtrNode | RetNode,
  currentReq: ReqNode | null,
  _currentPly: PlyNode | null,
  currentCse: CseNode | null,
  err: Err,
  line: number,
): void {
  if (currentCse) {
    currentCse.steps.push(step as CseNode["steps"][number]);
    return;
  }
  if (currentReq) {
    currentReq.steps.push(step);
    return;
  }
  err("step-outside-req", line, { kind: step.kind });
}
