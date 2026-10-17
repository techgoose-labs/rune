// REQ-041 — the tracked managed hooks are branch-model's current copies: they
// name the /wt:new → /wt:merge flow and fall back main → master for the deploy
// lane (REQ-139), as the tool that generates them does.
import { assert, assertEquals } from "#std/assert";
import { ROOT } from "./lane.ts";

const HOOKS = [".githooks/pre-commit", ".githooks/pre-merge-commit"];

const read = (p: string) => Deno.readTextFileSync(`${ROOT}/${p}`);

Deno.test("REQ-041: the hooks name the wt:new / wt:merge flow, never the retired /worktree commands", () => {
  for (const h of HOOKS) {
    const text = read(h);
    assert(text.includes("/wt:merge"), `${h} names /wt:merge`);
    assertEquals(text.match(/\/worktree(-merge)?\b/g), null, `${h} names no retired /worktree command`);
  }
  assert(read(HOOKS[0]).includes("/wt:new"), "pre-commit tells the user to start with /wt:new");
});

Deno.test("REQ-041: the deploy lane falls back main → master when branch-model.deploy-branch is unset", () => {
  for (const h of HOOKS) {
    const text = read(h);
    assert(text.includes("refs/heads/main"), `${h} probes main`);
    assert(text.includes("refs/heads/master") && text.includes("deploy=master"), `${h} falls back to master`);
  }
});
