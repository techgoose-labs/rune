import {
  RUNE_BUILT_AT,
  RUNE_COMMIT,
  RUNE_VERSION,
} from "@core/dto/version.gen.ts";

const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const REPO = "mrg-keystone/rune";

// `rune -v` (aliases: --version, -V, version) — report this build's version and
// check whether a newer rune has been released.
//
// rune ships as a ROLLING `latest` GitHub release (the binary carries no semver
// tag of its own), so "am I stale?" can't be answered by comparing semvers — a
// keep-only auto-bump would false-nag. The honest signal is the COMMIT: the
// binary bakes the commit it was built from (RUNE_COMMIT, see gen-version.ts).
//
// Crucially, the comparison target is NOT the git `latest` tag: gh-release
// freezes that tag (and the release's published_at) and only swaps the ASSETS
// in place, so the tag ref lags the served binary by weeks. Instead the CI run
// that builds the binaries also uploads its commit as a sibling release asset,
// `commit.txt`. Reading that asset compares the running binary against the
// commit of the binary you'd actually download — same release, no lag, and (as
// a plain asset download, like install.sh) not subject to the API rate limit.

export function latestCommitUrl(tag = "latest"): string {
  return `https://github.com/${REPO}/releases/download/${tag}/commit.txt`;
}

// The rune LIBRARY on JSR, which versions independently of this binary.
//
// The CLI ships as a rolling GitHub release; the library ships to JSR from
// `keep/deno.json`. Nothing binds the two, and they have already diverged once:
// rune 7.0.0 was published to JSR while the `latest` release stayed on the 6.x
// commit, so every installed CLI reported itself UP TO DATE while being unable
// to parse a 7.x spec at all (`[REQ] does not take a modifier` on `[REQ:open]`).
//
// The commit check cannot see that — the binary genuinely IS the latest RELEASE.
// So compare majors against JSR too: a newer major there means this CLI cannot
// read specs written for the library the app is pinned to, and — this is the
// part worth saying out loud — `rune update` will NOT fix it, because there is
// no release to update to yet.
export const LIBRARY_META_URL = "https://jsr.io/@techgoose-labs/rune/meta.json";

/** The major of a semver string, or undefined when it is not one. */
export function majorOf(version: string | undefined): number | undefined {
  if (!version) return undefined;
  const m = /^(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : undefined;
}

// Pure: is the published LIBRARY a whole major ahead of this binary? Unknown
// data on either side => false, same rule as `isNewer` — never cry wolf.
export function isMajorBehind(
  baked: string | undefined,
  library: string | undefined,
): boolean {
  const a = majorOf(baked);
  const b = majorOf(library);
  if (a === undefined || b === undefined) return false;
  return b > a;
}

/** The library's latest published version, or undefined on any failure. */
export async function fetchLibraryVersion(): Promise<string | undefined> {
  try {
    const res = await fetch(LIBRARY_META_URL);
    if (!res.ok) return undefined;
    const doc = await res.json() as { latest?: string };
    return doc.latest || undefined;
  } catch {
    return undefined;
  }
}

// Pure: given the baked commit and the latest release's commit, decide if a
// newer build is available. Unknown/missing data => no nag (never cry wolf): a
// dev build (RUNE_COMMIT "unknown"), an unreachable network, or a release that
// predates commit.txt (404 => undefined) all fall through to false.
export function isNewer(
  baked: string | undefined,
  latest: string | undefined,
): boolean {
  if (!baked || baked === "unknown") return false;
  if (!latest) return false;
  return baked !== latest;
}

// Fetch the commit the `latest` release was built from, from its own
// `commit.txt` asset. Returns undefined on any failure (offline, 404 on
// pre-commit.txt releases, etc.) — `rune -v` stays useful offline and simply
// skips the update check rather than nagging on bad data.
export async function fetchLatestCommit(): Promise<string | undefined> {
  try {
    const res = await fetch(latestCommitUrl());
    if (!res.ok) return undefined;
    const sha = (await res.text()).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

// Render a UTC ISO instant as Eastern wall-clock time. America/New_York applies the
// EST↔EDT switch itself, so the zone label (EST in winter, EDT in summer) is honest
// year-round. Returns null for a missing/unparseable stamp so `rune -v` omits the line.
export function formatEastern(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(ms);
}

export async function runVersion(_args: string[]): Promise<number> {
  const short = RUNE_COMMIT === "unknown" ? "dev" : RUNE_COMMIT.slice(0, 7);
  // A released binary's build time IS the release time (CI stamps it at release); a
  // local dev build (commit "unknown") shows its own build time. Eastern, per request.
  const built = formatEastern(RUNE_BUILT_AT);
  const verb = RUNE_COMMIT === "unknown" ? "built" : "released";
  const when = built ? ` ${DIM}· ${verb} ${built}${RESET}` : "";
  console.log(`rune ${RUNE_VERSION} ${DIM}(${short})${RESET}${when}`);

  const [latest, library] = await Promise.all([
    fetchLatestCommit(),
    fetchLibraryVersion(),
  ]);

  // A whole major behind the library is the more serious of the two, and it is
  // reported even when the binary is the newest RELEASE — because that is
  // exactly the case that used to look healthy.
  if (isMajorBehind(RUNE_VERSION, library)) {
    console.log(
      `${YELLOW}${BOLD}this CLI is a major behind the rune library${RESET}` +
        `${YELLOW} — CLI ${RUNE_VERSION}, library ${library} on JSR.${RESET}`,
    );
    console.log(
      `${YELLOW}  It cannot read specs written for ${library} ` +
        `(a ${majorOf(library)}.x marker reads as a syntax error).${RESET}`,
    );
    if (!isNewer(RUNE_COMMIT, latest)) {
      // The honest part: updating will not help, so do not send anyone in a circle.
      console.log(
        `${YELLOW}  \`rune update\` will NOT fix this: the ${majorOf(library)}.x CLI ` +
          `has not been released yet.${RESET}`,
      );
    }
  }

  if (isNewer(RUNE_COMMIT, latest)) {
    console.log(
      `${YELLOW}${BOLD}there is a new version of rune${RESET}${YELLOW} — run \`rune update\`${RESET}`,
    );
  }
  return 0;
}
