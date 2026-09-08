import { assertEquals } from "#std/assert";
import type { BuildPromptFn, CheckFn } from "./mod.ts";

Deno.test("CheckFn type contract is valid", () => {
  const _check: CheckFn = async (_path, _target, _ctx) => null;
  assertEquals(typeof _check, "function");
});

Deno.test("BuildPromptFn type contract is valid", () => {
  const _build: BuildPromptFn = (_violations, _path, _target) => "";
  assertEquals(typeof _build, "function");
});
