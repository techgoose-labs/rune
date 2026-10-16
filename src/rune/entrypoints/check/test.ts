import { assertEquals } from "#std/assert";
import { join } from "#std/path";
import { runCheck } from "./mod.ts";

const VALID = `[MOD] m

[TYP] id: string
    an id
[DTO] ThingDto: id
    a thing
[NON] thing
    a thing`;

// Same spec but the DTO references a property with no [TYP] — the rule the
// `check` contract advertises (every [DTO] field must resolve).
const MISSING_TYP = `[MOD] m

[TYP] id: string
    an id
[DTO] ThingDto: id, extra
    a thing
[NON] thing
    a thing`;

Deno.test("runCheck — exit 0 on a valid spec", async () => {
  const dir = await Deno.makeTempDir();
  const file = join(dir, "thing.rune");
  await Deno.writeTextFile(file, VALID);
  try {
    assertEquals(await runCheck([file]), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runCheck — exit 2 on a missing-[TYP] spec", async () => {
  const dir = await Deno.makeTempDir();
  const file = join(dir, "thing.rune");
  await Deno.writeTextFile(file, MISSING_TYP);
  try {
    assertEquals(await runCheck([file]), 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runCheck — exit 2 when no spec path is given", async () => {
  assertEquals(await runCheck([]), 2);
});

// [TYP] constraint modifiers flow through check: valid ones are clean,
// unknown/misapplied ones surface as parse errors.
const CONSTRAINED = `[MOD] m

[TYP:uuid] id: string
    an id
[TYP:min=0,max=100] qty: number
    a quantity
[DTO] ThingDto: id, qty
    a thing
[NON] thing
    a thing`;

const BAD_MODIFIER = CONSTRAINED.replace("[TYP:uuid]", "[TYP:bogus]");

Deno.test("runCheck — exit 0 on a spec with constraint modifiers", async () => {
  const dir = await Deno.makeTempDir();
  const file = join(dir, "thing.rune");
  await Deno.writeTextFile(file, CONSTRAINED);
  try {
    assertEquals(await runCheck([file]), 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runCheck — exit 2 on an unknown [TYP] modifier", async () => {
  const dir = await Deno.makeTempDir();
  const file = join(dir, "thing.rune");
  await Deno.writeTextFile(file, BAD_MODIFIER);
  try {
    assertEquals(await runCheck([file]), 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// REQ-013 — machine-readable output with stable rule ids, and a stdin mode so an
// editor buffer can be checked without saving.
function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      log: (s: string) => out.push(s),
      error: (s: string) => err.push(s),
      stdin: () => Promise.resolve(""),
    },
  };
}

Deno.test("REQ-013: runCheck --json prints findings with ids", async () => {
  const dir = await Deno.makeTempDir();
  const file = join(dir, "thing.rune");
  await Deno.writeTextFile(file, MISSING_TYP);
  const c = capture();
  try {
    assertEquals(await runCheck([file, "--json"], c.io), 2);
    const report = JSON.parse(c.out.join(""));
    assertEquals(report.ok, false);
    assertEquals(report.path, file);
    // Warnings ride along in the report (an unused DTO here); `ok` is "no errors".
    const errors = report.findings.filter((f: { severity: string }) => f.severity === "error");
    assertEquals(errors.length, 1);
    assertEquals(errors[0].id, "dto-prop-undefined");
    assertEquals(errors[0].line, 5);
    assertEquals(typeof errors[0].message, "string");
    assertEquals(c.err, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("REQ-013: runCheck --stdin --path checks a buffer", async () => {
  const dir = await Deno.makeTempDir();
  const file = join(dir, "thing.rune");
  // Nothing on disk at `file`: the buffer is the spec.
  const c = capture();
  c.io.stdin = () => Promise.resolve(VALID);
  try {
    assertEquals(await runCheck(["--stdin", "--path", file, "--json"], c.io), 0);
    const report = JSON.parse(c.out.join(""));
    assertEquals(report.ok, true);
    assertEquals(report.findings.filter((f: { severity: string }) => f.severity === "error"), []);
    // --stdin without --path is a usage error.
    assertEquals(await runCheck(["--stdin"], capture().io), 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("REQ-013: runCheck text output names the rule id", async () => {
  const dir = await Deno.makeTempDir();
  const file = join(dir, "thing.rune");
  await Deno.writeTextFile(file, MISSING_TYP);
  const c = capture();
  try {
    assertEquals(await runCheck([file], c.io), 2);
    const lines = c.err.join("\n");
    assertEquals(lines.includes("[dto-prop-undefined]"), true);
    assertEquals(lines.includes(`${file}:5:`), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("REQ-030: runCheck --explain prints the registry doc for a rule id", async () => {
  const c = capture();
  assertEquals(await runCheck(["--explain", "value-duplicate"], c.io), 0);
  const out = c.out.join("\n");
  assertEquals(out.startsWith("value-duplicate — error"), true, out);
  assertEquals(out.includes("message: a value named \"{name}\" is already in scope (from {from})"), true, out);
  assertEquals(out.includes("fix:     name this one"), true, out);
  assertEquals(out.includes("One live value per name"), true, out);
  // An unknown id is a usage error naming the rules.
  const bad = capture();
  assertEquals(await runCheck(["--explain", "nope"], bad.io), 2);
  assertEquals(bad.err.join("\n").includes("unknown rule \"nope\""), true);
  assertEquals(await runCheck(["--explain"], capture().io), 2);
});
