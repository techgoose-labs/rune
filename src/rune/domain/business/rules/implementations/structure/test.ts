import { assertEquals } from "#std/assert";
import { check, getExpectedAt, getRequiredFiles, resolveNode } from "./mod.ts";
import type { PipelineContext } from "@/core/dto/types.ts";

function makeCtx(files: string[], dirs: string[]): PipelineContext {
  return {
    targetDir: "/fake",
    files,
    dirs,
    getFileContent: async () => "",
    getImports: async () => [],
    lsp: null,
  };
}

Deno.test("resolveNode — valid path", () => {
  const node = resolveNode(["bootstrap"]);
  assertEquals(node !== null, true);
});

Deno.test("resolveNode — invalid path", () => {
  const node = resolveNode(["nonexistent"]);
  assertEquals(node, null);
});

Deno.test("getRequiredFiles — bootstrap has mod and config", () => {
  const node = resolveNode(["bootstrap"]);
  const required = getRequiredFiles(node!);
  assertEquals(required.includes("mod"), true);
  assertEquals(required.includes("config"), true);
});

Deno.test("getRequiredFiles — excludes optional files", () => {
  const node = resolveNode(["bootstrap"]);
  const required = getRequiredFiles(node!);
  // bootstrap has no optional files, so length should be 2
  assertEquals(required.length, 2);
});

Deno.test("getExpectedAt — returns structure info", () => {
  const node = resolveNode(["bootstrap"]);
  const expected = getExpectedAt(node!);
  assertEquals(typeof expected.desc, "string");
});

Deno.test("check — bootstrap folder with required files passes", async () => {
  const ctx = makeCtx(
    ["bootstrap/mod.ts", "bootstrap/config.ts"],
    ["bootstrap"],
  );
  const result = await check("bootstrap", "folder", ctx);
  assertEquals(result, null);
});

Deno.test("check — file with correct extension passes", async () => {
  const ctx = makeCtx(
    ["bootstrap/mod.ts", "bootstrap/config.ts"],
    ["bootstrap"],
  );
  const result = await check("bootstrap/mod.ts", "ts", ctx);
  assertEquals(result, null);
});

Deno.test("check — file with wrong extension is flagged", async () => {
  const ctx = makeCtx(
    ["bootstrap/mod.js", "bootstrap/config.ts"],
    ["bootstrap"],
  );
  const result = await check("bootstrap/mod.js", "js", ctx);
  assertEquals(result !== null, true);
  assertEquals(result![0].includes("Wrong extension"), true);
});

Deno.test("check — fixture .json file is allowed", async () => {
  const ctx = makeCtx(
    ["fixtures/seeds/users.json"],
    ["fixtures", "fixtures/seeds"],
  );
  const result = await check("fixtures/seeds/users.json", "json", ctx);
  assertEquals(result, null);
});

Deno.test("check — fixture allows any file (ignore)", async () => {
  const ctx = makeCtx(
    ["fixtures/seeds/users.ts"],
    ["fixtures", "fixtures/seeds"],
  );
  const result = await check("fixtures/seeds/users.ts", "ts", ctx);
  assertEquals(result, null);
});

Deno.test("check — the spec/ staging layout: runes/ holds specs, misc/ + ui/ are ignore buckets", async () => {
  const ctx = makeCtx(
    [
      "spec/runes/core.rune",
      "spec/runes/orders.rune",
      "spec/misc/data.json",
      "spec/misc/data.review.html",
      "spec/misc/cake.json",
      "spec/misc/scenarios/happy.json",
      "spec/ui/index.html",
      "spec/ui/pages/queue.tsx",
      "spec/product/spec.md",
      "spec/product/user-stories.md",
      "spec/contract/openapi.json",
      "spec/contract/binding.md",
      "spec/contract/client/dtos.ts",
      "spec/orders.rune", // legacy flat — still allowed
    ],
    [
      "spec",
      "spec/runes",
      "spec/misc",
      "spec/misc/scenarios",
      "spec/ui",
      "spec/ui/pages",
      "spec/product",
      "spec/contract",
      "spec/contract/client",
    ],
  );
  // The three staging folders are recognized.
  assertEquals(await check("spec/runes", "folder", ctx), null);
  assertEquals(await check("spec/misc", "folder", ctx), null);
  assertEquals(await check("spec/ui", "folder", ctx), null);
  // Authored specs in spec/runes/, plus a legacy flat spec, are allowed.
  assertEquals(await check("spec/runes/core.rune", "rune", ctx), null);
  assertEquals(await check("spec/runes/orders.rune", "rune", ctx), null);
  assertEquals(await check("spec/orders.rune", "rune", ctx), null);
  // spec/misc/ and spec/ui/ are ignore buckets — any artifact is allowed.
  assertEquals(await check("spec/misc/data.json", "json", ctx), null);
  assertEquals(await check("spec/misc/data.review.html", "html", ctx), null);
  assertEquals(await check("spec/misc/cake.json", "json", ctx), null);
  assertEquals(
    await check("spec/misc/scenarios/happy.json", "json", ctx),
    null,
  );
  assertEquals(await check("spec/ui/index.html", "html", ctx), null);
  assertEquals(await check("spec/ui/pages/queue.tsx", "tsx", ctx), null);
  // spec/product/ holds the founding docs (rune:scope output) — an ignore bucket.
  assertEquals(await check("spec/product", "folder", ctx), null);
  assertEquals(await check("spec/product/spec.md", "md", ctx), null);
  assertEquals(await check("spec/product/user-stories.md", "md", ctx), null);
  // spec/contract/ holds the ratified contract's machine faces — an ignore bucket.
  assertEquals(await check("spec/contract", "folder", ctx), null);
  assertEquals(await check("spec/contract/openapi.json", "json", ctx), null);
  assertEquals(await check("spec/contract/binding.md", "md", ctx), null);
  assertEquals(await check("spec/contract/client/dtos.ts", "ts", ctx), null);
});

