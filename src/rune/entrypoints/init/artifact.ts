// rune's slice of the shared `spec/` ARTIFACT.
//
// The artifact's MECHANICS — the skeleton, the manifest, the version
// handshake, the vendored conformance vectors — used to live here, byte-
// identical to sprig's copy of the same file, with the spec-root walk copied
// seven more times across the two repos. They are one implementation now
// (`@techgoose-labs/bedrock/artifact`, D-9), and conformance is "run the vectors
// against the imported implementation in your own CI".
//
// What stays is the only part that is genuinely rune's: WHICH subtrees rune
// produces, and their durability classes.

import type { ManifestEntry } from "@techgoose-labs/bedrock/artifact";

export {
  ARTIFACT_FORMAT_VERSION,
  checkArtifactVersion,
  ensureSpecSkeleton,
  readManifest,
  registerManifestEntries,
  SUPPORTED_FORMAT_MAJOR,
} from "@techgoose-labs/bedrock/artifact";
export type {
  ManifestEntry,
  SpecManifest,
} from "@techgoose-labs/bedrock/artifact";

export const RUNE_MANIFEST_ENTRIES: Record<string, ManifestEntry> = {
  "product/": {
    class: "durable",
    owner: "product",
    producer: "scoping toolchain",
  },
  "runes/": {
    class: "durable",
    owner: "backend",
    producer: "backend toolchain",
  },
  "misc/layout.md": {
    class: "derived",
    owner: "none",
    producer: "backend toolchain",
  },
  "misc/data.json": {
    class: "merge",
    owner: "backend",
    producer: "backend toolchain",
  },
  "misc/heal-rules.json": {
    class: "merge",
    owner: "backend",
    producer: "backend toolchain",
  },
  "misc/cake.json": {
    class: "durable",
    owner: "backend",
    producer: "backend toolchain",
  },
  "misc/scenarios/": {
    class: "durable",
    owner: "backend",
    producer: "backend toolchain",
  },
  "contract/openapi.json": {
    class: "derived",
    owner: "none",
    producer: "backend toolchain",
  },
};
