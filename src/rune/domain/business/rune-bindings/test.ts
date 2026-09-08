import { assertEquals } from "#std/assert";
import {
  applyCase,
  bindings,
  isInProgSpec,
  isProjectSpec,
  moduleFromSpecPath,
  processName,
  transformName,
} from "./mod.ts";
import { canonicalPaths as SHAPE } from "@rune/domain/business/artifact/canonical-paths.ts";

Deno.test("isProjectSpec — recognizes the spec-folder and src layouts", () => {
  assertEquals(isProjectSpec("spec/runes/todos.rune"), true); // canonical staging dir
  assertEquals(isProjectSpec("specs/runes/todos.rune"), true);
  assertEquals(isProjectSpec("spec/todos.rune"), true); // legacy flat
  assertEquals(isProjectSpec("specs/todos.rune"), true);
  assertEquals(isProjectSpec("src/todos/todos.rune"), true);
  assertEquals(isProjectSpec("src/todos/spec.rune"), true);
  assertEquals(isProjectSpec("docs/notes.rune"), false);
});

Deno.test("isProjectSpec — sibling spec/misc and spec/ui dirs are NOT spec dirs", () => {
  // spec/misc/ (data + cake artifacts) and spec/ui/ (sprig prototype) live under
  // spec/ but are not staging dirs: their paths have a slash after `spec/` and
  // aren't `<name>.rune` directly under a recognized dir, so they fall through.
  assertEquals(isProjectSpec("spec/misc/data.json"), false);
  assertEquals(isProjectSpec("spec/ui/index.html"), false);
  assertEquals(isProjectSpec("spec/ui/components/card.rune"), false); // nested too deep
});

Deno.test("isProjectSpec — .in-prog.rune drafts are excluded", () => {
  assertEquals(isInProgSpec("spec/todos.in-prog.rune"), true);
  assertEquals(isInProgSpec("spec/todos.rune"), false);
  // A draft is NOT a project spec anywhere — auto-discovery skips it entirely.
  assertEquals(isProjectSpec("spec/todos.in-prog.rune"), false);
  assertEquals(isProjectSpec("src/todos/todos.in-prog.rune"), false);
});

Deno.test("moduleFromSpecPath — strips the .in-prog tag so explicit sync resolves", () => {
  assertEquals(moduleFromSpecPath("spec/runes/todos.rune"), "todos"); // canonical
  assertEquals(moduleFromSpecPath("spec/runes/todos.in-prog.rune"), "todos");
  assertEquals(moduleFromSpecPath("specs/runes/todos.rune"), "todos");
  assertEquals(moduleFromSpecPath("spec/todos.rune"), "todos"); // legacy flat
  assertEquals(moduleFromSpecPath("spec/todos.in-prog.rune"), "todos");
  assertEquals(moduleFromSpecPath("specs/todos.in-prog.rune"), "todos");
  assertEquals(moduleFromSpecPath("src/orders/orders.rune"), "orders");
  assertEquals(moduleFromSpecPath("docs/notes.rune"), null);
});

Deno.test("applyCase — kebab", () => {
  assertEquals(applyCase("GetRecordingDto", "kebab"), "get-recording-dto");
  assertEquals(applyCase("fiveNine", "kebab"), "five-nine");
  assertEquals(applyCase("metadata", "kebab"), "metadata");
});

Deno.test("applyCase — camel/pascal/lower", () => {
  assertEquals(applyCase("Recording", "camel"), "recording");
  assertEquals(applyCase("recording", "pascal"), "Recording");
  assertEquals(applyCase("HELLO", "lower"), "hello");
});

Deno.test("transformName — strips Dto suffix and kebabs", () => {
  const b = bindings["<name>"];
  assertEquals(transformName("GetRecordingDto", b), "get-recording");
  assertEquals(transformName("IdDto", b), "id");
});

Deno.test("transformName — no-op when suffix doesn't match", () => {
  const b = bindings["<name>"];
  assertEquals(transformName("url", b), "url");
});

Deno.test("processName — kebabs noun-verb", () => {
  assertEquals(processName("recording", "set"), "recording-set");
  assertEquals(processName("recording", "get"), "recording-get");
  assertEquals(
    processName("recordingMetadata", "set"),
    "recording-metadata-set",
  );
});

Deno.test("bindings — every placeholder maps to at least one rune source", () => {
  for (const [placeholder, binding] of Object.entries(bindings)) {
    assertEquals(
      binding.from.length > 0,
      true,
      `placeholder ${placeholder} has no source`,
    );
  }
});

Deno.test("bindings — every placeholder under src/ has a binding", () => {
  // Only src/ is rune-managed. fixtures/, assets/, dist/, bootstrap/ are not.
  const srcSubtree = (SHAPE as Record<string, unknown>)["src/"];
  const placeholders = collectPlaceholders(srcSubtree);
  const known = new Set(Object.keys(bindings));
  const missing: string[] = [];
  for (const p of placeholders) {
    if (!known.has(p)) missing.push(p);
  }
  assertEquals(
    missing,
    [],
    `canonical-paths.json src/ has placeholders without bindings: ${
      missing.join(", ")
    }`,
  );
});

// Walk a canonical-paths subtree and collect every "<...>" placeholder seen as a key.
function collectPlaceholders(
  node: unknown,
  out = new Set<string>(),
): Set<string> {
  if (Array.isArray(node)) {
    for (const v of node) collectPlaceholders(v, out);
    return out;
  }
  if (typeof node !== "object" || node === null) return out;
  for (const [key, value] of Object.entries(node)) {
    const stripped = key.endsWith("/") ? key.slice(0, -1) : key;
    if (stripped.startsWith("<") && stripped.endsWith(">")) {
      out.add(stripped);
    }
    collectPlaceholders(value, out);
  }
  return out;
}
