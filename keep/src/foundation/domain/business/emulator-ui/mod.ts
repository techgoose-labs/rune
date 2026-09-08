/**
 * The per-module **process emulator** page. For one rune-module's OpenAPI doc (with
 * `x-keep-process`) it renders endpoints as an ordered process walk: each step shows its request
 * (a body editor whose bound fields hold `{{step.field}}` references, resolved at send time
 * against captured responses — so hand edits are never overwritten), a live "will send" preview,
 * a paste-ready curl, and the response with status + timing. Success captures the step's outputs
 * into a visible variables panel and unlocks dependent steps; **Run all in order** walks the
 * chain and stops with an explanatory banner on the first failure. The session (statuses,
 * captured outputs, variables, edited bodies) persists in localStorage across reloads.
 *
 * Standard Swagger UI lives at `<page>/swagger` and the raw spec at `<page>/json` for deeper
 * inspection. The spec is inlined into the page (no gated fetch needed to render); live endpoint
 * calls reuse the docs `?token=`→localStorage bearer flow, and resolve the app root from the page
 * path so it works standalone (`/docs/<m>`) or mounted under a host (`/api/docs/<m>`).
 */

import type { OpenApiDocument } from "@types";
import {
  endpointsFromDoc,
  type SpecEndpoint,
} from "@foundation/domain/business/endpoint-spec/mod.ts";
import { processOrder } from "@foundation/domain/business/process-graph/mod.ts";
import { devReloadJs, emulatorClientJs, emulatorCss } from "./client.ts";

/** Endpoints in process order, ready to embed in the emulator page. */
export function orderedEndpoints(doc: OpenApiDocument): SpecEndpoint[] {
  const endpoints = endpointsFromDoc(doc);
  const byId = new Map(endpoints.map((e) => [e.id, e]));
  const { order } = processOrder(endpoints);
  return order.map((id) => byId.get(id)).filter((e): e is SpecEndpoint => !!e);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (
      ch,
    ) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]!),
  );
}

/** The slim request-building slice of one endpoint anywhere in the composed app. */
export interface AppEndpoint {
  module: string;
  id: string;
  method: string;
  path: string;
  description: string;
  bind: SpecEndpoint["bind"];
  inputSchema: SpecEndpoint["inputSchema"];
  params: SpecEndpoint["params"];
}

/**
 * Build the self-contained emulator HTML page for a module.
 *
 * `opts.producers` is the composed-app contract index for THIS module's declared `$inputs`:
 * input name → `"<module>:<endpointId>"` of an endpoint (in another composed module) whose
 * output carries a same-named field. The client falls back to that producer's shared capture
 * when the input has no explicit value. `opts.appEndpoints` is the whole composed app's
 * endpoint index — the Module-setup picker offers every endpoint, any module, so setup can
 * establish app-wide state. `opts.dev` appends the live-reload poller (the server registered
 * `/docs/_dev` because it booted under `KEEP_DEV`).
 */
export function emulatorShellHtml(
  title: string,
  doc: OpenApiDocument,
  opts: {
    producers?: Record<string, string>;
    appEndpoints?: AppEndpoint[];
    dev?: boolean;
  } = {},
): string {
  const endpoints = orderedEndpoints(doc);
  // Cycles can't be ordered or unlocked — surface them in the page instead of leaving the
  // steps mutely locked forever.
  const { cycles } = processOrder(endpointsFromDoc(doc));
  const producers = opts.producers ?? {};
  const appEndpoints = opts.appEndpoints ?? [];
  // `<` is escaped so spec-sourced text (descriptions…) can never close the inline script tag.
  const payload = JSON.stringify({
    title,
    endpoints,
    cycles,
    producers,
    appEndpoints,
  })
    .replace(
      /</g,
      "\\u003c",
    );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · emulator</title>
<style>${emulatorCss}</style>
</head>
<body>
<header>
  <div>
    <h1>${escapeHtml(title)} <span class="h-sub">process emulator</span></h1>
    <nav>
      <a id="link-swagger" href="#">Swagger UI &#8599;</a>
      <a id="link-json" href="#">OpenAPI JSON &#8599;</a>
      <a id="link-map" href="#">System map &#8599;</a>
      <a id="link-trace" href="#">Traces &#8599;</a>
    </nav>
  </div>
  <div class="bar">
    <span id="session-note" hidden></span>
    <div id="flows" hidden></div>
    <button id="reset" title="clear statuses, captured outputs, variables and edited bodies">Reset session</button>
    <button id="runall" class="primary">Run all in order</button>
  </div>
</header>
<div id="banner" hidden></div>
<main>
  <ul id="app" class="steps"></ul>
  <aside id="rail">
    <div class="railcard">
      <div class="progress"><div class="progress-fill"></div></div>
      <div id="progress-text"></div>
    </div>
    <div class="railcard" id="setup-card">
      <div class="railhead">Module setup
        <button class="mini" id="save-fixtures" title="write setup steps + expectations + persisted variables to spec/misc/cake.json">Save fixtures</button>
      </div>
      <div id="setup"></div>
      <select id="setup-add" title="add any endpoint in the app — any module — as a setup step"></select>
      <button id="run-setup" class="mini" title="run all setup steps now (they also run before Run all)">Run setup</button>
      <div class="hint">
        Calls that put the <b>whole app</b> in a known state before the process runs — pick any
        module's endpoint above, or snapshot one of this page's steps with <code>+ setup</code>.
        <b>Save fixtures</b> writes them — plus expectations and any variable you mark
        <code>persist</code> — to <code>spec/misc/cake.json</code>, so the config persists and can
        be checked in.
      </div>
    </div>
    <div class="railcard" id="scenarios-card">
      <div class="railhead">Scenarios</div>
      <div id="scenarios"></div>
      <form id="save-scenario" autocomplete="off">
        <input name="scenname" placeholder="name e.g. happy-path" aria-label="scenario name">
        <button title="snapshot the whole walk (flow, bodies, params, skips) under this name">Save</button>
      </form>
      <div class="hint">
        Named snapshots of this walk, stored in <code>spec/misc/scenarios/</code>.
        <b>load</b> applies one (overwrites bodies/params/flow); <b>run</b> loads then runs all.
        CI: <code>POST /docs/_run {"scenario":"name"}</code>.
      </div>
    </div>
    <div class="railcard" id="inputs-card" hidden>
      <div class="railhead">Module inputs</div>
      <div id="inputs"></div>
      <div class="hint">
        Values this module needs from outside (its <code>$name</code> binds) — produced by
        another module or set by you. Shared across every docs page.
      </div>
    </div>
    <div class="railcard">
      <div class="railhead">Variables</div>
      <div id="vars"></div>
      <form id="addvar" autocomplete="off">
        <input name="varname" placeholder="name" aria-label="variable name">
        <input name="varvalue" placeholder="value" aria-label="variable value">
        <button title="add a variable usable as {{name}} in any request">+</button>
      </form>
      <div class="hint">
        Reference any value as <code>{{step.field}}</code>, <code>{{name}}</code>
        (environment), <code>{{$name}}</code> (module input), or
        <code>{{module:step.field}}</code> (another module's capture) — it resolves when the
        request is sent.<br>
        <kbd>j</kbd>/<kbd>k</kbd> move &nbsp;<kbd>Enter</kbd> expand &nbsp;<kbd>⌘Enter</kbd> run
      </div>
    </div>
  </aside>
</main>
<script>window.__KEEP_EMULATOR__ = ${payload};</script>
<script>${emulatorClientJs}</script>${
    opts.dev ? `\n<script>${devReloadJs}</script>` : ""
  }
</body>
</html>`;
}