Deno.test("check — dto .ts file is allowed", async () => {
  const ctx = makeCtx(
    ["src/core/dto/types.ts"],
    ["src", "src/core", "src/core/dto"],
  );
  const result = await check("src/core/dto/types.ts", "ts", ctx);
  assertEquals(result, null);
});

Deno.test("check — assets file with any extension passes", async () => {
  const ctx = makeCtx(
    ["assets/images/logo.png"],
    ["assets", "assets/images"],
  );
  const result = await check("assets/images/logo.png", "png", ctx);
  assertEquals(result, null);
});

Deno.test("check — optional file present passes", async () => {
  const ctx = makeCtx(
    [
      "src/mymod/entrypoints/home/mod.ts",
      "src/mymod/entrypoints/home/template.html",
    ],
    ["src", "src/mymod", "src/mymod/entrypoints", "src/mymod/entrypoints/home"],
  );
  const result = await check(
    "src/mymod/entrypoints/home/template.html",
    "html",
    ctx,
  );
  assertEquals(result, null);
});

Deno.test("check — optional file with wrong extension is flagged", async () => {
  const ctx = makeCtx(
    [
      "src/mymod/entrypoints/home/mod.ts",
      "src/mymod/entrypoints/home/template.ts",
    ],
    ["src", "src/mymod", "src/mymod/entrypoints", "src/mymod/entrypoints/home"],
  );
  const result = await check(
    "src/mymod/entrypoints/home/template.ts",
    "ts",
    ctx,
  );
  assertEquals(result !== null, true);
  assertEquals(result![0].includes("Wrong extension"), true);
});

Deno.test("check — feature folder with only mod.ts (no test.ts) should be flagged", async () => {
  const ctx = makeCtx(
    ["src/mymod/domain/business/myfeat/mod.ts"],
    [
      "src",
      "src/mymod",
      "src/mymod/domain",
      "src/mymod/domain/business",
      "src/mymod/domain/business/myfeat",
    ],
  );
  const result = await check("src/mymod/domain/business/myfeat", "folder", ctx);
  assertEquals(
    result !== null,
    true,
    "feature folder with only mod.ts should be flagged",
  );
});

// A resolvable [PLY] feature folder (base/ + implementations/ + poly-mod.ts),
// the shape a non-trivial dispatcher lives in.
const POLY_DIRS = [
  "src/orders",
  "src/orders/domain",
  "src/orders/domain/business",
  "src/orders/domain/business/channel",
  "src/orders/domain/business/channel/base",
  "src/orders/domain/business/channel/implementations",
  "src/orders/domain/business/channel/implementations/email",
];
const POLY_FILES = [
  "src/orders/domain/business/channel/base/mod.ts",
  "src/orders/domain/business/channel/implementations/email/mod.ts",
  "src/orders/domain/business/channel/poly-mod.ts",
];

Deno.test("check — leading-underscore helper is allowed in a recognized [PLY] folder", async () => {
  // A non-trivial [PLY] dispatcher can split into co-located helpers; an
  // underscore prefix marks them as intentional internal files (not a junk drawer).
  const ctx = makeCtx(
    [...POLY_FILES, "src/orders/domain/business/channel/_dispatch.ts"],
    POLY_DIRS,
  );
  const result = await check(
    "src/orders/domain/business/channel/_dispatch.ts",
    "ts",
    ctx,
  );
  assertEquals(result, null);
});

