// End-to-end acceptance for the BRANCHING rune -> keep flow, exercised through the checkout
// module (rune-generated from src/checkout/checkout.rune). Where cake proves the linear chain,
// checkout proves the three constructs added for non-linear processes:
//   [ENT:card]/[ENT:cash]  -> flows (XOR branches walked one at a time)
//   producers in 2 flows   -> the OR-join (dependsOn both, bind alternatives)
//   [TYP:ext] memberId     -> a $memberId external-input bind (module inputs / seeds)
//   [ENT:optional]         -> an attempted-but-not-required step
// Run from the keep root: `deno task test:e2e:checkout` (in-process), or with
// KEEP_BROWSER=1 to add the interactive-emulator browser stage.
import "reflect-metadata";
import { assert, assertEquals, assertExists } from "#assert";
import { bootstrapServer, exerciseEndpoints } from "@mrg-keystone/rune";
import { httpModule } from "@/src/checkout/entrypoints/http/mod.ts";
import { membersModule } from "@/src/members/entrypoints/http/mod.ts";

let port = 8795;

// Stage 1 — the generated metadata: flows, the OR-join, $external input, optional.
Deno.test("checkout e2e — x-keep-process carries flows, OR-bind, $input, optional", async () => {
  const api = await bootstrapServer("checkout", httpModule, { port: port++ });
  try {
    const doc = api.docs[0].doc;
    const proc = (path: string) => doc.paths![path].post!["x-keep-process"]!;

    // The external input from [TYP:ext].
    assertEquals(proc("/http/start").bind, { memberId: "$memberId" });

    // The branches from [ENT:card]/[ENT:cash].
    assertEquals(proc("/http/pay-card").flows, ["card"]);
    assertEquals(proc("/http/pay-cash").flows, ["cash"]);

    // The join: depends on both alternatives, binds them first-resolvable-wins.
    const fulfill = proc("/http/fulfill");
    assertEquals(fulfill.dependsOn, ["payCard", "payCash"]);
    assertEquals(fulfill.bind, {
      paymentId: ["payCard.paymentId", "payCash.paymentId"],
    });

    // The optional step from [ENT:optional].
    assertEquals(proc("/http/survey").optional, true);
    assertExists(doc.components?.schemas?.PaymentDto);
  } finally {
    await api.stop();
  }
});

// Stage 2 — the headless runner walks each branch green, seeded with the external input.
Deno.test("checkout e2e — exerciseEndpoints drives each flow green", async () => {
  const api = await bootstrapServer("checkout", httpModule, { port: port++ });
  try {
    const card = await exerciseEndpoints({
      api,
      flow: "card",
      overrides: { seeds: { memberId: "m-7" } },
    });
    assertEquals(card.failed.map((r) => r.id), []);
    assertEquals(card.optionalFailed, []);
    assert(
      !card.order.includes("payCash"),
      "cash branch must not run in the card flow",
    );
    assertEquals(
      card.passed.map((r) => r.id).sort(),
      ["fulfill", "payCard", "start", "survey"],
    );

    const cash = await exerciseEndpoints({
      api,
      flow: "cash",
      overrides: { seeds: { memberId: "m-7" } },
    });
    assertEquals(cash.failed.map((r) => r.id), []);
    assert(
      !cash.order.includes("payCard"),
      "card branch must not run in the cash flow",
    );
  } finally {
    await api.stop();
  }
});

// Stage 3 — without the seed, the external input is missing and start fails (proving the
// $bind is a real requirement, not decoration).
Deno.test("checkout e2e — the unseeded $memberId input fails start", async () => {
  const api = await bootstrapServer("checkout", httpModule, { port: port++ });
  try {
    const report = await exerciseEndpoints({
      api,
      flow: "card",
      maxIterations: 1,
    });
    assert(
      report.failed.map((r) => r.id).includes("start"),
      "start must fail without the external memberId",
    );
  } finally {
    await api.stop();
  }
});

