import { resolve } from "#std/path";
import { validateArtifact } from "@rune/domain/business/artifact/mod.ts";

// rune validate <artifact.json> [--json]
//
// Runs the meta-validator over an artifact and exits non-zero if it is invalid
// (WO-3 / L1). This is the same check the engine runs on load once it is
// artifact-driven (WO-4), surfaced as a standalone gate for CI.
export async function runValidate(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("Usage: rune validate <artifact.json> [--json]");
    return 2;
  }

  let raw: string;
  try {
    raw = await Deno.readTextFile(resolve(path));
  } catch (e) {
    console.error(
      `error: cannot read ${path}: ${e instanceof Error ? e.message : e}`,
    );
    return 2;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(
      `error: ${path} is not valid JSON: ${e instanceof Error ? e.message : e}`,
    );
    return 2;
  }

  const result = validateArtifact(parsed);
  if (json) {
    console.log(
      JSON.stringify({ ok: result.ok, errors: result.errors }, null, 2),
    );
  } else if (result.ok) {
    console.log(`\x1b[32m${path}: valid artifact\x1b[0m`);
  } else {
    console.error(
      `\x1b[31m${path}: invalid artifact (${result.errors.length} error(s)):\x1b[0m`,
    );
    for (const e of result.errors) console.error(`  [${e.path}] ${e.message}`);
  }
  return result.ok ? 0 : 1;
}
