// @ts-nocheck — CodeMirror glue, client-only; Vite transpiles, runtime is fine.
//
// Registry-driven CodeMirror: highlighting and linting both read the live
// keyword registry, so editing a keyword recolors/re-lints the editor.

import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  ViewPlugin,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";

export const setRegistry = StateEffect.define();

const registryField = StateField.define({
  create: () => ({
    tags: [],
    faults: { marker: "!" },
    tokens: {},
    builtins: [],
  }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setRegistry)) return e.value;
    return value;
  },
});

// ---- tokenizer (line-based, mirrors how Rune actually parses) ----
function tokenizeLine(text, lineStart, reg) {
  const marks = [];
  // The first plugin build runs before the real registry is dispatched in.
  if (!reg || !reg.tags || !reg.tags.length || !reg.tokens) return marks;
  const indent = text.length - text.trimStart().length;
  const body = text.slice(indent);
  if (body === "") return marks;

  if (body.startsWith("//")) {
    marks.push({
      from: lineStart + indent,
      to: lineStart + text.length,
      ...reg.tokens.comment,
    });
    return marks;
  }
  const cidx = text.indexOf("//", indent);
  const codeEnd = cidx === -1 ? text.length : cidx;
  if (cidx !== -1) {
    marks.push({
      from: lineStart + cidx,
      to: lineStart + text.length,
      ...reg.tokens.comment,
    });
  }
  const code = text.slice(0, codeEnd);

  const coreForm = (t) => t.tag.slice(0, -1) + ":core]"; // [DTO] → [DTO:core]
  const tag = reg.tags.find((t) =>
    body.startsWith(t.tag) || body.startsWith(coreForm(t))
  );
  if (tag) {
    const tagLen = body.startsWith(tag.tag)
      ? tag.tag.length
      : coreForm(tag).length;
    const from = lineStart + indent;
    marks.push({ from, to: from + tagLen, color: tag.color });
    marks.push(...tokenizeRest(code, from + tagLen, lineStart, reg));
    return marks;
  }
  // A boundary step: `service:` — any declared service name, one colon (not
  // the `::` static separator).
  const bp = body.match(/^[A-Za-z_][A-Za-z0-9_-]*:(?!:)/)?.[0];
  if (bp) {
    const from = lineStart + indent;
    marks.push({ from, to: from + bp.length, color: reg.tokens.fault.color });
    marks.push(...tokenizeRest(code, from + bp.length, lineStart, reg));
    return marks;
  }
  // A fault line declares itself with the registry's marker (REQ-018).
  if (body.startsWith(reg.faults?.marker ?? "!")) {
    marks.push({
      from: lineStart + indent,
      to: lineStart + codeEnd,
      color: reg.tokens.fault.color,
    });
    return marks;
  }
  marks.push(...tokenizeRest(code, lineStart + indent, lineStart, reg));
  return marks;
}

function tokenizeRest(code, absStart, lineStart, reg) {
  const marks = [];
  const rest = code.slice(absStart - lineStart);
  const sig = rest.match(/^(\s*)([A-Za-z_]\w*)(\.|::)([A-Za-z_][\w-]*)/);
  if (sig) {
    const nounFrom = absStart + sig[1].length;
    marks.push({
      from: nounFrom,
      to: nounFrom + sig[2].length,
      color: reg.tokens.noun.color,
    });
    const verbFrom = nounFrom + sig[2].length + sig[3].length;
    marks.push({
      from: verbFrom,
      to: verbFrom + sig[4].length,
      color: reg.tokens.verb.color,
    });
  }
  const suffix = reg.tokens?.dtoSuffix?.suffix || "Dto";
  const dtoRe = new RegExp(`[A-Za-z_]\\w*${suffix}\\b`, "g");
  const builtinSet = new Set(reg.builtins);
  const wordRe = /[A-Za-z_]\w*/g;
  const strRe = /"[^"]*"/g;
  let m;
  while ((m = strRe.exec(rest))) {
    marks.push({
      from: absStart + m.index,
      to: absStart + m.index + m[0].length,
      color: reg.tokens.string.color,
    });
  }
  while ((m = dtoRe.exec(rest))) {
    marks.push({
      from: absStart + m.index,
      to: absStart + m.index + m[0].length,
      color: reg.tokens.dtoSuffix.color,
    });
  }
  while ((m = wordRe.exec(rest))) {
    if (builtinSet.has(m[0])) {
      marks.push({
        from: absStart + m.index,
        to: absStart + m.index + m[0].length,
        color: reg.tokens.builtin.color,
      });
    }
  }
  return marks;
}