// Stage 4 — the interactive emulator: module-inputs card, flow selector, branch walk,
// OR-join resolution. Opt-in browser stage.
Deno.test({
  name:
    "checkout e2e — emulator: set the $input, pick a flow, walk the branch green",
  ignore: Deno.env.get("KEEP_BROWSER") !== "1",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const p = port++;
    const api = await bootstrapServer("checkout", httpModule, { port: p });
    await api.listen();
    const { chromium } = await import("#playwright");
    const headed = Deno.env.get("KEEP_HEADED") === "1";
    const browser = await chromium.launch({
      headless: !headed,
      slowMo: headed ? 500 : 0,
    });
    try {
      const page = await browser.newPage();
      await page.goto(`http://localhost:${p}/api/docs/checkout`);

      // The module declares its external input; the run is blocked until it's set.
      assertEquals(await page.locator("#inputs-card").isVisible(), true);
      await page.locator('#inputs input[data-gvar="memberId"]').fill("m-7");

      // Pick the card flow: the cash branch hides, four steps remain.
      await page.locator('#flows button[data-flow="card"]').click();
      await page.waitForFunction(
        "document.querySelectorAll('li:not(.offflow)').length === 4",
        { timeout: 5000 },
      );

      // Walk the branch.
      await page.locator("#runall").click();
      await page.waitForFunction(
        "document.querySelectorAll('li:not(.offflow) .dot.ok').length === 4",
        { timeout: 10000 },
      );
      const banner = await page.locator("#banner").textContent();
      assert(
        banner?.includes("All 4 required steps passed"),
        `unexpected banner: ${banner}`,
      );

      // The join resolved the card alternative, fed by the external input end to end.
      const resolved = await page.locator('li[data-id="fulfill"] .resolved')
        .textContent();
      assert(
        resolved?.includes("pay-ticket-m-7"),
        `fulfill should carry the card payment id: ${resolved}`,
      );
    } finally {
      await browser.close();
      await api.stop();
    }
  },
});

// Stage 5 — the contract lifecycle: composed with a members module that PRODUCES memberId,
// the $memberId external input is satisfied with no seeds at all — the contract snaps
// together by field name, and the synthetic edge orders the producer before the consumer.
Deno.test("checkout e2e — composed members module satisfies $memberId with zero seeds", async () => {
  const api = await bootstrapServer("checkout", [membersModule, httpModule], {
    port: port++,
  });
  try {
    const report = await exerciseEndpoints({ api, flow: "card" });
    assertEquals(report.failed.map((r) => r.id), []);
    assertEquals(
      report.passed.map((r) => r.id).sort(),
      ["create", "fulfill", "payCard", "start", "survey"],
    );
    assert(
      report.order.indexOf("create") < report.order.indexOf("start"),
      `the producer must be ordered before the consumer: ${
        report.order.join(" -> ")
      }`,
    );
  } finally {
    await api.stop();
  }
});

// Stage 6 — the emulator side of the same lifecycle: the composed producer shows the `auto:`
// affordance on checkout's module-inputs card, its capture propagates cross-page through the
// shared scope, and the card flow walks green without typing anything. Opt-in browser stage.
Deno.test({
  name:
    "checkout e2e — emulator: composed producer auto-satisfies $memberId, no typing",
  ignore: Deno.env.get("KEEP_BROWSER") !== "1",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const p = port++;
    const api = await bootstrapServer("checkout", [membersModule, httpModule], {
      port: p,
    });
    await api.listen();
    const { chromium } = await import("#playwright");
    const headed = Deno.env.get("KEEP_HEADED") === "1";
    const browser = await chromium.launch({
      headless: !headed,
      slowMo: headed ? 500 : 0,
    });
    try {
      const page = await browser.newPage();

      // The module-inputs row is satisfied by the composed producer: dim `auto:` note, no
      // amber unset treatment — before anything has run or been typed.
      await page.goto(`http://localhost:${p}/api/docs/checkout`);
      assertEquals(await page.locator("#inputs-card").isVisible(), true);
      const inputsText = await page.locator("#inputs").textContent();
      assert(
        inputsText?.includes("auto"),
        `module inputs should show the auto affordance: ${inputsText}`,
      );
      assertEquals(await page.locator("#inputs .var-name.unset").count(), 0);

      // Run the producer on its own page — the capture lands in the shared scope.
      await page.goto(`http://localhost:${p}/api/docs/members`);
      await page.locator('li[data-id="create"] button.emulate').click();
      await page.locator('li[data-id="create"] .dot.ok').waitFor({
        timeout: 10000,
      });

      // Back on checkout: start's preview resolves from the cross-module capture.
      await page.goto(`http://localhost:${p}/api/docs/checkout`);
      await page.waitForFunction(
        "(document.querySelector('li[data-id=\"start\"] .resolved')?.textContent || '').includes('member-')",
        { timeout: 5000 },
      );

      // Pick the card flow and walk the branch green — no typing anywhere.
      await page.locator('#flows button[data-flow="card"]').click();
      await page.waitForFunction(
        "document.querySelectorAll('li:not(.offflow)').length === 4",
        { timeout: 5000 },
      );
      await page.locator("#runall").click();
      await page.waitForFunction(
        "document.querySelectorAll('li:not(.offflow) .dot.ok').length === 4",
        { timeout: 10000 },
      );
      const banner = await page.locator("#banner").textContent();
      assert(
        banner?.includes("All 4 required steps passed"),
        `unexpected banner: ${banner}`,
      );

      // End to end: the produced memberId flowed into the ticket, then the payment.
      const resolved = await page.locator('li[data-id="fulfill"] .resolved')
        .textContent();
      assert(
        resolved?.includes("pay-ticket-member-"),
        `fulfill should carry the produced member id: ${resolved}`,
      );
    } finally {
      await browser.close();
      await api.stop();
    }
  },
});
