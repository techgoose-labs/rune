// deno-lint-ignore-file no-explicit-any jsx-button-has-type
import { useSignal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { createEditor, pushRegistry } from "../lib/editor.ts";
import { buildGrammar, buildHighlights } from "#generate-core";

type Reg = any;
type File = { path: string; content: string };

const FOLLOWS = [
  "signature",
  "poly",
  "typedef",
  "dtodef",
  "identifier",
  "case",
  "value",
  "none",
];

export default function Reference(
  props: { example: string; registry: Reg; tutorial?: boolean },
) {
  // The language definition — editable in place. `rev` bumps to re-render.
  const reg = useSignalRef(structuredClone(props.registry));
  if (!reg.architecture) {
    reg.architecture = { layers: {}, classify: [], reexportAllowed: [] };
  }
  if (!reg.lint) reg.lint = [];
  const rev = useSignal(0);
  const touch = () => {
    rev.value++;
  };

  const selected = useSignal("");
  const expanded = useSignal<string | null>(null); // construct id whose files are shown
  const expandedFile = useSignal<string>(""); // which produced file the open card previews
  const lens = useSignal("code"); // active right-pane lens
  const saveStatus = useSignal("");
  const fsDir = useSignal("../src");
  const fsResult = useSignal<
    { fileCount: number; diags: any[]; error?: string } | null
  >(null);
  const fsBusy = useSignal(false);

  // ---- export the artifact to the real toolchain ----
  // `modal` holds the active export filename, or null when the dialog is closed.
  const modal = useSignal<string | null>(null);
  const EXPORTS = ["keywords.json", "grammar.js", "highlights.scm"];
  function exportArtifact(tab: string) {
    if (tab === "grammar.js") {
      return {
        title: "grammar.js — tree-sitter grammar",
        body: buildGrammar(reg),
      };
    }
    if (tab === "highlights.scm") {
      return {
        title: "highlights.scm — tree-sitter queries",
        body: buildHighlights(reg),
      };
    }
    return {
      title: "keywords.json — the artifact",
      body: JSON.stringify(reg, null, 2),
    };
  }
  function download(name: string, text: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---- guided tutorial ----
  const tour = useSignal(-1);
  const tourRect = useSignal<
    { top: number; left: number; width: number; height: number } | null
  >(null);
  useEffect(() => {
    if (props.tutorial) tour.value = 0;
  }, []);

  async function runFsCheck() {
    fsBusy.value = true;
    fsResult.value = null;
    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dir: fsDir.value, registry: reg }),
      });
      const data = await res.json();
      if (data.error) {
        fsResult.value = { fileCount: 0, diags: [], error: data.error };
        return;
      }
      fsResult.value = { fileCount: data.fileCount, diags: data.diags ?? [] };
    } catch {
      fsResult.value = {
        fileCount: 0,
        diags: [],
        error: "filesystem check needs the dev server",
      };
    } finally {
      fsBusy.value = false;
    }
  }

  // ---- tutorial steps + driver ----
  const findCard = (lit: string) =>
    [...document.querySelectorAll(".construct.editable")].find((c) =>
      (c.querySelector(".construct-tag") as HTMLInputElement | null)?.value ===
        lit
    ) as HTMLElement | undefined;
  const findLint = (id: string) =>
    [...document.querySelectorAll(".lint-rule")].find((c) =>
      c.querySelector(".cg-toggle b")?.textContent === id
    ) as HTMLElement | undefined;
  const findArch = () =>
    [...document.querySelectorAll(".construct-tag")].find((t) =>
      t.textContent?.includes("layers")
    )?.closest(".construct") as HTMLElement | undefined;
  const findCheck = () =>
    document.querySelector(".check-lens") as HTMLElement | undefined;

  const tourSteps: Reg[] = [
    {
      sel: ".wordmark",
      placement: "bottom",
      title: "Welcome — the Language workbench",
      body:
        "This is where Rune is defined. The spec lives on the left; everything it produces — and the language itself — lives in the lenses on the right. By the end you'll be able to build anything. I'll drive.",
    },
    {
      sel: ".editor-host",
      placement: "right",
      title: "Write a spec — it's a trace",
      body:
        "This editor is always live. A [REQ] is one feature; the indented lines under it are its steps — operations that run in order. You describe the happy path as a trace, and faults as the ways each step can fail. Edit it and watch every lens react.",
    },
    {
      lens: "code",
      selFn: () => document.querySelector(".cg-files") as HTMLElement,
      placement: "left",
      title: "Output lens: Code",
      body:
        "The Code lens shows the actual files your templates generate from the spec — a whole hexagonal module (DTOs, classes, coordinators, tests). It regenerates as you type. Click any file to read it.",
    },
    {
      lens: "constructs",
      selFn: () => findCard("[REQ]"),
      placement: "left",
      title: "Language lens: Constructs — [REQ]",
      body:
        "Switch to the Constructs lens to edit the language. Every keyword is a card. [REQ] noun.verb(InputDto): OutputDto is a feature entry point — input & output must be DTOs, and the last step returns the output.",
    },
    {
      lens: "constructs",
      selFn: () => findCard("[ENT]"),
      placement: "left",
      title: "[MOD] and [ENT]",
      body:
        "[MOD] names the module (the src/<module>/ slot). [ENT] surface.action(...) is an inbound entrypoint — an HTTP route, CLI command, or queue handler — that dispatches to a [REQ].",
    },
    {
      sel: ".editor-host",
      placement: "right",
      title: "Steps, boundaries & faults",
      body:
        "noun.verb() is an instance step; Noun::verb() is static. A 2-char prefix (db: ex: os: fs: mq: lg:) marks a boundary — that noun becomes a data class. The lowercase words under a step are faults; each one becomes a generated test case.",
    },
    {
      lens: "constructs",
      selFn: () => findCard("[PLY]"),
      placement: "left",
      title: "Polymorphism: [PLY] / [CSE]",
      body:
        "[PLY] opens an interface; each [CSE] is a concrete implementation with its own steps. They generate base/ + implementations/<case>/ — one file per case, automatically.",
    },
    {
      lens: "constructs",
      selFn: () => findCard("[DTO]"),
      placement: "left",
      title: "Data: [DTO], [TYP], [NON]",
      body:
        "[DTO] is a data contract (name ends in Dto); [TYP] a semantic type over a primitive; [NON] a noun/class. url(s) becomes urls: url[]. The :core modifier routes a DTO/TYP to the shared src/core kernel.",
    },
    {
      lens: "constructs",
      selFn: () => findCard("[DTO]")?.querySelector(".cg-edit") as HTMLElement,
      placement: "left",
      title: "Every construct generates code — live",
      body:
        "Each card carries its codegen template: a path + a body. Open “produces” to watch the generated file render right in the card as you type — cause and effect on one screen. Templates call helpers like {{kebab_case(name)}}, loop with {{#each props}}, and read {{vars.*}}.",
    },
    {
      lens: "lint",
      selFn: () => findLint("boundary-types"),
      placement: "left",
      title: "Language lens: Lint — spec rules (rune)",
      body:
        "These validate the .rune itself — rune's LSP rules, declarative here. Toggle, set severity, edit the message. The “firing now” strip at the top of this lens reacts as you change a rule.",
    },
    {
      lens: "lint",
      selFn: () => findLint("dto-validation"),
      placement: "left",
      title: "Lint: generated rules (shape-checker)",
      body:
        "These validate the produced CODE — shape-checker's rules over the generated output: missing validation, '../' imports, layer violations, fault coverage. Two linters, one ruleset.",
    },
    {
      lens: "diag",
      selFn: () => document.querySelector(".ref-diags") as HTMLElement,
      placement: "left",
      title: "Output lens: Diagnostics",
      body:
        "Both streams in one place: spec diagnostics (rune) and generated-code diagnostics (shape-checker), live over your spec. This is how you know the language definition is consistent end to end. Click a generated finding to jump to its file.",
    },
    {
      lens: "arch",
      selFn: () => findArch(),
      placement: "left",
      title: "Language lens: Architecture",
      body:
        "The import-graph rules read this: each layer lists what it may import, and the classifier maps a file path to a layer. That's the machinery behind layer-restrictions, module-isolation, and poly-isolation.",
    },
    {
      lens: "check",
      before: () => {
        runFsCheck();
      },
      selFn: () => findCheck(),
      placement: "left",
      title: "Tools lens: Check",
      body:
        "Point this at a real project directory and the whole generated-code ruleset runs over the actual files on disk — shape-checker, live. I just ran it; the findings appear here.",
    },
    {
      sel: ".toolbar",
      placement: "bottom",
      title: "Export & Save the artifact",
      body:
        "Export hands you keywords.json (the language), plus a generated grammar.js and highlights.scm for the editor toolchain. Save writes the whole definition back to keywords.json — that one file IS the language, and you can use it to construct a new version of Rune.",
    },
    {
      sel: null,
      placement: "center",
      title: "You're an expert now",
      body:
        "That's the whole tool: write specs on the left; on the right, read the Output (Code · Diagnostics), shape the Language (Constructs · Lint · Architecture), and run Check on disk. Then Export or Save. Go build anything.",
    },
  ];

  function endTour() {
    tour.value = -1;
    tourRect.value = null;
    const u = new URL(globalThis.location.href);
    if (u.searchParams.has("tutorial")) {
      u.searchParams.delete("tutorial");
      history.replaceState(null, "", u.pathname + u.search);
    }
  }
  function tourNext() {
    const step = tourSteps[tour.value];
    if (step?.goto) {
      globalThis.location.href = step.goto;
      return;
    }
    if (tour.value >= tourSteps.length - 1) endTour();
    else tour.value++;
  }
  function tourCardStyle() {
    const r = tourRect.value;
    const W = 340, M = 14;
    if (!r) return "top:50%;left:50%;transform:translate(-50%,-50%);";
    const place = tourSteps[tour.value].placement;
    let top: number, left: number;
    if (place === "right") {
      left = r.left + r.width + M;
      top = r.top;
    } else if (place === "left") {
      left = r.left - W - M;
      top = r.top;
    } else if (place === "top") {
      left = r.left;
      top = Math.max(M, r.top - 230);
    } else {
      left = r.left;
      top = r.top + r.height + M;
    }
    left = Math.max(M, Math.min(left, globalThis.innerWidth - W - M));
    top = Math.max(M, Math.min(top, globalThis.innerHeight - 250));
    return `top:${top}px;left:${left}px;`;
  }
  useEffect(() => {
    if (tour.value < 0) return;
    const step = tourSteps[tour.value];
    if (step.lens) lens.value = step.lens; // bring the right lens into view first
    step.before?.();
    const measure = () => {
      const el = step.selFn
        ? step.selFn()
        : (step.sel ? document.querySelector(step.sel) : null);
      if (el) {
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const r = (el as HTMLElement).getBoundingClientRect();
        tourRect.value = {
          top: r.top,
          left: r.left,
          width: r.width,
          height: r.height,
        };
      } else tourRect.value = null;
    };
    const t = setTimeout(measure, 420);
    globalThis.addEventListener("resize", measure);
    return () => {
      clearTimeout(t);
      globalThis.removeEventListener("resize", measure);
    };
  }, [tour.value]);

  // the live spec being edited (the editor writes here)
  const source = useSignal(props.example);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<any>(null);
  useEffect(() => {
    const view = createEditor({
      parent: hostRef.current,
      doc: props.example,
      registry: reg,
      onDocChange: (t: string) => {
        source.value = t;
      },
    });
    viewRef.current = view;
    return () => view.destroy();
  }, []);
  // keyword edits recolor/re-lint the editor
  useEffect(() => {
    pushRegistry(viewRef.current, reg);
  }, [rev.value]);

  // read rev so everything below recomputes on each edit
  rev.value;

  // The engine, served (REQ-035): every edit of the spec or the language is
  // posted to /api/check, which answers with what `rune check` reports, the
  // files the engine generates and the generated-code findings — the SAME
  // modules the CLI runs, driven by the live registry. Debounced: the wasm
  // parse is fast, the round trip is what we rate.
  const engine = useSignal<EngineAnswer>({ findings: [], generated: [], files: [], reqs: 0 });
  useEffect(() => {
    const body = JSON.stringify({ source: source.value, registry: reg });
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        if (res.ok) engine.value = await res.json();
      } catch { /* the dev server is away; keep the last answer */ }
    }, 150);
    return () => clearTimeout(t);
  }, [source.value, rev.value]);
  const diagnostics = engine.value.findings;
  const genDiagnostics = engine.value.generated;
  const files: File[] = engine.value.files;
  if (selected.value === "" && files[0]) selected.value = files[0].path;
  const current = files.find((f) => f.path === selected.value) ?? files[0];
  const reqTotal = engine.value.reqs;

  async function save() {
    saveStatus.value = "saving…";
    try {
      const res = await fetch("/api/registry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reg),
      });
      const d = await res.json();
      saveStatus.value = d.ok
        ? `saved ✓ — ${d.tags} constructs written to keywords.json`
        : `error: ${d.error}`;
    } catch {
      saveStatus.value = "save failed (needs deno task dev)";
    }
  }


  function constructCard(tag: Reg, i: number) {
    return (
      <div class="construct editable">
        <div class="construct-head">
          <input
            class="construct-tag tagname"
            type="text"
            value={tag.tag}
            onInput={(e) => {
              tag.tag = (e.target as HTMLInputElement).value;
              touch();
            }}
          />
          <input
            type="color"
            value={tag.color}
            onInput={(e) => {
              tag.color = (e.target as HTMLInputElement).value;
              touch();
            }}
          />
          <button
            class="del"
            onClick={() => {
              reg.tags.splice(i, 1);
              touch();
            }}
          >
            delete
          </button>
        </div>
        <input
          class="construct-syntax-in"
          type="text"
          placeholder="syntax"
          value={tag.syntax ?? ""}
          onInput={(e) => {
            tag.syntax = (e.target as HTMLInputElement).value;
            touch();
          }}
        />
        <textarea
          class="construct-summary-in"
          rows={3}
          placeholder="what it means…"
          value={tag.summary ?? ""}
          onInput={(e) => {
            tag.summary = (e.target as HTMLTextAreaElement).value;
            touch();
          }}
        />
        <div class="row">
          <label>follows</label>
          <select
            value={tag.follows}
            onChange={(e) => {
              tag.follows = (e.target as HTMLSelectElement).value;
              touch();
            }}
          >
            {FOLLOWS.map((f) => (
              <option value={f} selected={f === tag.follows}>{f}</option>
            ))}
          </select>
          <label>indent</label>
          <input
            type="number"
            min={0}
            step={2}
            value={tag.indent ?? 0}
            onInput={(e) => {
              tag.indent = parseInt(
                (e.target as HTMLInputElement).value || "0",
                10,
              );
              touch();
            }}
          />
        </div>
        <textarea
          class="construct-rules-in"
          rows={2}
          placeholder="rules (one per line)"
          value={(tag.rules ?? []).join("\n")}
          onInput={(e) => {
            tag.rules = (e.target as HTMLTextAreaElement).value.split("\n").map(
              (s) => s.trim(),
            ).filter(Boolean);
            touch();
          }}
        />
      </div>
    );
  }

  // group tags by their `group`, preserving first-seen order
  const order: string[] = [];
  const groups: Record<string, { tag: Reg; i: number }[]> = {};
  reg.tags.forEach((t: Reg, i: number) => {
    const g = t.group || "Other";
    if (!groups[g]) {
      groups[g] = [];
      order.push(g);
    }
    groups[g].push({ tag: t, i });
  });

  return (
    <div class="studio">
      <header class="masthead">
        <h1 class="wordmark">
          <span class="glyph">◆</span>Rune <span class="em">Studio</span>
        </h1>
        <span class="tagline">
          spec on the left · code, diagnostics &amp; the language itself on the
          right.
        </span>
        <span class="spacer"></span>
        <div class="toolbar">
          <button
            class="btn"
            onClick={() => {
              tour.value = 0;
            }}
          >
            ✦ tutorial
          </button>
          <button
            class="btn"
            onClick={() => {
              modal.value = "keywords.json";
            }}
          >
            ↧ export
          </button>
          <span class="save-status">{saveStatus.value}</span>
          <button class="btn primary" onClick={save}>Save</button>
        </div>
      </header>

      <div class="workbench">
        {/* LEFT — the spec, always live; the source every lens derives from */}
        <div class="editor-col">
          <div class="editor-host" ref={hostRef}></div>
          <div class="diag-strip">
            {diagnostics.length === 0
              ? (
                <div class="diag-ok">
                  spec ✓ no problems · {reqTotal}{" "}
                  feature(s) · {files.length} files generated
                </div>
              )
              : diagnostics.map((d: Reg) => (
                <div
                  class={`diag-row ${
                    d.severity === "error" ? "error" : "warn"
                  }`}
                  onClick={() => {
                    lens.value = "diag";
                  }}
                >
                  <span class="ln">L{d.line}</span>
                  <span class="sev">{d.severity}</span>
                  <span>{d.message}</span>
                  <span class="rid">{d.ruleId}</span>
                </div>
              ))}
          </div>
        </div>

        {/* RIGHT — switchable lens onto the same spec */}
        <div class="panel-col">
          <div class="lens-tabs">
            <div class="lens-group">
              <span class="lens-glabel">output</span>
              <button
                class="tab"
                aria-selected={lens.value === "code"}
                onClick={() => lens.value = "code"}
              >
                Code <small>{files.length}</small>
              </button>
              <button
                class="tab"
                aria-selected={lens.value === "diag"}
                onClick={() => lens.value = "diag"}
              >
                Diagnostics
                {(diagnostics.length + genDiagnostics.length) > 0 && (
                  <span class="lens-badge">
                    {diagnostics.length + genDiagnostics.length}
                  </span>
                )}
              </button>
            </div>
            <div class="lens-group">
              <span class="lens-glabel">language</span>
              <button
                class="tab"
                aria-selected={lens.value === "constructs"}
                onClick={() => lens.value = "constructs"}
              >
                Constructs
              </button>
              <button
                class="tab"
                aria-selected={lens.value === "lint"}
                onClick={() => lens.value = "lint"}
              >
                Lint
              </button>
              <button
                class="tab"
                aria-selected={lens.value === "arch"}
                onClick={() => lens.value = "arch"}
              >
                Architecture
              </button>
            </div>
            <div class="lens-group">
              <span class="lens-glabel">tools</span>
              <button
                class="tab"
                aria-selected={lens.value === "check"}
                onClick={() => lens.value = "check"}
              >
                Check
              </button>
            </div>
          </div>

          <div class="tabpane">
            {lens.value === "code" && (
              <div class="code-lens">
                <div class="cg-files">
                  {files.map((f) => {
                    const slash = f.path.lastIndexOf("/");
                    return (
                      <div
                        class="cg-file"
                        aria-current={selected.value === f.path}
                        onClick={() => {
                          selected.value = f.path;
                        }}
                      >
                        <span class="dir">
                          {slash === -1 ? "" : f.path.slice(0, slash + 1)}
                        </span>
                        {slash === -1 ? f.path : f.path.slice(slash + 1)}
                      </div>
                    );
                  })}
                </div>
                <pre class="cg-view code-view">{current?.content ?? ""}</pre>
              </div>
            )}

            {lens.value === "diag" && (
              <>
                <div class="ref-diags">
                  <div class="ref-diags-head">
                    Spec diagnostics (rune) — {diagnostics.length === 0
                      ? "✓ no problems"
                      : `${diagnostics.length}`}
                  </div>
                  {diagnostics.map((d: Reg) => (
                    <div
                      class={`diag-row ${
                        d.severity === "error" ? "error" : "warn"
                      }`}
                    >
                      <span class="ln">L{d.line}</span>
                      <span class="sev">{d.severity}</span>
                      <span>{d.message}</span>
                      <span class="rid">{d.ruleId}</span>
                    </div>
                  ))}
                </div>
                <div class="ref-diags">
                  <div class="ref-diags-head">
                    Generated-code diagnostics (shape-checker) —{" "}
                    {genDiagnostics.length === 0
                      ? "✓ no problems"
                      : `${genDiagnostics.length}`}
                  </div>
                  {genDiagnostics.map((d: Reg) => (
                    <div
                      class={`diag-row ${
                        d.severity === "error" ? "error" : "warn"
                      }`}
                      onClick={() => {
                        selected.value = d.file;
                        lens.value = "code";
                      }}
                    >
                      <span class="sev">{d.severity}</span>
                      <span>{d.message}</span>
                      <span class="rid">{d.file} · {d.ruleId}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {lens.value === "constructs" && (
              <div class="lang-lens">
                <p class="lens-lead">
                  Each card is a construct. Edit its tag, summary, the{" "}
                  <b>follows</b>{" "}
                  shape, or its codegen template to change the language. Open
                  {" "}
                  <b>“produces”</b>{" "}
                  to watch the generated file render as you type.
                </p>
                {order.map((g) => (
                  <div class="catalog-group">
                    <div class="catalog-grouphead">
                      <h3>{g}</h3>
                    </div>
                    <div class="construct-grid">
                      {groups[g].map(({ tag, i }) => constructCard(tag, i))}
                    </div>
                  </div>
                ))}
                <button
                  class="addbtn"
                  onClick={() => {
                    reg.tags.push({
                      id: `kw${reg.tags.length + 1}`,
                      tag: "[NEW]",
                      label: "New construct",
                      group: "Other",
                      indent: 0,
                      follows: "identifier",
                      color: reg.palette.tag,
                      syntax: "[XXX] name",
                      summary: "",
                      rules: [],
                    });
                    touch();
                  }}
                >
                  + add construct
                </button>
              </div>
            )}

            {lens.value === "lint" && (
              <div class="lang-lens">
                <div class="ref-diags lens-effect">
                  <div class="ref-diags-head">
                    firing now — spec {diagnostics.length} · generated{" "}
                    {genDiagnostics.length}
                  </div>
                  {diagnostics.map((d: Reg) => (
                    <div
                      class={`diag-row ${
                        d.severity === "error" ? "error" : "warn"
                      }`}
                    >
                      <span class="sev">{d.severity}</span>
                      <span>{d.message}</span>
                      <span class="rid">L{d.line} · {d.ruleId}</span>
                    </div>
                  ))}
                  {genDiagnostics.map((d: Reg) => (
                    <div
                      class={`diag-row ${
                        d.severity === "error" ? "error" : "warn"
                      }`}
                    >
                      <span class="sev">{d.severity}</span>
                      <span>{d.message}</span>
                      <span class="rid">{d.file} · {d.ruleId}</span>
                    </div>
                  ))}
                </div>
                <p class="lens-lead">
                  Each rule is a configurable instance of a built-in check.{" "}
                  <b>spec</b> rules validate the .rune; <b>generated</b>{" "}
                  rules validate the produced code. Toggle one and watch “firing
                  now” react.
                </p>
                <div class="construct-grid">
                  {(reg.lint || []).map((rule: Reg, i: number) =>
                    ruleCard(rule, i)
                  )}
                </div>
                <button
                  class="addbtn"
                  onClick={() => {
                    if (!reg.lint) reg.lint = [];
                    reg.lint.push({
                      id: `rule${reg.lint.length + 1}`,
                      type: ruleTypesOf(reg)[0],
                      target: "spec",
                      severity: "warning",
                      enabled: true,
                      params: {},
                      message: "",
                    });
                    touch();
                  }}
                >
                  + add rule
                </button>
              </div>
            )}

            {lens.value === "arch" && (
              <div class="lang-lens">
                <p class="lens-lead">
                  The import-graph rules read this: each layer lists what it may
                  import; the classifier maps a generated file path (regex) to a
                  layer.
                </p>
                <div class="construct-grid">
                  <div class="construct">
                    <div class="construct-head">
                      <span class="construct-tag">layers — may import</span>
                    </div>
                    {Object.entries(reg.architecture?.layers || {}).map((
                      [layer, allowed],
                    ) => (
                      <div class="row">
                        <label>{layer}</label>
                        <input
                          type="text"
                          value={(allowed as string[]).join(", ")}
                          onInput={(e) => {
                            reg.architecture.layers[layer] =
                              (e.target as HTMLInputElement).value.split(",")
                                .map((s) => s.trim()).filter(Boolean);
                            touch();
                          }}
                        />
                      </div>
                    ))}
                  </div>
                  <div class="construct">
                    <div class="construct-head">
                      <span class="construct-tag">path → layer</span>
                    </div>
                    {(reg.architecture?.classify || []).map((
                      c: Reg,
                      i: number,
                    ) => (
                      <div class="row">
                        <input
                          type="text"
                          value={c.match}
                          onInput={(e) => {
                            c.match = (e.target as HTMLInputElement).value;
                            touch();
                          }}
                        />
                        <span class="var-eq">→</span>
                        <input
                          class="var-key"
                          type="text"
                          value={c.layer}
                          onInput={(e) => {
                            c.layer = (e.target as HTMLInputElement).value;
                            touch();
                          }}
                        />
                        <button
                          class="del"
                          onClick={() => {
                            reg.architecture.classify.splice(i, 1);
                            touch();
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      class="addbtn"
                      onClick={() => {
                        if (!reg.architecture.classify) {
                          reg.architecture.classify = [];
                        }
                        reg.architecture.classify.push({
                          match: "",
                          layer: "",
                        });
                        touch();
                      }}
                    >
                      + pattern
                    </button>
                  </div>
                </div>
                <div class="ref-diags lens-effect" style="margin-top:1rem">
                  <div class="ref-diags-head">
                    generated-code diagnostics — {genDiagnostics.length === 0
                      ? "✓ no problems"
                      : `${genDiagnostics.length}`}
                  </div>
                  {genDiagnostics.map((d: Reg) => (
                    <div
                      class={`diag-row ${
                        d.severity === "error" ? "error" : "warn"
                      }`}
                    >
                      <span class="sev">{d.severity}</span>
                      <span>{d.message}</span>
                      <span class="rid">{d.file} · {d.ruleId}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {lens.value === "check" && (
              <div class="lang-lens check-lens">
                <p class="lens-lead">
                  Scan a directory's source + <code>.rune</code>{" "}
                  files and run the generated-target ruleset over the real tree
                  (layer-restrictions, orphan-files, forbidden-dirs,
                  fragmentation, …) — shape-checker, on disk.
                </p>
                <div class="row" style="max-width:640px">
                  <label>dir</label>
                  <input
                    type="text"
                    value={fsDir.value}
                    onInput={(e) => {
                      fsDir.value = (e.target as HTMLInputElement).value;
                    }}
                    placeholder="path relative to the repo root"
                  />
                  <button class="btn primary" onClick={runFsCheck}>
                    {fsBusy.value ? "scanning…" : "Validate directory"}
                  </button>
                </div>
                {fsResult.value && (
                  <div class="ref-diags" style="margin-top:0.8rem">
                    <div class="ref-diags-head">
                      {fsResult.value.error
                        ? `error: ${fsResult.value.error}`
                        : `${fsResult.value.fileCount} files scanned — ${
                          fsResult.value.diags.length === 0
                            ? "✓ no problems"
                            : `${fsResult.value.diags.length} findings`
                        }`}
                    </div>
                    {fsResult.value.diags.map((d: Reg) => (
                      <div
                        class={`diag-row ${
                          d.severity === "error" ? "error" : "warn"
                        }`}
                      >
                        <span class="sev">{d.severity}</span>
                        <span>{d.message}</span>
                        <span class="rid">{d.file} · {d.ruleId}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {modal.value && (
        <div
          class="modal-backdrop"
          onClick={() => modal.value = null}
        >
          <div class="modal" onClick={(e) => e.stopPropagation()}>
            <div class="modal-head">
              <span class="export-tabs">
                {EXPORTS.map((t) => (
                  <button
                    class="tab"
                    aria-selected={modal.value === t}
                    onClick={() => modal.value = t}
                  >
                    {t}
                  </button>
                ))}
              </span>
              <span style="display:flex;gap:0.4rem">
                <button
                  class="btn"
                  onClick={() =>
                    download(modal.value!, exportArtifact(modal.value!).body)}
                >
                  download
                </button>
                <button class="btn" onClick={() => modal.value = null}>
                  close
                </button>
              </span>
            </div>
            <pre
              class="cg-view"
              style="max-height:62vh;border-radius:0 0 12px 12px"
            >{exportArtifact(modal.value).body}</pre>
          </div>
        </div>
      )}

      {tour.value >= 0 && (
        <div class="tour-root">
          {tourRect.value && (
            <div
              class="tour-spot"
              style={`top:${tourRect.value.top - 6}px;left:${
                tourRect.value.left - 6
              }px;width:${tourRect.value.width + 12}px;height:${
                tourRect.value.height + 12
              }px`}
            >
            </div>
          )}
          <div class="tour-card" style={tourCardStyle()}>
            <div class="tour-step">
              step {tour.value + 1} / {tourSteps.length}
            </div>
            <h3>{tourSteps[tour.value].title}</h3>
            <p>{tourSteps[tour.value].body}</p>
            <div class="tour-dots">
              {tourSteps.map((_, i) => (
                <span class={`dot ${i === tour.value ? "on" : ""}`}></span>
              ))}
            </div>
            <div class="tour-actions">
              <button class="tour-skip" onClick={endTour}>skip</button>
              <span class="spacer"></span>
              {tour.value > 0 && (
                <button
                  class="btn"
                  onClick={() => tour.value--}
                >
                  back
                </button>
              )}
              <button class="btn primary" onClick={tourNext}>
                {tourSteps[tour.value].goto
                  ? "Continue →"
                  : (tour.value >= tourSteps.length - 1 ? "done" : "next →")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  function ruleCard(rule: Reg, i: number) {
    return (
      <div class="construct lint-rule">
        <div class="construct-head">
          <label class="cg-toggle">
            <input
              type="checkbox"
              checked={rule.enabled !== false}
              onChange={(e) => {
                rule.enabled = (e.target as HTMLInputElement).checked;
                touch();
              }}
            />
            <b>{rule.id}</b>
          </label>
          <button
            class="del"
            onClick={() => {
              reg.lint.splice(i, 1);
              touch();
            }}
          >
            delete
          </button>
        </div>
        <div class="row">
          <label>type</label>
          <select
            value={rule.type}
            onChange={(e) => {
              rule.type = (e.target as HTMLSelectElement).value;
              touch();
            }}
          >
            {ruleTypesOf(reg).map((t: string) => (
              <option value={t} selected={t === rule.type}>{t}</option>
            ))}
          </select>
        </div>
        <div class="row">
          <label>severity</label>
          <select
            value={rule.severity}
            onChange={(e) => {
              rule.severity = (e.target as HTMLSelectElement).value;
              touch();
            }}
          >
            <option value="error" selected={rule.severity === "error"}>
              error
            </option>
            <option value="warning" selected={rule.severity === "warning"}>
              warning
            </option>
          </select>
          <label>target</label>
          <select
            value={rule.target || "spec"}
            onChange={(e) => {
              rule.target = (e.target as HTMLSelectElement).value;
              touch();
            }}
          >
            <option value="spec" selected={(rule.target || "spec") === "spec"}>
              spec
            </option>
            <option value="generated" selected={rule.target === "generated"}>
              generated
            </option>
          </select>
        </div>
        <input
          class="construct-syntax-in"
          type="text"
          placeholder="message (use {param} placeholders)"
          value={rule.message ?? ""}
          onInput={(e) => {
            rule.message = (e.target as HTMLInputElement).value;
            touch();
          }}
        />
        {Object.keys(rule.params || {}).length > 0 && (
          <div class="lint-params">
            {Object.entries(rule.params).map(([k, v]) => (
              <div class="row">
                <label>{k}</label>
                <input
                  type="text"
                  value={String(v)}
                  onInput={(e) => {
                    const nv = (e.target as HTMLInputElement).value;
                    rule.params[k] = /^\d+$/.test(nv) ? Number(nv) : nv;
                    touch();
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
}

// keep a stable mutable object across renders without useRef import churn
function useSignalRef<T>(initial: T): T {
  const s = useSignal<T>(initial);
  return s.peek();
}


// What /api/check answers: the engine's findings, its generated files and the
// generated-code findings over them (lib/engine.ts, server-side).
type EngineAnswer = {
  findings: any[];
  generated: any[];
  files: File[];
  reqs: number;
};

// The generated-code rule types the registry toggles (the rule editor's menu).
function ruleTypesOf(reg: any): string[] {
  return [
    ...new Set(
      ((reg.lint ?? []) as { target: string; type?: string }[])
        .filter((r) => r.target === "generated" && r.type)
        .map((r) => r.type as string),
    ),
  ];
}
