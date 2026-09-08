import { assertEquals } from "#std/assert";
import {
  classifyFile,
  getLayerFromPath,
  getModuleFromPath,
  isModRootImport,
} from "./mod.ts";

Deno.test("classifyFile — bootstrap file", () => {
  const result = classifyFile("src/bootstrap/mod.ts");
  assertEquals(result.module, "bootstrap");
  assertEquals(result.layer, "bootstrap");
  assertEquals(result.isBootstrap, true);
});

Deno.test("classifyFile — business layer file", () => {
  const result = classifyFile("src/orders/domain/business/validate/mod.ts");
  assertEquals(result.module, "orders");
  assertEquals(result.layer, "business");
});

Deno.test("classifyFile — non-src file", () => {
  const result = classifyFile("fixtures/data.json");
  assertEquals(result.module, null);
  assertEquals(result.layer, "unknown");
});

Deno.test("getModuleFromPath", () => {
  assertEquals(
    getModuleFromPath("src/orders/domain/business/foo/mod.ts"),
    "orders",
  );
  assertEquals(getModuleFromPath("fixtures/data.json"), null);
});

Deno.test("getLayerFromPath", () => {
  assertEquals(
    getLayerFromPath("src/orders/domain/business/foo/mod.ts"),
    "business",
  );
  assertEquals(getLayerFromPath("src/orders/mod-root.ts"), "unknown");
});

Deno.test("isModRootImport", () => {
  assertEquals(isModRootImport("src/orders/mod-root.ts"), true);
  assertEquals(isModRootImport("src/orders/domain/business/foo/mod.ts"), false);
});
