// The artifact format's conformance gate, run in rune's CI (D-9).
//
// Both halves are exercised here, against the ONE implementation rune now
// imports rather than its own copy: the canonicalize-and-hash vectors that pin
// the `x-spec-hash` stamp, and the spec-root walk vectors that pin where
// `spec/` resolves to. The walk had SEVEN copies across rune and sprig before
// this; a copy that drifts splits a monorepo's halves onto two different
// `spec/` dirs, so "does rune agree with the format?" is now a test, not a
// promise.

import { assertEquals } from "#std/assert";
import { join } from "#std/path";
import {
  canonicalize,
  sha256Hex,
  specRoot,
  vendoredVector,
} from "@mrg-keystone/bedrock/artifact";

interface SingleFileVector {
  name: string;
  contents: Record<string, unknown>;
  expected: string;
}

const hashDoc = JSON.parse(await vendoredVector("hash-vectors.json")) as {
  singleFile: SingleFileVector[];
};

for (const v of hashDoc.singleFile) {
  Deno.test(`hash vectors (single-file): ${v.name}`, async () => {
    const { ["x-spec-hash"]: _omit, ...rest } = v.contents;
    assertEquals(await sha256Hex(canonicalize(rest)), v.expected);
  });
}

interface RootVector {
  name: string;
  pins: string;
  tree: { path: string; kind: string; target?: string }[];
  start: string;
  expected: string;
}

const rootDoc = JSON.parse(await vendoredVector("spec-root-vectors.json")) as {
  vectors: RootVector[];
};

Deno.test("spec-root vectors: rune's resolution matches the artifact format", async () => {
  for (const v of rootDoc.vectors) {
    const root = await Deno.realPath(
      await Deno.makeTempDir({ prefix: "rune-vectors-" }),
    );
    try {
      for (const entry of v.tree) {
        const full = join(root, entry.path);
        if (entry.kind === "dir" || entry.kind === "git-dir") {
          await Deno.mkdir(full, { recursive: true });
        } else if (entry.kind === "git-file") {
          await Deno.mkdir(join(full, ".."), { recursive: true });
          await Deno.writeTextFile(full, "gitdir: ../.git/worktrees/x\n");
        } else if (entry.kind === "symlink") {
          await Deno.mkdir(join(full, ".."), { recursive: true });
          await Deno.symlink(join(root, entry.target!), full).catch(() => {});
        }
      }
      const start = v.start === "" ? root : join(root, v.start);
      assertEquals(
        specRoot(start).slice(root.length + 1) || "spec/",
        v.expected,
        `${v.name} — ${v.pins}`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});
