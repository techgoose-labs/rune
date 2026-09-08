import { basename, join } from "#std/path";
import { specRootOf } from "@mrg-keystone/bedrock/artifact";

// ── shared dev-process registry (~/.rune/dev.json) ───────────────────────────
// ONE `rune dev` per git repo. The first run is the OWNER: it runs the watch loop + the app child
// and tees ALL of its output (its own `rune dev:` lines AND the app's stdout/stderr) to a rotating
// log folder, recording { pid, log-folder } under the repo name. Later runs in the SAME repo (or any
// subdir of it — the key is the git root) find the entry, see the pid is alive, and just ATTACH:
// they stream the newest log, no second watcher and no second app. If the owner died without cleanup
// (SIGKILL/crash) its pid is dead → the entry is stale → the next run reclaims it, first reaping the
// orphaned app child the dead owner left behind (its pid is recorded in <log-folder>/child.pid — rune
// has no deterministic port to kill by, unlike sprig, so the child pid IS the handle) and then owns.
//
// Net effect: at most one watcher+app per repo, guaranteed by the lock; a dead pid can never
// masquerade as alive (`ps -p` fails), and reclaim reaps the orphan by its recorded pid.

export const MAX_LOG_LINES = 2000; // per file, then roll to a fresh timestamped one
export const MAX_LOG_FILES = 20; // keep this many rotated files per repo; oldest pruned

export interface DevLockEntry {
  pid: number;
  "log-folder": string;
}

/** Global rune state dir (~/.rune), overridable via RUNE_HOME. NOT the project or the install root. */
export function runeStateRoot(): string {
  return Deno.env.get("RUNE_HOME") ??
    join(Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".", ".rune");
}
export function devLockPath(): string {
  return join(runeStateRoot(), "dev.json");
}

/** Nearest `.git` ancestor of `startAbs` (a clone has a `.git` dir, a worktree a
 *  `.git` file — existence, not type), or null outside any repo.
 *
 *  The walk itself is the artifact format's ONE implementation (D-9): this file
 *  used to carry a copy, and a copy that drifts keys the dev registry to a
 *  different repo than the one `spec/` resolves under. `specRootOf` returns the
 *  start unchanged when there is no `.git` ancestor, which is the "outside a
 *  repo" case this signature reports as null. */
export function gitRepoRoot(startAbs: string): string | null {
  const root = specRootOf(startAbs);
  if (root !== startAbs) return root;
  // The walk returned the start: either the start IS the repo root, or there is
  // no repo at all. One lstat tells them apart.
  try {
    Deno.lstatSync(join(startAbs, ".git"));
    return startAbs;
  } catch {
    return null;
  }
}

/** The registry key: the git repo's folder name (or the target's, outside a repo), sanitized. */
export function repoKey(target: string): string {
  const root = gitRepoRoot(target) ?? target;
  return basename(root).replace(/[^A-Za-z0-9._-]+/g, "-") || "app";
}

