import { join, relative } from "#std/path";

export async function getIgnoredPaths(gitRoot: string): Promise<Set<string>> {
  const cmd = new Deno.Command("git", {
    args: [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
    ],
    cwd: gitRoot,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  if (code !== 0) return new Set();
  const output = new TextDecoder().decode(stdout).trim();
  if (!output) return new Set();
  return new Set(
    output.split("\n").map((p) => p.replace(/\/$/, "")),
  );
}

export async function findGitRoot(): Promise<string> {
  const cmd = new Deno.Command("git", {
    args: ["rev-parse", "--show-toplevel"],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    const err = new TextDecoder().decode(stderr).trim();
    throw new Error(`Not inside a git repository: ${err}`);
  }
  return new TextDecoder().decode(stdout).trim();
}

export async function readWorkspaceMembers(
  gitRoot: string,
): Promise<string[] | null> {
  const denoJsonPath = join(gitRoot, "deno.json");
  let text: string;
  try {
    text = await Deno.readTextFile(denoJsonPath);
  } catch {
    return null;
  }
  const config = JSON.parse(text);
  if (!Array.isArray(config.workspace)) return null;
  return config.workspace as string[];
}
