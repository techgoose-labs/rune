/**
 * The whole-app **system map** page, served at `/docs/_map` (underscore-prefixed so a module
 * named "map" can still own `/docs/map`). Every composed module's endpoints render as nodes in
 * module lanes; solid edges are intra-module binds (`"step.field"` autofill), dashed edges are
 * `"$input"` contracts satisfied by a producer in another module, and a `$name` nothing
 * produces shows as an amber input badge on its consumer. Flows tint their edges, optional and
 * stub endpoints carry chips, and each node's status dot recolors live from the emulator
 * sessions in localStorage — running a step in any tab updates the map. Clicking a node lands
 * on that module's emulator with the step expanded (`/docs/<module>#<endpointId>`).
 *
 * The graph AND its layout are computed server-side ({@linkcode buildMapModel}): rank = the
 * longest-path depth over the dependency edges → column; one row per endpoint, grouped by
 * module into lanes. The client only draws.
 */

import type { SwaggerDocEntry } from "@types";
import { endpointsFromDoc } from "@foundation/domain/business/endpoint-spec/mod.ts";
import { processOrder } from "@foundation/domain/business/process-graph/mod.ts";
import { devReloadJs } from "@foundation/domain/business/emulator-ui/client.ts";
import { mapClientJs, mapCss } from "./client.ts";

