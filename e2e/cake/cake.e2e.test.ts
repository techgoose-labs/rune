// End-to-end acceptance for the rune -> keep flow, exercised through the cake module
// (rune-generated from examples/cake/src/cake/cake.rune, bodies filled to chain deterministically).
// Run from the keep root: `deno task test:e2e` (in-process), or `KEEP_BROWSER=1 deno task test:e2e`
// to add the interactive-emulator browser stage.
import "reflect-metadata";
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "#assert";
import { bootstrapServer, exerciseEndpoints } from "@mrg-keystone/rune";
import { httpModule } from "@/src/cake/entrypoints/http/mod.ts";

let port = 8790;

const CHAIN = [
  "driveToStore",
  "groceryShop",
  "checkout",
  "mixIngredients",
  "bake",
  "cut",
];

// The exact HTTP routes the generated controller should expose, in any order — the contract the
// spec/Swagger surface must hold. `CHAIN` (above) is the matching source of truth for the count.
const EXPECTED_PATHS = [
  "/http/drive-to-store",
  "/http/grocery-shop",
  "/http/checkout",
  "/http/mix-ingredients",
  "/http/bake",
  "/http/cut",
];

// Stage 1/2 — the generated controller exposes 6 ordered, chained, schema'd endpoints.
Deno.test("cake e2e — 6 endpoints with schemas + x-keep-process chain", async () => {
  const api = await bootstrapServer("cake", httpModule, { port: port++ });
  try {
    const doc = api.docs[0].doc;
    assertEquals(
      Object.keys(doc.paths ?? {}).sort(),
      [...EXPECTED_PATHS].sort(),
    );
    assertExists(doc.components?.schemas?.ArrivalDto);
    assertExists(doc.components?.schemas?.SlicesDto);
    // Last step's process metadata is fully derived from the DTO field graph.
    const cut = doc.paths!["/http/cut"].post!["x-keep-process"];
    assertEquals(cut?.order, 6);
    assertEquals(cut?.dependsOn, ["bake"]);
    assertEquals(cut?.bind, { cakeId: "bake.cakeId" });
  } finally {
    await api.stop();
  }
});

// Stage 5 — the headless runner drives the whole chain green in-process (no browser).
Deno.test("cake e2e — exerciseEndpoints chains all 6 green in-process", async () => {
  const api = await bootstrapServer("cake", httpModule, { port: port++ });
  try {
    const report = await exerciseEndpoints({ api });
    assertEquals(report.order, CHAIN);
    assertEquals(report.cycles, []);
    assertEquals(report.failed.map((r) => r.id), []);
    assertEquals(report.passed.length, 6);
  } finally {
    await api.stop();
  }
});

// Stage 7 — the deeper-inspection surfaces are reachable (no browser needed): the emulator page,
// the standard Swagger UI, and the raw OpenAPI spec (served to the loopback caller).
Deno.test("cake e2e — emulator page, Swagger UI, and raw spec are all served", async () => {
  const p = port++;
  const api = await bootstrapServer("cake", httpModule, { port: p });
  await api.listen();
  try {
    const base = `http://localhost:${p}`;

    const emulator = await fetch(`${base}/api/docs/cake`);
    assertEquals(emulator.status, 200);
    assertStringIncludes(await emulator.text(), "process emulator");

    const swagger = await fetch(`${base}/api/docs/cake/swagger`);
    assertEquals(swagger.status, 200);
    assertStringIncludes(await swagger.text(), "swagger-ui");

    const spec = await fetch(`${base}/api/docs/cake/json`); // loopback is trusted, so it's served
    assertEquals(spec.status, 200);
    const doc = await spec.json();
    assertEquals(Object.keys(doc.paths).sort(), [...EXPECTED_PATHS].sort());
  } finally {
    await api.stop();
  }
});

