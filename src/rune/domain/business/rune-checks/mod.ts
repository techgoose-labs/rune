// The spec checks: every cross-element rule the registry declares and the
// engine enforces over one parsed spec (REQ-020/021/023, closes todos/08). Pure:
// AST (+ the raw text for the line-shape rules) → findings. Each finding is a
// registry rule rendered through `message()`; `enabled` and `severity` are the
// registry's. The manifest calls this so `rune check`, `rune sync`, the LSP and
// the studio all see one verdict.
//
// The value model (REQ-020): a [REQ]'s scope starts with its input DTO (named
// by its type) and the input's fields (named by field name, recursively through
// nested DTOs). Every step adds the value it yields, named by its `as` name or,
// unnamed, by its type — so a second value of one type must be named. [NEW]
// adds the noun under its own name. Inside a [PLY] case the case's steps see
// the scope at the [PLY]; the case's last step yields the [PLY]'s value.

import type {
  BoundaryStepNode,
  CseNode,
  DtoNode,
  EntNode,
  ReqNode,
  RuneAst,
  StepLike,
  StepNode,
} from "@rune/domain/business/rune-parse/mod.ts";
import type { Finding } from "@rune/domain/business/diagnostics/mod.ts";
import {
  fixFor,
  indent,
  isEnabled,
  message,
  registry,
  severityOf,
  shapeRules,
  tagById,
  wellKnownFault,
} from "@rune/domain/business/registry/mod.ts";

/** The ids this module emits (REQ-026). */
export const EMITS = [
  "tag-indent",
  "dto-suffix",
  "dto-described",
  "typ-unique",
  "dto-unique",
  "non-unique",
  "typ-unused",
  "dto-unused",
  "non-unused",
  "fault-status",
  "req-input-dto",
  "req-output-dto",
  "boundary-types",
  "signature-consistency",
  "duplicate-req-signature",
  "missing-return-type",
  "last-step-returns-output",
  "type-not-dto",
  "noun-in-scope",
  "param-scope",
  "undefined-ref",
  "value-duplicate",
  "ret-redundant",
  "unbound-input-needs-example",
  "edit-record-endpoint",
  "reserved-verb",
] as const;
export type CheckId = typeof EMITS[number];

const PRIMITIVES = new Set([
  "string",
  "number",
  "boolean",
  "void",
  "Uint8Array",
  "Primitive",
]);

// Words that cannot name a generated function or method (ES reserved words and
// the strict-mode reserved words; `undefined`/`NaN` are not reserved but shadow
// globals, so they are refused too).
const RESERVED = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "undefined",
  "NaN",
]);

const RESERVED_SUGGESTION: Record<string, string> = {
  delete: "remove",
  new: "create",
  return: "respond",
  import: "load",
  export: "publish",
  default: "fallback",
};

/** The generated field names of a [DTO] (strip `(s)`/`(s?)`/`?`, pluralize arrays). */
function fieldNames(dto: DtoNode): { name: string; base: string }[] {
  return dto.properties.map((raw) => {
    const array = /\(s\??\)/.test(raw);
    const base = raw.replace(/\(s\??\)/g, "").replace(/\?/g, "").trim();
    return { name: array ? `${base}s` : base, base };
  });
}

/** Strip the shape of a type reference to the name it refers to: `url(s)` →
 * `url`, `Array<url>` → `url`, `[a, b]` → a and b, `"x" | "y"` → nothing. */
function referencedNames(type: string): string[] {
  if (type.startsWith('"')) return [];
  if (type.startsWith("{")) {
    // inline DTO: `{a:x, b:y}` names the field TYPES; `{a, b}` names fields
    // whose type is the [TYP] of the same name.
    return type.slice(1, -1).split(",").map((f) => f.trim()).filter(Boolean)
      .map((f) => (f.includes(":") ? f.split(":")[1] : f).trim());
  }
  return [...type.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]);
}

