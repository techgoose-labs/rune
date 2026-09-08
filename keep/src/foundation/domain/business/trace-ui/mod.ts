/**
 * The request-trace **waterfall** page, served at `/docs/_trace` (underscore-prefixed so a module
 * named "trace" can still own `/docs/trace`). Each recent real request renders as a bar; inside
 * the bar every timed span is a segment — the request root, each in-process `backend.fetch`
 * sub-call, and every user function wrapped in `span()` / `@Traced`. A request that threw shows a
 * ✕ on the exact span that crashed.
 *
 * The page is a public shell (it always loads); it polls the **localhost-only** `/docs/_traces`
 * JSON route for the data, since traces carry route paths and error messages. The page itself
 * holds no trace data — unlike the map, there's nothing to compute server-side here; the ring
 * buffer lives in the {@linkcode Tracer} and is read at poll time.
 */

import { devReloadJs } from "@foundation/domain/business/emulator-ui/client.ts";
import { traceClientJs, traceCss } from "./client.ts";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[ch]!),
  );
}

/**
 * Build the self-contained trace-waterfall page for the composed app. `opts.dev` appends the same
 * live-reload poller the emulator/map pages use (server booted under `KEEP_DEV`).
 */
export function traceShellHtml(
  appName: string,
  opts: { dev?: boolean } = {},
): string {
  const payload = JSON.stringify({ app: appName, dataUrl: "_traces" })
    .replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(appName)} · request traces</title>
<style>${traceCss}</style>
</head>
<body>
<header>
  <div>
    <h1>${escapeHtml(appName)} <span class="h-sub">request traces</span></h1>
    <nav>
      <a id="link-index" href=".">Docs index &#8599;</a>
      <a href="_map">System map &#8599;</a>
    </nav>
  </div>
  <div class="bar">
    <span id="store" class="store" title="where traces are stored: in-memory ring (default) or Deno KV (KEEP_TRACE_KV)"></span>
    <span id="count" class="count"></span>
    <button id="pause" title="stop/resume the 2s auto-refresh">Pause</button>
    <button id="clear" title="empty the trace buffer">Clear</button>
  </div>
</header>
<div id="filters">
  <input id="f-route" type="search" autocomplete="off" placeholder="route contains…">
  <select id="f-user" title="filter by user"><option value="">all users</option></select>
  <select id="f-method" title="filter by method"><option value="">any method</option></select>
  <select id="f-status" title="filter by status">
    <option value="">any status</option>
    <option value="ok">ok</option>
    <option value="crash">crashed</option>
  </select>
  <span class="legend">
    <span><i class="k-request"></i>request</span>
    <span><i class="k-backend"></i>backend call</span>
    <span><i class="k-user"></i>your function</span>
    <span><b style="color:#ff7b72">&#10006;</b> crash</span>
  </span>
</div>
<div id="wrap"></div>
<script>window.__KEEP_TRACE__ = ${payload};</script>
<script>${traceClientJs}</script>${
    opts.dev ? `\n<script>${devReloadJs}</script>` : ""
  }
</body>
</html>`;
}
