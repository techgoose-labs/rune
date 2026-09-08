import { assertEquals } from "#std/assert";
import { installerUrls, planUpdate } from "./mod.ts";

const COMPILED = {
  os: "darwin",
  execPath: "/Users/dev/.deno/bin/rune",
  env: {},
};

Deno.test("planUpdate — defaults: no tag, install over the running binary's dir", () => {
  const plan = planUpdate([], COMPILED);
  assertEquals(plan.error, undefined);
  assertEquals(plan.tag, undefined);
  assertEquals(plan.bindir, "/Users/dev/.deno/bin");
});

Deno.test("planUpdate — positional tag becomes RUNE_VERSION", () => {
  assertEquals(planUpdate(["v0.1.0"], COMPILED).tag, "v0.1.0");
});

Deno.test("planUpdate — explicit RUNE_INSTALL wins over the binary's dir", () => {
  const plan = planUpdate([], {
    ...COMPILED,
    env: { RUNE_INSTALL: "/opt/bin" },
  });
  assertEquals(plan.bindir, undefined);
});

Deno.test("planUpdate — dev (`deno run`) leaves the installer's default dir", () => {
  const plan = planUpdate([], { ...COMPILED, execPath: "/usr/local/bin/deno" });
  assertEquals(plan.bindir, undefined);
});

Deno.test("planUpdate — rejects unknown flags", () => {
  assertEquals(typeof planUpdate(["--dev"], COMPILED).error, "string");
});

Deno.test("planUpdate — rejects extra arguments", () => {
  assertEquals(typeof planUpdate(["v1", "v2"], COMPILED).error, "string");
});

Deno.test("planUpdate — rejects Windows", () => {
  assertEquals(
    typeof planUpdate([], { ...COMPILED, os: "windows" }).error,
    "string",
  );
});

Deno.test("installerUrls — the target release's asset first, raw main as fallback", () => {
  assertEquals(installerUrls("v0.1.0"), [
    "https://github.com/mrg-keystone/rune/releases/download/v0.1.0/install.sh",
    "https://raw.githubusercontent.com/mrg-keystone/rune/main/scripts/install.sh",
  ]);
});

Deno.test("installerUrls — no tag means the rolling `latest` release", () => {
  assertEquals(
    installerUrls()[0],
    "https://github.com/mrg-keystone/rune/releases/download/latest/install.sh",
  );
});
