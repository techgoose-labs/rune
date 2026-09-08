import { assertEquals, assertStringIncludes } from "#assert";
import { Hono } from "#hono";
import {
  createDocsJsonHandler,
  injectDocsScript,
  swaggerShellHtml,
} from "./mod.ts";

Deno.test("no token plumbing survives: the docs pages carry no credential machinery", () => {
  // Access to `/api/docs/*` is a policy row keep's unit declares and bedrock
  // resolves (D-11). There is nothing left for a page to stash, seed from a
  // `?token=`, or attach — and nothing an attacker can read out of a
  // localStorage key that no longer exists.
  const pages = [
    swaggerShellHtml("API · users"),
    injectDocsScript("<html><body><h1>Docs</h1></body></html>"),
  ];
  for (const html of pages) {
    assertEquals(html.includes("danet_docs_token"), false);
    assertEquals(html.includes("localStorage"), false);
    assertEquals(html.includes("__danetDocs"), false);
    assertEquals(html.includes('searchParams.get("token")'), false);
  }
});

Deno.test("injectDocsScript leaves the page exactly as it was", () => {
  const html = "<html><body><h1>Docs</h1></body></html>";
  assertEquals(injectDocsScript(html), html);
  assertEquals(
    injectDocsScript("<h1>no body tag</h1>"),
    "<h1>no body tag</h1>",
  );
});

const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "t", version: "1" },
});

function jsonApp() {
  const app = new Hono();
  app.get("/docs/app/json", createDocsJsonHandler({ specJson: SPEC }));
  const at = (init?: RequestInit, query = "") =>
    app.fetch(new Request(`http://app/docs/app/json${query}`, init));
  return { at };
}

Deno.test("docs json: the handler serves the spec; the gate is the policy row above it", async () => {
  const res = await jsonApp().at();
  assertEquals(res.status, 200);
  assertEquals((await res.json()).openapi, "3.0.0");
});

Deno.test("docs json: a stray legacy ?token is harmless", async () => {
  const res = await jsonApp().at(undefined, "?token=stale-legacy-token");
  assertEquals(res.status, 200);
  assertEquals((await res.json()).openapi, "3.0.0");
});

Deno.test("swaggerShellHtml builds a page that loads the spec same-origin", () => {
  const html = swaggerShellHtml("API · users");
  assertStringIncludes(html, "<html");
  assertStringIncludes(html, "swagger-ui");
  // fetches <currentPath>/json
  assertStringIncludes(html, '"/json"');
  // title is escaped/rendered
  assertStringIncludes(html, "API · users");
});