export async function readDevLock(): Promise<Record<string, DevLockEntry>> {
  try {
    return (JSON.parse(await Deno.readTextFile(devLockPath())) as Record<
      string,
      DevLockEntry
    >) ?? {};
  } catch {
    return {};
  }
}
export async function writeDevLock(
  map: Record<string, DevLockEntry>,
): Promise<void> {
  await Deno.mkdir(runeStateRoot(), { recursive: true });
  const tmp = `${devLockPath()}.${Deno.pid}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(map, null, 2));
  await Deno.rename(tmp, devLockPath()); // atomic swap so a concurrent read never sees a half-write
}

/** Is `pid` a live process? `ps -p` — no signal side-effects (unlike a probe kill). A reused PID
 *  reads as "a process", which is fine: reclaim ALSO reaps the recorded app child by its own pid. */
export async function pidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const { success } = await new Deno.Command("ps", {
      args: ["-p", String(pid)],
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  } catch {
    return false;
  }
}

// The app child's pid, recorded in the owner's log folder (a local write — no churn on the shared
// map) so a reclaiming run can reap the orphan a dead owner left. Best-effort throughout.
function childPidPath(logFolder: string): string {
  return join(logFolder, "child.pid");
}
export async function writeChildPid(
  logFolder: string,
  pid: number,
): Promise<void> {
  try {
    await Deno.writeTextFile(childPidPath(logFolder), String(pid));
  } catch { /* best effort */ }
}
export async function readChildPid(logFolder: string): Promise<number | null> {
  try {
    const n = Number((await Deno.readTextFile(childPidPath(logFolder))).trim());
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}
/** Reap the orphaned app child a dead owner left behind, if its recorded pid is still alive. */
export async function reapOrphanChild(logFolder: string): Promise<void> {
  const pid = await readChildPid(logFolder);
  if (pid && (await pidAlive(pid))) {
    try {
      Deno.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  }
  try {
    await Deno.remove(childPidPath(logFolder));
  } catch { /* best effort */ }
}

/** Tee the owner's output to the terminal AND to a rotating log folder:
 *  <folder>/<ISO-timestamp>.log, MAX_LOG_LINES per file then roll, keep at most MAX_LOG_FILES. */
export class DevLog {
  #folder: string;
  #maxFiles: number;
  #file: Deno.FsFile | null = null;
  #lines = 0;
  #chain: Promise<void> = Promise.resolve(); // serialize the interleaved pumps
  constructor(folder: string, maxFiles: number) {
    this.#folder = folder;
    this.#maxFiles = maxFiles;
  }
  async #roll(): Promise<void> {
    try {
      this.#file?.close();
    } catch { /* */ }
    const name = new Date().toISOString().replace(/[:.]/g, "-") + ".log";
    this.#file = await Deno.open(join(this.#folder, name), {
      create: true,
      append: true,
    });
    this.#lines = 0;
    const files: string[] = [];
    for await (const e of Deno.readDir(this.#folder)) {
      if (e.isFile && e.name.endsWith(".log")) files.push(e.name);
    }
    files.sort(); // timestamp names sort chronologically
    for (
      const old of files.slice(0, Math.max(0, files.length - this.#maxFiles))
    ) {
      await Deno.remove(join(this.#folder, old)).catch(() => {});
    }
  }
  write(chunk: Uint8Array): Promise<void> {
    return (this.#chain = this.#chain.then(() => this.#doWrite(chunk)));
  }
  async #doWrite(chunk: Uint8Array): Promise<void> {
    await Deno.stdout.write(chunk); // tee to the owner's terminal
    if (!this.#file) await this.#roll();
    await this.#file!.write(chunk);
    for (const b of chunk) if (b === 10) this.#lines++;
    if (this.#lines >= MAX_LOG_LINES) await this.#roll();
  }
  close(): void {
    try {
      this.#file?.close();
    } catch { /* */ }
  }
}

/** ATTACH to a running shared dev process: print a header, then live-tail its NEWEST log file
 *  (following rotation to the next file). Ctrl-C just detaches — the shared process keeps running. */
export async function attachShared(
  repo: string,
  e: DevLockEntry,
): Promise<void> {
  const folder = e["log-folder"];
  console.log(
    `\x1b[35m\x1b[1m⟶ rune dev — a shared process for "${repo}" is already running (pid ${e.pid}).\x1b[0m\n` +
      `  Streaming its live log; saves hot-reload the app there. Ctrl-C detaches (it keeps running).\n` +
      `  older logs: ${folder}\n`,
  );
  const newest = async (): Promise<string> => {
    let best = "";
    try {
      for await (const f of Deno.readDir(folder)) {
        if (f.isFile && f.name.endsWith(".log") && f.name > best) best = f.name;
      }
    } catch { /* folder gone */ }
    return best ? join(folder, best) : "";
  };
  let detached = false;
  const stop = () => {
    detached = true;
  };
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  let cur = "";
  let pos = 0;
  while (!detached) {
    const latest = await newest();
    if (latest && latest !== cur) {
      cur = latest;
      pos = 0;
    } // first file, or rotated → follow the new one
    if (cur) {
      try {
        const st = await Deno.stat(cur);
        if (st.size < pos) pos = 0; // truncated/replaced
        if (st.size > pos) {
          const f = await Deno.open(cur, { read: true });
          try {
            await f.seek(pos, Deno.SeekMode.Start);
            const buf = new Uint8Array(st.size - pos);
            const n = (await f.read(buf)) ?? 0;
            if (n > 0) await Deno.stdout.write(buf.subarray(0, n));
            pos += n;
          } finally {
            f.close();
          }
        }
      } catch { /* file vanished mid-rotate → re-detect next tick */ }
    }
    if (!(await pidAlive(e.pid))) {
      console.log(
        `\n\x1b[31m⟶ the shared process (pid ${e.pid}) exited — run \`rune dev\` again to start a fresh one.\x1b[0m`,
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  Deno.removeSignalListener("SIGINT", stop);
  Deno.removeSignalListener("SIGTERM", stop);
}
