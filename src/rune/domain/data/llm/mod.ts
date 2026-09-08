/**
 * Claude CLI adapter — calls claude directly via Deno.Command,
 * bypassing the Agent SDK subprocess issue in deno-compiled binaries.
 */

Deno.env.delete("CLAUDECODE");
Deno.env.delete("CLAUDE_CODE_ENTRYPOINT");

export interface QueryOptions {
  systemPrompt?: string;
  model?: string;
}

export async function quickQuery(
  prompt: string,
  opts: QueryOptions = {},
): Promise<string> {
  const args = ["-p", prompt, "--allowedTools", ""];
  if (opts.model) args.push("--model", opts.model);
  if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);

  const cmd = new Deno.Command("claude", {
    args,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  });

  const { code, stdout, stderr } = await cmd.output();

  if (code !== 0) {
    const err = new TextDecoder().decode(stderr);
    throw new Error(`claude exited with code ${code}: ${err}`);
  }

  return new TextDecoder().decode(stdout).trim();
}