const colorMark = (m) =>
  Decoration.mark({
    attributes: {
      style: `color:${m.color}${m.italic ? ";font-style:italic" : ""}`,
    },
  });

const highlighter = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.build(view);
    }
    update(u) {
      const regChanged =
        u.startState.field(registryField) !== u.state.field(registryField);
      if (u.docChanged || u.viewportChanged || regChanged) {
        this.decorations = this.build(u.view);
      }
    }
    build(view) {
      const reg = view.state.field(registryField);
      const doc = view.state.doc;
      const all = [];
      for (let i = 1; i <= doc.lines; i++) {
        const line = doc.line(i);
        all.push(...tokenizeLine(line.text, line.from, reg));
      }
      all.sort((a, b) => a.from - b.from || b.to - a.to);
      const builder = new RangeSetBuilder();
      let last = -1;
      for (const m of all) {
        if (m.from < last || m.from >= m.to) continue;
        builder.add(m.from, m.to, colorMark(m));
        last = m.to;
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

// ---- linter: delegate to the artifact's declarative lint rules ----
import { lint as runLint } from "./lint.ts";
export function lintText(text, reg) {
  return runLint(text, reg);
}

const diagPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.build(view);
    }
    update(u) {
      const regChanged =
        u.startState.field(registryField) !== u.state.field(registryField);
      if (u.docChanged || regChanged) this.decorations = this.build(u.view);
    }
    build(view) {
      const reg = view.state.field(registryField);
      const doc = view.state.doc;
      const builder = new RangeSetBuilder();
      for (const d of lintText(doc.toString(), reg)) {
        const line = doc.line(d.line);
        const from = line.from + d.col;
        const to = Math.min(line.to, from + d.len);
        if (from >= to) continue;
        builder.add(
          from,
          to,
          Decoration.mark({
            class: d.severity === "error" ? "cm-diag-error" : "cm-diag-warn",
          }),
        );
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

const theme = EditorView.theme({
  "&": { backgroundColor: "var(--bg)", color: "var(--fg)", height: "100%" },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--faint)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "#ffffff07" },
  ".cm-activeLineGutter": { backgroundColor: "#ffffff0d" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--fg)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "#8fc2c633",
  },
}, { dark: true });

export function createEditor({ parent, doc, registry, onDocChange }) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        registryField,
        highlighter,
        diagPlugin,
        theme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onDocChange(u.state.doc.toString());
        }),
      ],
    }),
  });
  view.dispatch({ effects: setRegistry.of(registry) });
  return view;
}

// Highlight one line into HTML-friendly segments, reusing the exact same
// tokenizer the editor uses (so the read-only reference can't drift from it).
export function lineSegments(text, reg) {
  const marks = tokenizeLine(text, 0, reg).sort((a, b) => a.from - b.from);
  const segs = [];
  let pos = 0;
  for (const m of marks) {
    if (m.from < pos || m.from >= m.to) continue;
    if (m.from > pos) segs.push({ text: text.slice(pos, m.from) });
    segs.push({
      text: text.slice(m.from, m.to),
      color: m.color,
      italic: m.italic,
    });
    pos = m.to;
  }
  if (pos < text.length) segs.push({ text: text.slice(pos) });
  return segs;
}

export function pushRegistry(view, reg) {
  // Shallow-clone so the StateField value's identity changes — the highlighter
  // only rebuilds when `startState.field !== state.field`.
  if (view) view.dispatch({ effects: setRegistry.of({ ...reg }) });
}