/** One endpoint as a positioned node on the map. */
export interface MapNode {
  module: string;
  id: string;
  /** Module-qualified key — endpoint ids are only unique within a module. */
  key: string;
  method: string;
  path: string;
  flows: string[];
  optional: boolean;
  stub: boolean;
  /** App-root-relative emulator page path, e.g. "/docs/checkout" — the client prepends its own mount prefix, so it is mount-safe. */
  docsPath: string;
  description: string;
  /** Declared `$inputs` no composed producer satisfies — rendered as amber badges. */
  inputs: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One bind wire between two nodes (keys are module-qualified). */
export interface MapEdge {
  from: string;
  to: string;
  /** The consumer field for binds; "$name" for cross-module input edges. */
  label: string;
  /** "bind" = intra-module autofill (solid); "input" = a produced $input (dashed). */
  kind: "bind" | "input";
  /** Flow tint source: the consumer's flows, falling back to the producer's. */
  flows: string[];
}

/** One module's horizontal band on the map. */
export interface MapLane {
  module: string;
  docsPath: string;
  y: number;
  h: number;
}

export interface MapModel {
  nodes: MapNode[];
  edges: MapEdge[];
  lanes: MapLane[];
  /** Every flow name across the app, sorted — drives the shared tint palette. */
  flows: string[];
  width: number;
  height: number;
}

// Layout constants — emitted into node/lane positions so the client only draws.
const NODE_W = 230;
const NODE_H = 52;
const COL_W = 290;
const ROW_H = 72;
const LANE_HEADER = 32;
const LANE_PAD = 12;
const LANE_GAP = 14;
const PAD_X = 30;

/**
 * Flatten all module docs into the positioned process graph. Pure: docs in, drawable model out.
 *
 * The producers index (output field name → `"<module>:<endpointId>"`, first producer wins,
 * stubs included) is built the same way bootstrap-server builds the per-module emulator
 * `producers` slices, so the dashed edges here mirror the emulator's `auto:` affordance.
 */
export function buildMapModel(docs: SwaggerDocEntry[]): MapModel {
  const moduleEntries = docs.map(({ path, doc }) => ({
    moduleName: path.replace(/^\//, ""),
    endpoints: endpointsFromDoc(doc),
  }));

  const producersByField = new Map<string, string>();
  for (const { moduleName, endpoints } of moduleEntries) {
    for (const ep of endpoints) {
      for (const field of ep.outputFields) {
        // An echo (consumes the field it outputs) can never bootstrap a value — not a producer.
        if (ep.inputFields.includes(field) || field in ep.bind) continue;
        if (!producersByField.has(field)) {
          producersByField.set(field, `${moduleName}:${ep.id}`);
        }
      }
    }
  }
  // `$name` is satisfiable by an exact `name` output, or a `name + "s"` collection (first
  // element) — the plural half of the composition contract.
  const producerForInput = (name: string): string | undefined =>
    producersByField.get(name) ?? producersByField.get(`${name}s`);

  const nodes: MapNode[] = [];
  const nodeByKey = new Map<string, MapNode>();
  const orderHint = new Map<string, number | undefined>();
  for (const { moduleName, endpoints } of moduleEntries) {
    for (const ep of endpoints) {
      const node: MapNode = {
        module: moduleName,
        id: ep.id,
        key: `${moduleName}:${ep.id}`,
        method: ep.method,
        path: ep.path,
        flows: ep.flows,
        optional: ep.optional,
        stub: ep.stub,
        docsPath: `/docs/${moduleName}`,
        description: ep.description ?? "",
        inputs: [],
        x: 0,
        y: 0,
        w: NODE_W,
        h: NODE_H,
      };
      nodes.push(node);
      nodeByKey.set(node.key, node);
      orderHint.set(node.key, ep.order);
    }
  }

  const edges: MapEdge[] = [];
  const seenEdges = new Set<string>();
  const addEdge = (e: MapEdge) => {
    const k = `${e.from}>${e.to}>${e.label}>${e.kind}`;
    if (seenEdges.has(k)) return;
    seenEdges.add(k);
    edges.push(e);
  };
  for (const { moduleName, endpoints } of moduleEntries) {
    for (const ep of endpoints) {
      const consumer = nodeByKey.get(`${moduleName}:${ep.id}`)!;
      for (const [field, ref] of Object.entries(ep.bind)) {
        for (const candidate of Array.isArray(ref) ? ref : [ref]) {
          if (candidate.startsWith("$")) {
            // A declared external input: a genuine producer (any module — exact field or its
            // plural collection, echoes never count) draws the dashed contract edge; with no
            // producer it stays an explicit-only input — an amber badge on the consumer node.
            const name = candidate.slice(1);
            const producer = producerForInput(name);
            if (producer && producer !== consumer.key) {
              const producerNode = nodeByKey.get(producer)!;
              addEdge({
                from: producer,
                to: consumer.key,
                label: `$${name}`,
                kind: "input",
                flows: consumer.flows.length
                  ? consumer.flows
                  : producerNode.flows,
              });
            } else if (!producer && !consumer.inputs.includes(name)) {
              consumer.inputs.push(name);
            }
          } else {
            // "step.field" — intra-module autofill from a captured response.
            const producer = nodeByKey.get(
              `${moduleName}:${candidate.split(".")[0]}`,
            );
            if (!producer) continue;
            addEdge({
              from: producer.key,
              to: consumer.key,
              label: field,
              kind: "bind",
              flows: consumer.flows.length ? consumer.flows : producer.flows,
            });
          }
        }
      }
    }
  }

  // Rank edges = the drawn edges plus bare `dependsOn` orderings (a dependsOn without a bind
  // still forces its consumer into a later column).
  const rankIn = new Map<string, Set<string>>(
    nodes.map((n) => [n.key, new Set<string>()]),
  );
  for (const e of edges) rankIn.get(e.to)!.add(e.from);
  for (const { moduleName, endpoints } of moduleEntries) {
    for (const ep of endpoints) {
      for (const dep of ep.dependsOn) {
        const key = `${moduleName}:${dep}`;
        if (nodeByKey.has(key)) rankIn.get(`${moduleName}:${ep.id}`)!.add(key);
      }
    }
  }

  // Topological order over MODULE-QUALIFIED keys (raw endpoint ids may collide across
  // modules), then rank = longest-path depth walked along that order.
  const { order } = processOrder(nodes.map((n) => ({
    id: n.key,
    dependsOn: [...rankIn.get(n.key)!],
    order: orderHint.get(n.key),
  })));
  const rank = new Map<string, number>();
  for (const key of order) {
    let r = 0;
    for (const from of rankIn.get(key) ?? []) {
      const fr = rank.get(from);
      if (fr !== undefined && fr + 1 > r) r = fr + 1;
    }
    rank.set(key, r);
  }

  const maxRank = nodes.reduce((m, n) => Math.max(m, rank.get(n.key) ?? 0), 0);
  const width = PAD_X * 2 + maxRank * COL_W + NODE_W;
  const topoIdx = new Map(order.map((key, i) => [key, i]));
  const lanes: MapLane[] = [];
  let y = 0;
  for (const { moduleName } of moduleEntries) {
    const laneNodes = nodes
      .filter((n) => n.module === moduleName)
      .sort((a, b) => (topoIdx.get(a.key) ?? 0) - (topoIdx.get(b.key) ?? 0));
    const h = LANE_HEADER + laneNodes.length * ROW_H + LANE_PAD;
    lanes.push({ module: moduleName, docsPath: `/docs/${moduleName}`, y, h });
    laneNodes.forEach((n, i) => {
      n.x = PAD_X + (rank.get(n.key) ?? 0) * COL_W;
      n.y = y + LANE_HEADER + i * ROW_H + (ROW_H - NODE_H) / 2;
    });
    y += h + LANE_GAP;
  }

  const flows = [...new Set(nodes.flatMap((n) => n.flows))].sort();
  return {
    nodes,
    edges,
    lanes,
    flows,
    width,
    height: lanes.length ? y - LANE_GAP : 0,
  };
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

/**
 * Build the self-contained system-map HTML page for the composed app. `opts.dev` appends the
 * same live-reload poller the emulator pages use (the server booted under `KEEP_DEV`).
 */
export function mapShellHtml(
  appName: string,
  docs: SwaggerDocEntry[],
  opts: { dev?: boolean } = {},
): string {
  const model = buildMapModel(docs);
  // `<` is escaped so spec-sourced text (descriptions…) can never close the inline script tag.
  const payload = JSON.stringify({ app: appName, ...model }).replace(
    /</g,
    "\\u003c",
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(appName)} · system map</title>
<style>${mapCss}</style>
</head>
<body>
<header>
  <div>
    <h1>${escapeHtml(appName)} <span class="h-sub">system map</span></h1>
    <nav>
      <a id="link-index" href="#">Docs index &#8599;</a>
      <a id="link-trace" href="#">Traces &#8599;</a>
    </nav>
  </div>
  <div class="bar">
    <button id="runall" class="primary" title="run every module's process in order on the server (localhost only) and color the map with the result">Run all</button>
  </div>
</header>
<div id="banner" hidden></div>
<div id="legend">
  <span class="lg"><svg width="26" height="10"><path class="lgline" d="M1 5 H25"></path></svg> bind (output → input)</span>
  <span class="lg"><svg width="26" height="10"><path class="lgline dashed" d="M1 5 H25"></path></svg> $input ← producer</span>
  <span class="lg"><span class="lgdot"></span> idle</span>
  <span class="lg"><span class="lgdot okd"></span> passed</span>
  <span class="lg"><span class="lgdot faild"></span> failed</span>
  <span id="legend-flows"></span>
</div>
<main id="canvas">
  <svg id="map" xmlns="http://www.w3.org/2000/svg"></svg>
</main>
<script>window.__KEEP_MAP__ = ${payload};</script>
<script>${mapClientJs}</script>${
    opts.dev ? `\n<script>${devReloadJs}</script>` : ""
  }
</body>
</html>`;
}
