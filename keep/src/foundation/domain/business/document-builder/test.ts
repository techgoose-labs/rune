import "#reflect-metadata";
import { assertEquals, assertStringIncludes } from "#assert";
import { DanetDocumentBuilder } from "./mod.ts";

class TestModule {}
Reflect.defineMetadata("module", {}, TestModule);

Deno.test("DanetDocumentBuilder - createSpec generates spec with defaults", () => {
  const builder = new DanetDocumentBuilder();
  const spec = builder.createSpec(TestModule);

  assertEquals(spec.value.info.title, "Test");
  assertEquals(spec.value.info.description, "Auto-generated docs");
  assertEquals(spec.value.info.version, "1.0");
  assertEquals(spec.module, TestModule);
});

Deno.test("DanetDocumentBuilder - createSpec uses custom description", () => {
  const builder = new DanetDocumentBuilder();
  const spec = builder.createSpec(TestModule, "Custom description");

  assertEquals(spec.value.info.description, "Custom description");
});

Deno.test("DanetDocumentBuilder - createSpec strips Module suffix from name", () => {
  class UsersModule {}
  Reflect.defineMetadata("module", {}, UsersModule);

  const builder = new DanetDocumentBuilder();
  const spec = builder.createSpec(UsersModule);

  assertEquals(spec.value.info.title, "Users");
});

Deno.test("DanetDocumentBuilder - createDocument returns doc and path", async () => {
  const builder = new DanetDocumentBuilder();
  const spec = builder.createSpec(TestModule);
  const result = await builder.createDocument(spec);

  assertEquals(result.path, "/test");
  assertEquals(result.doc.info.title, "Test");
  assertStringIncludes(result.doc.openapi, "3.0");
});

Deno.test("DanetDocumentBuilder - normalizePath adds leading slash", () => {
  const builder = new DanetDocumentBuilder();

  assertEquals(builder.normalizePath("/already"), "/already");
  assertEquals(builder.normalizePath("missing"), "/missing");
});