// Stage 4 — the interactive emulator, driven in headless chromium. Each cake step is emulated
// explicitly, in order, as its own named t.step so the run output reads like the process itself:
// drive to store -> grocery shop -> checkout -> mix ingredients -> bake -> cut. Every step asserts
// it's unlocked, the next step is still locked, its resolved request carries the value captured
// from the previous step (bodies hold {{step.field}} references), and a checkmark appears after
// it runs. Opt-in (needs
// `deno run -A npm:playwright install chromium chromium-headless-shell`; `deno task cake` provisions).
Deno.test({
  name:
    "cake e2e — emulator drives all 6 steps: progressive unlock + autofill + checkmarks",
  ignore: Deno.env.get("KEEP_BROWSER") !== "1",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async (t) => {
    const p = port++;
    const api = await bootstrapServer("cake", httpModule, { port: p });
    await api.listen();
    const { chromium } = await import("#playwright");
    // KEEP_HEADED=1 launches a visible browser and slows actions so you can watch the
    // emulator walk the chain (`deno task cake`); otherwise it runs headless.
    const headed = Deno.env.get("KEEP_HEADED") === "1";
    const browser = await chromium.launch({
      headless: !headed,
      slowMo: headed ? 500 : 0,
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${p}/api/docs/cake`);

      const emulate = page.locator("button.emulate"); // the six per-step "Run" buttons, in order
      const rows = page.locator("li"); // the six endpoint rows, in order
      const unlocked = async (i: number) =>
        !(await emulate.nth(i).isDisabled());
      const bodyOf = (i: number) =>
        rows.nth(i).locator("textarea").inputValue();
      // The "will send" preview: the body with its {{step.field}} references resolved against
      // captured responses — this carries the concrete chained values (the editor text never
      // changes, so hand edits can't be clobbered).
      const resolvedOf = async (i: number) =>
        (await rows.nth(i).locator(".resolved").textContent()) ?? "";
      const runStep = async (i: number) => {
        await emulate.nth(i).click();
        await rows.nth(i).locator(".dot.ok").waitFor({ timeout: 10000 }); // wait for its checkmark
      };

      // ── Inspect a step's request ─────────────────────────────────────────────
      // Click into a bullet (not the button) to expand it and reveal the generated curl request.
      await t.step("expand a step to see its curl request", async () => {
        await rows.nth(0).locator(".path").click();
        const curl = await rows.nth(0).locator(".curl").textContent();
        assert(
          curl?.includes("curl -X POST"),
          `curl request not rendered: ${curl}`,
        );
        assert(
          curl?.includes("/http/drive-to-store"),
          `curl missing the endpoint path: ${curl}`,
        );
      });

      // ── Step 1 — drive to store ──────────────────────────────────────────────
      // The first step needs no upstream data (it seeds `destination`), so it starts unlocked.
      await t.step("step 1 — drive to store", async () => {
        assertEquals(
          await unlocked(0),
          true,
          "step 1 (drive to store) should start unlocked",
        );
        assertEquals(
          await unlocked(1),
          false,
          "step 2 (grocery shop) should be locked until step 1 runs",
        );
        await runStep(0); // -> returns { storeId: "store-42" }
      });

      // ── Step 2 — grocery shop ────────────────────────────────────────────────
      // Unlocks once step 1 succeeds; its body references step 1's storeId, and the resolved
      // request carries the captured value.
      await t.step(
        "step 2 — grocery shop (storeId resolved from step 1)",
        async () => {
          assertEquals(
            await unlocked(1),
            true,
            "step 2 (grocery shop) should unlock after step 1",
          );
          assertEquals(
            await unlocked(2),
            false,
            "step 3 (checkout) should be locked until step 2 runs",
          );
          const body = await bodyOf(1);
          assert(
            body.includes("{{driveToStore.storeId}}"),
            `step 2 body should reference driveToStore.storeId: ${body}`,
          );
          const resolved = await resolvedOf(1);
          assert(
            resolved.includes("store-42"),
            `step 2 resolved request missing storeId "store-42": ${resolved}`,
          );
          await runStep(1); // -> returns { cartId: "cart-store-42" }
        },
      );

      // ── Step 3 — checkout ────────────────────────────────────────────────────
      // Unlocks once step 2 succeeds; resolves step 2's cartId into its request.
      await t.step(
        "step 3 — checkout (cartId resolved from step 2)",
        async () => {
          assertEquals(
            await unlocked(2),
            true,
            "step 3 (checkout) should unlock after step 2",
          );
          assertEquals(
            await unlocked(3),
            false,
            "step 4 (mix ingredients) should be locked until step 3 runs",
          );
          const resolved = await resolvedOf(2);
          assert(
            resolved.includes("cart-store-42"),
            `step 3 resolved request missing cartId "cart-store-42": ${resolved}`,
          );
          await runStep(2); // -> returns { ingredientsId: "ing-cart-store-42" }
        },
      );

      // ── Step 4 — mix ingredients ─────────────────────────────────────────────
      // Unlocks once step 3 succeeds; resolves step 3's ingredientsId into its request.
      await t.step(
        "step 4 — mix ingredients (ingredientsId resolved from step 3)",
        async () => {
          assertEquals(
            await unlocked(3),
            true,
            "step 4 (mix ingredients) should unlock after step 3",
          );
          assertEquals(
            await unlocked(4),
            false,
            "step 5 (bake) should be locked until step 4 runs",
          );
          const resolved = await resolvedOf(3);
          assert(
            resolved.includes("ing-cart-store-42"),
            `step 4 resolved request missing ingredientsId "ing-cart-store-42": ${resolved}`,
          );
          await runStep(3); // -> returns { batterId: "batter-ing-cart-store-42" }
        },
      );

      // ── Step 5 — bake ────────────────────────────────────────────────────────
      // Unlocks once step 4 succeeds; resolves step 4's batterId into its request.
      await t.step(
        "step 5 — bake (batterId resolved from step 4)",
        async () => {
          assertEquals(
            await unlocked(4),
            true,
            "step 5 (bake) should unlock after step 4",
          );
          assertEquals(
            await unlocked(5),
            false,
            "step 6 (cut) should be locked until step 5 runs",
          );
          const resolved = await resolvedOf(4);
          assert(
            resolved.includes("batter-ing-cart-store-42"),
            `step 5 resolved request missing batterId "batter-ing-cart-store-42": ${resolved}`,
          );
          await runStep(4); // -> returns { cakeId: "cake-batter-ing-cart-store-42" }
        },
      );

      // ── Step 6 — cut ─────────────────────────────────────────────────────────
      // The final step; unlocks once step 5 succeeds; resolves step 5's cakeId into its request.
      await t.step("step 6 — cut (cakeId resolved from step 5)", async () => {
        assertEquals(
          await unlocked(5),
          true,
          "step 6 (cut) should unlock after step 5",
        );
        const resolved = await resolvedOf(5);
        assert(
          resolved.includes("cake-batter-ing-cart-store-42"),
          `step 6 resolved request missing cakeId "cake-batter-ing-cart-store-42": ${resolved}`,
        );
        await runStep(5); // -> returns { sliceCount: 8 }
      });

      // ── All six steps green ──────────────────────────────────────────────────
      await t.step("all six steps show a checkmark", async () => {
        assertEquals(await page.locator("li .dot.ok").count(), CHAIN.length);
      });

      // ── "Run all in order" replays the whole chain from a fresh load ──────────
      await t.step("run all in order greens the whole chain", async () => {
        await page.reload();
        await page.locator("#runall").click();
        await page.waitForFunction(
          `document.querySelectorAll('li .dot.ok').length === ${CHAIN.length}`,
          { timeout: 10000 },
        );
      });

      // Hold the all-green state on screen briefly when watching headed.
      if (headed) await new Promise((r) => setTimeout(r, 2500));
    } finally {
      await browser.close();
      await api.stop();
    }
  },
});