Deno.test("check — underscore helper with a loose word is still flagged", async () => {
  // The loose-name guard wins over the underscore allowance — `_helpers.ts`
  // (contains "helpers") is still a vague junk drawer.
  const ctx = makeCtx(
    [...POLY_FILES, "src/orders/domain/business/channel/_helpers.ts"],
    POLY_DIRS,
  );
  const result = await check(
    "src/orders/domain/business/channel/_helpers.ts",
    "ts",
    ctx,
  );
  assertEquals(result !== null, true);
  assertEquals(result!.some((v) => v.includes("loose/vague")), true);
});

// ---- L2: loose-name guard must match whole tokens, not bare substrings ----
// Legitimate names that merely EMBED a loose word (utilization→util,
// commonwealth→common, futility→util) must NOT be flagged, while names that ARE
// a loose word (alone or as a camelCase/kebab segment) still are.

// A descriptor <feature> folder accepts arbitrary user-named modules; a file
// living in it is rejected ONLY by the loose-name guard, so this isolates it.
const FEATURE_DIRS = [
  "src",
  "src/orders",
  "src/orders/domain",
  "src/orders/domain/business",
];
function featureFile(name: string): string {
  return `src/orders/domain/business/${name}.ts`;
}

Deno.test("check — names that merely embed a loose word are NOT flagged (L2)", async () => {
  for (const name of ["utilization", "commonwealth", "futility"]) {
    const dirs = [...FEATURE_DIRS, `src/orders/domain/business/${name}`];
    const ctx = makeCtx([featureFile(name)], dirs);
    const result = await check(featureFile(name), "ts", ctx);
    assertEquals(
      result === null || !result.some((v) => v.includes("loose/vague")),
      true,
      `"${name}" must not be flagged as loose; got: ${JSON.stringify(result)}`,
    );
  }
});

Deno.test("check — names that ARE a loose word/segment are still flagged (L2)", async () => {
  for (const name of ["utils", "shared", "my-utils", "commonHelper"]) {
    const dirs = [...FEATURE_DIRS, `src/orders/domain/business/${name}`];
    const ctx = makeCtx([featureFile(name)], dirs);
    const result = await check(featureFile(name), "ts", ctx);
    assertEquals(
      result !== null && result.some((v) => v.includes("loose/vague")),
      true,
      `"${name}" must still be flagged as loose; got: ${
        JSON.stringify(result)
      }`,
    );
  }
});

Deno.test("check — [PLY] dispatcher mod.ts is allowed alongside base/implementations/poly-mod", async () => {
  // The poly variant now allows an optional dispatcher mod.ts at the folder root.
  const ctx = makeCtx(
    [...POLY_FILES, "src/orders/domain/business/channel/mod.ts"],
    POLY_DIRS,
  );
  const result = await check(
    "src/orders/domain/business/channel/mod.ts",
    "ts",
    ctx,
  );
  assertEquals(result, null);
});

// ---- S12: a required file must be a DIRECT child — a grandchild with the same
//      basename must not satisfy the presence check. ----
Deno.test("check — S12: a grandchild mod.ts does not satisfy a coordinator's required mod", async () => {
  // coordinators/<process>/ requires `mod` and `int.test` AS DIRECT CHILDREN.
  // Here both only exist one level deeper (in a `sub/` grandchild), so the
  // coordinator folder is missing them and must be flagged.
  const ctx = makeCtx(
    [
      "src/orders/domain/coordinators/checkout/sub/mod.ts",
      "src/orders/domain/coordinators/checkout/sub/int.test.ts",
    ],
    [
      "src",
      "src/orders",
      "src/orders/domain",
      "src/orders/domain/coordinators",
      "src/orders/domain/coordinators/checkout",
      "src/orders/domain/coordinators/checkout/sub",
    ],
  );
  const result = await check(
    "src/orders/domain/coordinators/checkout",
    "folder",
    ctx,
  );
  assertEquals(
    result !== null &&
      result.some((v) => v.includes('Missing required file "mod"')),
    true,
    `grandchild mod.ts must not satisfy the required direct-child mod; got: ${
      JSON.stringify(result)
    }`,
  );
});

Deno.test("check — S12: a direct-child mod.ts + int.test.ts still passes", async () => {
  const ctx = makeCtx(
    [
      "src/orders/domain/coordinators/checkout/mod.ts",
      "src/orders/domain/coordinators/checkout/int.test.ts",
    ],
    [
      "src",
      "src/orders",
      "src/orders/domain",
      "src/orders/domain/coordinators",
      "src/orders/domain/coordinators/checkout",
    ],
  );
  const result = await check(
    "src/orders/domain/coordinators/checkout",
    "folder",
    ctx,
  );
  assertEquals(
    result,
    null,
    `direct children must satisfy: ${JSON.stringify(result)}`,
  );
});
