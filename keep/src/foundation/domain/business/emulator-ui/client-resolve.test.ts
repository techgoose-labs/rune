// Unit tests for the cake's reference-resolution core, extracted straight from the shipped
// client source (emulatorClientJs) so there is no drift between what is tested and what runs.
//
// The full client only executes in a browser (it touches window/document/localStorage), and the
// Playwright browser test additionally imports bootstrapServer — so this file deliberately pulls
// ONLY the pure functions (isRefShape / resolveString / markMissing + the REF_* regexes) out of
// the source string and runs them in a tiny sandbox with stubbed closure deps. It covers the
// behaviour added for opaque/webhook payloads: known-ref-only gating, the \{{ }} escape, and
// missing-only highlighting.
import { assertEquals } from "#assert";
import { emulatorClientJs } from "./client.ts";

// ── extract function/lexical source by anchors (no brace-matching: comments contain braces) ──
function between(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  if (i < 0) throw new Error("start anchor not found: " + start);
  const j = src.indexOf(end, i + start.length);
  if (j < 0) throw new Error("end anchor not found: " + end);
  return src.slice(i, j);
}

const src = emulatorClientJs;
const sandboxSrc = [
  between(src, "var REF_RE = ", "function hasOwn("), // REF_RE / WHOLE_REF_RE / REF_TEST
  between(src, "function isRefShape(ref) {", "// Resolution is recursive"),
  between(
    src,
    "function resolveString(s, missing, depth) {",
    "function resolveValue(",
  ),
  between(src, "function markMissing(html, missing) {", "function agoText("),
  "return { isRefShape: isRefShape, resolveString: resolveString, markMissing: markMissing };",
].join("\n");

// deno-lint-ignore no-explicit-any
const makeSandbox = new Function(
  "hasOwn",
  "globals",
  "state",
  "byId",
  "lookupRef",
  sandboxSrc,
) as (
  hasOwn: (o: unknown, k: string) => boolean,
  globals: unknown,
  state: unknown,
  byId: unknown,
  lookupRef: (ref: string) => { found: boolean; value?: unknown },
  // deno-lint-ignore no-explicit-any
) => any;

interface World {
  vars?: Record<string, unknown>;
  gcaptured?: Record<string, unknown>;
  captured?: Record<string, unknown>;
  byId?: Record<string, unknown>;
  resolved?: Record<string, unknown>; // what lookupRef can resolve
}

function harness(w: World = {}) {
  const hasOwn = (o: unknown, k: string) =>
    Object.prototype.hasOwnProperty.call(o, k);
  const globals = { vars: w.vars || {}, captured: w.gcaptured || {} };
  const state = { captured: w.captured || {} };
  const byId = w.byId || {};
  const resolved = w.resolved || {};
  const lookupRef = (ref: string) =>
    hasOwn(resolved, ref)
      ? { found: true, value: resolved[ref] }
      : { found: false };
  return makeSandbox(hasOwn, globals, state, byId, lookupRef);
}

// ── known-ref-only gating: a real third-party payload is NOT mistaken for refs ──────────────
Deno.test("bare payload token stays literal and is never reported missing", () => {
  const { resolveString } = harness();
  const missing: string[] = [];
  const out = resolveString(
    "hi {{ReservationCustomerFirstName}} there",
    missing,
  );
  assertEquals(out, "hi {{ReservationCustomerFirstName}} there");
  assertEquals(missing, []);
});

Deno.test("whole-string bare token stays literal (no missing)", () => {
  const { resolveString } = harness();
  const missing: string[] = [];
  assertEquals(
    resolveString("{{customer_name}}", missing),
    "{{customer_name}}",
  );
  assertEquals(missing, []);
});

Deno.test("inherited Object.prototype head names stay literal (no prototype-pollution false ref)", () => {
  const { resolveString } = harness({ byId: { create: {} } });
  for (
    const tok of [
      "constructor",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "__proto__",
    ]
  ) {
    const missing: string[] = [];
    const src = `{{${tok}.x}}`;
    assertEquals(resolveString(src, missing), src, `${tok} must stay literal`);
    assertEquals(missing, [], `${tok} must not be reported missing`);
  }
});

Deno.test("dotted ref with an UNKNOWN head is treated as literal, not a producer ref", () => {
  const { resolveString } = harness({ byId: { create: {} } });
  const missing: string[] = [];
  // `pathway_logs` is not a known endpoint/capture → literal payload, not a ref.
  assertEquals(
    resolveString("{{pathway_logs.0.message}}", missing),
    "{{pathway_logs.0.message}}",
  );
  assertEquals(missing, []);
});

// ── genuine refs still block + heal ─────────────────────────────────────────────────────────
Deno.test("$input ref is recognised and reported missing when unresolved", () => {
  const { resolveString } = harness();
  const missing: string[] = [];
  resolveString("{{$customerId}}", missing);
  assertEquals(missing, ["$customerId"]);
});

Deno.test("endpoint.field ref with a KNOWN head is reported missing when not yet captured", () => {
  const { resolveString } = harness({ byId: { create: {} } });
  const missing: string[] = [];
  resolveString("{{create.id}}", missing);
  assertEquals(missing, ["create.id"]);
});

Deno.test("module:endpoint.field shape is recognised as a ref", () => {
  const { resolveString } = harness();
  const missing: string[] = [];
  resolveString("{{billing:invoice.total}}", missing);
  assertEquals(missing, ["billing:invoice.total"]);
});

Deno.test("a resolvable ref is substituted and not reported missing", () => {
  const { resolveString } = harness({ resolved: { "create.id": "thing-7" } });
  const missing: string[] = [];
  assertEquals(resolveString("id={{create.id}}", missing), "id=thing-7");
  assertEquals(missing, []);
});

Deno.test("known environment variable name is a ref", () => {
  const { resolveString } = harness({
    vars: { apiBase: "x" },
    resolved: { apiBase: "https://api" },
  });
  const missing: string[] = [];
  assertEquals(resolveString("{{apiBase}}/v1", missing), "https://api/v1");
  assertEquals(missing, []);
});

// ── the \{{ }} escape ───────────────────────────────────────────────────────────────────────
Deno.test("backslash escapes the braces — inline", () => {
  const { resolveString } = harness();
  const missing: string[] = [];
  // In JS source, "\\{{x}}" is the two characters: backslash + {{x}}.
  assertEquals(resolveString("a \\{{x}} b", missing), "a {{x}} b");
  assertEquals(missing, []);
});

Deno.test("backslash escape on a would-be real ref keeps it literal", () => {
  const { resolveString } = harness({ resolved: { "$customerId": "C1" } });
  const missing: string[] = [];
  assertEquals(resolveString("\\{{$customerId}}", missing), "{{$customerId}}");
  assertEquals(missing, []);
});

// ── markMissing highlights ONLY the unresolved refs, never literals ─────────────────────────
Deno.test("markMissing reddens only tokens in the missing set", () => {
  const { markMissing } = harness();
  const html = "{{$customerId}} and {{literalPayload}}";
  const out = markMissing(html, ["$customerId"]);
  assertEquals(
    out,
    '<span class="j-miss">{{$customerId}}</span> and {{literalPayload}}',
  );
});

Deno.test("markMissing with an empty missing set is a no-op (all literals)", () => {
  const { markMissing } = harness();
  const html = "{{a}} {{b}} {{c}}";
  assertEquals(markMissing(html, []), html);
});