export function checkSpec(ast: RuneAst, text: string): Finding[] {
  const out: Finding[] = [];
  const emit = (id: CheckId | string, line: number, vars: Record<string, unknown> = {}): void => {
    if (!isEnabled(id)) return;
    const fix = fixFor(id, vars);
    out.push({
      id,
      severity: severityOf(id),
      path: "",
      line: line + 1,
      message: message(id, vars),
      ...(fix ? { fix } : {}),
    });
  };

  const typs = new Map(ast.typs.map((t) => [t.name, t]));
  const dtos = new Map(ast.dtos.map((d) => [d.name, d]));
  const nons = new Set(ast.nons.map((n) => n.name));
  const pascal = (s: string) =>
    s.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  /** Does a type name resolve? A [TYP], a [DTO] (verbatim or by the <Name>Dto
   * convention), a [NON], a primitive, the registry's builtins. */
  const defined = (name: string): boolean =>
    PRIMITIVES.has(name) || registry.builtins.includes(name) || typs.has(name) ||
    dtos.has(name) || dtos.has(`${pascal(name)}Dto`) || nons.has(name);
  const isDto = (name: string): boolean => /Dto$/.test(name) || name.startsWith("{");

  // ---- shape rules: tag-indent, name-suffix, required-description, unique-names, unused ----
  const lines = text.split(/\r?\n/);
  for (const rule of shapeRules("tag-indent")) {
    lines.forEach((l, i) => {
      const found = l.length - l.trimStart().length;
      const m = l.trim().match(/^\[([A-Z]+)(?::[^\]]*)?\]/);
      if (!m) return;
      const tag = registry.tags.find((t) => t.tag === `[${m[1]}]`);
      if (!tag) return;
      // Body lines sit deeper than the registry's column: an [ENT] body [REQ],
      // a ws topic's [REQ], a [PLY] case (relative nesting is the author's).
      const expected = tag.indent;
      if (found === expected) return;
      if (tag.id === "req" && ast.bodyLines.includes(i)) return; // an [ENT]/topic body line
      if ((tag.id === "cse" || tag.id === "ply" || tag.id === "new" || tag.id === "ret") && found > expected) return; // nested in a case
      emit(rule.id, i, { tag: tag.tag, expected, found });
    });
  }
  for (const rule of shapeRules("name-suffix")) {
    const suffix = String(rule.params?.suffix ?? "");
    if (rule.params?.tag === "dto") {
      for (const d of ast.dtos) {
        if (!d.name.endsWith(suffix)) emit(rule.id, d.line, { name: d.name, suffix });
      }
    }
  }
  for (const rule of shapeRules("required-description")) {
    if (rule.params?.tag === "dto") {
      for (const d of ast.dtos) {
        if (!d.description.trim()) emit(rule.id, d.line, { name: d.name });
      }
    }
  }
  for (const rule of shapeRules("unique-names")) {
    const list = rule.params?.tag === "typ" ? ast.typs : rule.params?.tag === "dto" ? ast.dtos : rule.params?.tag === "non" ? ast.nons : [];
    const seen = new Set<string>();
    for (const n of list) {
      if (seen.has(n.name)) emit(rule.id, n.line, { name: n.name });
      seen.add(n.name);
    }
  }

  // Every name a step, [REQ], [ENT], [DTO] or [TYP] references (for `unused`).
  const used = new Set<string>();
  const useType = (t: string) => {
    for (const n of referencedNames(t)) {
      used.add(n);
      used.add(n.replace(/Dto$/, "")); // `ItemDto` also uses a [TYP] named item? no — keep exact
    }
  };
  const walkUse = (steps: StepLike[] | CseNode["steps"]): void => {
    for (const s of steps) {
      if (s.kind === "step" || s.kind === "boundary" || s.kind === "ply") {
        used.add(s.noun);
        for (const p of s.params) useType(p);
        useType(s.output);
        if (s.kind === "ply") for (const c of s.cases) walkUse(c.steps);
      } else if (s.kind === "ctr") used.add(s.className);
      else if (s.kind === "ret") useType(s.value);
    }
  };
  for (const r of ast.reqs) {
    useType(r.input);
    useType(r.output);
    walkUse(r.steps);
  }
  for (const e of ast.ents) {
    useType(e.input);
    useType(e.output);
  }
  for (const d of ast.dtos) {
    for (const { base } of fieldNames(d)) {
      used.add(base);
      used.add(`${pascal(base)}Dto`);
    }
  }
  for (const t of ast.typs) useType(t.typeName);
  for (const rule of shapeRules("unused")) {
    const list = rule.params?.tag === "typ" ? ast.typs : rule.params?.tag === "dto" ? ast.dtos : rule.params?.tag === "non" ? ast.nons : [];
    for (const n of list) {
      // A core element is shared: other modules use it.
      if ("isCore" in n && n.isCore) continue;
      if (!used.has(n.name)) emit(rule.id, n.line, { name: n.name });
    }
  }

  // ---- [TYP] ----
  for (const t of ast.typs) {
    if (t.typeName === "Class") continue; // class-retired covers it
    if (dtos.has(t.typeName) || (/Dto$/.test(t.typeName) && !typs.has(t.typeName))) {
      emit("type-not-dto", t.line, { name: t.name, ref: t.typeName });
    } else {
      for (const ref of referencedNames(t.typeName)) {
        if (!defined(ref)) emit("undefined-ref", t.line, { ref });
      }
    }
  }

  // ---- faults: every name well-known or status-declared ----
  const wellKnown = registry.faults.wellKnown.map((f) => f.id).join(", ");
  const walkFaults = (steps: StepLike[] | CseNode["steps"]): void => {
    for (const s of steps) {
      if (s.kind === "step" || s.kind === "boundary") {
        for (const f of s.faults) {
          if (wellKnownFault(f) === null && ast.faultStatuses[f] === undefined) {
            emit("fault-status", ast.faultLines[f] ?? s.line, { name: f, wellKnown });
          }
        }
      } else if (s.kind === "ply") for (const c of s.cases) walkFaults(c.steps);
    }
  };
  for (const r of ast.reqs) walkFaults(r.steps);

  // ---- [REQ]: signatures, verbs, scope ----
  const reqKeys = new Map<string, number>();
  const sigs = new Map<string, { sig: string; line: number }>();
  const sigOf = (s: { params: string[]; output: string }) => `(${s.params.join(", ")}): ${s.output}`;
  const verbCheck = (verb: string, line: number) => {
    if (RESERVED.has(verb)) {
      emit("reserved-verb", line, { verb, suggestion: RESERVED_SUGGESTION[verb] ?? `${verb}Item` });
    }
  };
  for (const req of ast.reqs) {
    const key = `${req.noun}.${req.verb}`;
    if (reqKeys.has(key)) emit("duplicate-req-signature", req.line, { key });
    else reqKeys.set(key, req.line);
    verbCheck(req.verb, req.line);
    if (!isDto(req.input)) emit("req-input-dto", req.line, { input: req.input });
    else if (!req.input.startsWith("{")) for (const ref of referencedNames(req.input)) if (!defined(ref)) emit("undefined-ref", req.line, { ref });
    if (!/Dto$/.test(req.output) && !req.output.startsWith("{")) emit("req-output-dto", req.line, { output: req.output });
    else if (!req.output.startsWith("{")) for (const ref of referencedNames(req.output)) if (!defined(ref)) emit("undefined-ref", req.line, { ref });

    // The scope: name → the type it holds (and where it came from).
    const scope = new Map<string, { type: string; from: string }>();
    const add = (name: string, type: string, from: string, line: number, receiver?: string): void => {
      const prior = scope.get(name);
      if (prior) {
        // A fluent step on the value itself (`task.fill(title): task`) yields the
        // same value, not a second one.
        if (receiver === name && prior.type === type) return;
        emit("value-duplicate", line, { name, from: prior.from, type });
        return;
      }
      scope.set(name, { type, from });
      // A DTO value exposes its fields by name, like the input does (a name
      // already taken keeps its first meaning).
      if (dtos.has(type)) addDtoFields(type, from, line);
    };
    const addDtoFields = (dtoName: string, from: string, line: number, seen = new Set<string>()): void => {
      const dto = dtos.get(dtoName);
      if (!dto || seen.has(dtoName)) return;
      seen.add(dtoName);
      for (const { name, base } of fieldNames(dto)) {
        const nested = dtos.get(base) ?? dtos.get(`${pascal(base)}Dto`);
        const typ = typs.get(base);
        const type = nested && !typ ? nested.name : base;
        if (!scope.has(name)) scope.set(name, { type, from });
        if (nested && !typ) addDtoFields(nested.name, from, line, seen);
      }
    };
    if (req.input.startsWith("{")) {
      for (const f of req.input.slice(1, -1).split(",")) {
        const name = f.split(":")[0].trim();
        if (name) scope.set(name, { type: f.includes(":") ? f.split(":")[1].trim() : name, from: "the input" });
      }
    } else if (req.input) {
      scope.set(req.input, { type: req.input, from: "the input" });
      addDtoFields(req.input, "the input", req.line);
    }

    const inScope = (name: string): boolean => scope.has(name);

    const checkStep = (s: StepNode | BoundaryStepNode, where: string): void => {
      verbCheck(s.verb, s.line);
      const key = `${s.noun}${s.isStatic ? "::" : "."}${s.verb}`;
      const sig = sigOf(s);
      const first = sigs.get(key);
      if (first && first.sig !== sig) emit("signature-consistency", s.line, { key, got: sig, first: first.sig });
      else if (!first) sigs.set(key, { sig, line: s.line });
      if (s.output === "") emit("missing-return-type", s.line, { step: `${s.noun}.${s.verb}` });
      // A boundary step's noun is its data adapter, never a value in scope.
      if (s.kind === "step" && !s.isStatic && !inScope(s.noun)) emit("noun-in-scope", s.line, { noun: s.noun });
      for (const p of s.params) {
        if (p.startsWith("{")) continue;
        if (!inScope(p)) emit("param-scope", s.line, { param: p });
      }
      if (s.kind === "boundary") {
        const bad = [...s.params, s.output].filter((t) => {
          if (t === "" || t === "void" || t.startsWith("{")) return false;
          const type = scope.get(t)?.type ?? t;
          if (isDto(type)) return false;
          const typ = typs.get(type);
          return !(PRIMITIVES.has(type) || (typ && PRIMITIVES.has(typ.typeName)) || (typ && typ.typeName.startsWith('"')));
        });
        if (bad.length) emit("boundary-types", s.line, { service: s.service, bad: bad.join(", ") });
      }
      if (s.output && s.output !== "void") {
        for (const ref of referencedNames(s.output)) if (!defined(ref) && !inScope(ref)) emit("undefined-ref", s.line, { ref });
        add(s.valueName ?? s.output, s.output, `${where} ${s.noun}.${s.verb}`, s.line, s.isStatic || s.kind === "boundary" ? undefined : s.noun);
      }
    };

    let lastYield: { type: string; name: string; line: number; byRet: boolean } | null = null;
    const walk = (steps: StepLike[] | CseNode["steps"], where: string): void => {
      for (const s of steps) {
        if (s.kind === "ctr") {
          if (!nons.has(s.className)) emit("undefined-ref", s.line, { ref: s.className });
          add(s.className, s.className, `[NEW] ${s.className}`, s.line);
          lastYield = null;
        } else if (s.kind === "ret") {
          const v = scope.get(s.value);
          if (!v) emit("param-scope", s.line, { param: s.value });
          else if (lastYield && lastYield.type === v.type && lastYield.name === s.value && !lastYield.byRet) {
            emit("ret-redundant", s.line, { value: s.value });
          }
          lastYield = { type: v?.type ?? s.value, name: s.value, line: s.line, byRet: true };
        } else if (s.kind === "ply") {
          verbCheck(s.verb, s.line);
          if (!s.isStatic && !inScope(s.noun)) emit("noun-in-scope", s.line, { noun: s.noun });
          for (const p of s.params) if (!p.startsWith("{") && !inScope(p)) emit("param-scope", s.line, { param: p });
          if (s.output === "") emit("missing-return-type", s.line, { step: `${s.noun}.${s.verb}` });
          // Each case sees the scope at the [PLY]; its last step yields the [PLY]'s value.
          const snapshot = new Map(scope);
          for (const c of s.cases) {
            scope.clear();
            for (const [k, v] of snapshot) scope.set(k, v);
            const saved = lastYield;
            walk(c.steps, `case ${c.name}`);
            const got = lastYield as { type: string } | null;
            if (s.output && s.output !== "void" && got && got.type !== s.output) {
              emit("last-step-returns-output", c.steps[c.steps.length - 1]?.line ?? c.line, { output: s.output, got: got.type });
            }
            lastYield = saved;
          }
          scope.clear();
          for (const [k, v] of snapshot) scope.set(k, v);
          if (s.output && s.output !== "void") {
            add(s.valueName ?? s.output, s.output, `${where} [PLY] ${s.noun}.${s.verb}`, s.line);
            lastYield = { type: s.output, name: s.valueName ?? s.output, line: s.line, byRet: false };
          } else lastYield = null;
        } else {
          checkStep(s, where);
          lastYield = s.output && s.output !== "void"
            ? { type: s.output, name: s.valueName ?? s.output, line: s.line, byRet: false }
            : null;
        }
      }
    };
    walk(req.steps, `step`);
    if (req.steps.length > 0) {
      const got = lastYield as { type: string } | null;
      if (!got || got.type !== req.output) {
        emit("last-step-returns-output", req.steps[req.steps.length - 1].line, {
          output: req.output,
          got: got?.type ?? "void",
        });
      }
    }
  }

  // ---- [ENT]: the waist rule and unbound inputs ----
  const httpEnts = ast.ents.filter((e) => e.kind !== "ws");
  const minted = (e: EntNode): Set<string> => {
    const outDto = dtos.get(e.output);
    if (!outDto) return new Set();
    const inDto = dtos.get(e.input);
    const echoed = new Set(inDto ? fieldNames(inDto).map((f) => f.name) : []);
    return new Set(fieldNames(outDto).map((f) => f.name).filter((f) => !echoed.has(f)));
  };
  httpEnts.forEach((ent, i) => {
    if (ent.method === "put" || ent.method === "patch") {
      emit("edit-record-endpoint", ent.line, { surface: ent.surface, action: ent.action, method: ent.method.toUpperCase() });
    }
    const inDto = dtos.get(ent.input);
    if (!inDto) return;
    for (const { name, base } of fieldNames(inDto)) {
      if (/\?/.test(inDto.properties.find((p) => p.replace(/\(s\??\)/g, "").replace(/\?/g, "").trim() === base) ?? "")) continue; // optional
      const produced = httpEnts.some((p, pi) => pi < i && minted(p).has(name));
      if (produced) continue;
      const typ = typs.get(base);
      if (!typ) continue; // a nested DTO field is composed, not seeded
      if (typ.isExternal) continue; // a $bind: seeds / ghost stubs supply it
      if (typ.modifiers.some((m) => m.startsWith("example="))) continue;
      emit("unbound-input-needs-example", ent.line, { field: name, ent: `${ent.surface}.${ent.action}` });
    }
  });

  return out;
}

/** The registry's indent table, for callers that render fixes. */
export const INDENT = indent;
/** The registry's tag table, for callers that render fixes. */
export const TAGS = tagById;
