// Derive tree-sitter artifacts from the keyword registry.
//
// This is the ONE place keywords turn into a grammar. The studio keeps a
// logic-equivalent sibling copy at rune-studio/lib/generate-core.ts (it differs
// only in the //@ts-nocheck banner + Deno-fmt line wrapping) for its "Export"
// buttons; generate.mjs imports this file to write the committed grammar. Keep
// the two in lock-step — edit one, mirror the change in the other — so the studio
// preview and the committed grammar can never drift. (A shared single source
// would remove the hazard entirely; tracked as a follow-up.)

/** Map a tag's `follows` kind to the body of its tree-sitter line rule. */
function lineRuleBody(tag) {
  const t = `$.${tag.id}_tag`;
  switch (tag.follows) {
    case "signature":
    case "poly": // a polymorphic opener has the same line shape as a signature
    // noun.verb(args): returnType  (optionally a camelCase function name).
    // When a camelCase form is allowed, both forms must begin with the same
    // token type (identifier) — otherwise the lexer commits to function_name
    // before the parser can see the "." of the dotted form, producing a spurious
    // ERROR. So inline the rule: identifier, optional ".verb", then parameters.
    {
      const sigForm = tag.allowFunctionName
        ? `seq(${t}, field("noun", $.identifier), optional(seq(choice(".", "::"), field("verb", $.method_name))), optional($.http_route), $.parameters, ":", $.return_type)`
        : `seq(${t}, $.signature, ":", $.return_type)`;
      // [ENT:ws] additionally accepts a socket header "[ENT:ws] <surface> @ /path" (no
      // signature); its indented "verb(In): Out" topics parse as ordinary step_lines.
      if (tag.id === "ent") {
        return `choice(${sigForm}, seq(${t}, field("ws_surface", $.identifier), optional($.ws_route)))`;
      }
      return sigForm;
    }
    case "typedef":
      return `seq(${t}, $.typ_name, ":", $.typ_type)`;
    case "dtodef":
      return `seq(${t}, $.dto_def_name, ":", $.dto_prop, repeat(seq(",", optional($._ws), $.dto_prop)))`;
    case "identifier":
    case "case": // a polymorphic case is followed by a bare case name
      return `seq(${t}, field("name", $.identifier))`;
    case "value":
      return `seq(${t}, choice(prec(2, $.dto_reference), $.type_name))`;
    case "service":
      // [SRV] <transport>:<name>: <ENV, ENV2> — the spec body is consumed as one
      // token (highlighting only; the TS parser does the real structural parse).
      return `seq(${t}, $.srv_spec)`;
    case "none":
      return `${t}`;
    default:
      throw new Error(
        `Unknown "follows" kind: ${tag.follows} (tag ${tag.tag})`,
      );
  }
}

/** Insert a modifier token before a tag literal's closing bracket: [DTO] :core -> [DTO:core]. */
function applyModifier(literal, token) {
  return literal.replace(/\]$/, `${token}]`);
}

/**
 * Every literal a tag's `_tag` rule must accept: its primary spelling, any
 * synonyms ([NEW]/[CTR]), and any :core-style modifier variants ([DTO:core]).
 */
function tagLiterals(tag, modifiers) {
  const base = [tag.tag, ...(tag.synonyms ?? [])];
  const variants = [];
  for (const mod of modifiers) {
    if ((mod.appliesTo ?? []).includes(tag.id)) {
      for (const b of base) variants.push(applyModifier(b, mod.token));
    }
  }
  return [...base, ...variants];
}

// Modifier-aware tags take an open-ended modifier list ([TYP:ext,uuid],
// [TYP:min=0,max=100], [ENT:card]) — enumerating every literal can't cover
// valued/composed modifiers, so these tags get a token PATTERN rule instead.
// [REQ] (and the rest) stay literal-only: a modifier there is a spec error the
// parser must surface, not silently accept.
const MODIFIER_PATTERN_TAGS = new Set(["ent", "dto", "typ", "non"]);

/** A `[TAG]`/`[TAG:mods]` token pattern: [TYP] -> token(seq("[TYP", …, "]")). */
function tagTokenPattern(literal) {
  const head = literal.replace(/\]$/, "");
  return `token(seq(${
    JSON.stringify(head)
  }, optional(seq(":", /[^\\]\\s]+/)), "]"))`;
}

/** Build the contents of grammar.js from the registry. */
export function buildGrammar(reg) {
  const modifiers = reg.modifiers ?? [];

  const tagRules = reg.tags
    .map((tag) => {
      let tagRule;
      if (MODIFIER_PATTERN_TAGS.has(tag.id)) {
        const pats = [tag.tag, ...(tag.synonyms ?? [])].map(tagTokenPattern);
        tagRule = pats.length === 1 ? pats[0] : `choice(${pats.join(", ")})`;
      } else {
        const lits = tagLiterals(tag, modifiers);
        tagRule = lits.length === 1
          ? JSON.stringify(lits[0])
          : `choice(${lits.map((l) => JSON.stringify(l)).join(", ")})`;
      }
      return (
        `    // ${tag.tag} ${tag.label} (indent ${tag.indent})\n` +
        `    ${tag.id}_tag: ($) => ${tagRule},\n` +
        `    ${tag.id}_line: ($) => ${lineRuleBody(tag)},`
      );
    })
    .join("\n\n");

  const lineChoice = [
    ...reg.tags.map((t) => `$.${t.id}_line`),
    "$.srv_docs_line",
    "$.boundary_line",
    "$.step_line",
    "$.ws_topic_line",
    "$.fault_line",
    "$.dto_desc",
    "$.typ_desc",
    "$.non_desc",
  ]
    .map((r) => `        ${r},`)
    .join("\n");

  return `/// <reference types="tree-sitter-cli/dsl" />
// @ts-check
//
// GENERATED from new/keywords.json by new/generate.mjs — do not edit by hand.
// Edit the registry (or use the studio) and regenerate.

module.exports = grammar({
  name: "rune",

  extras: ($) => [/ /, /\\t/, $.comment],

  externals: ($) => [$.typ_desc, $.dto_desc, $.non_desc, $.fault_line, $.service_prefix],

  rules: {
    source_file: ($) => repeat(choice($._line, /\\r?\\n/)),

    _line: ($) =>
      choice(
${lineChoice}
      ),

    // ---- generated keyword rules --------------------------------------
${tagRules}
    // ---- end generated keyword rules ----------------------------------

    comment: ($) => token(seq("//", /.*/)),

    dto_reference: ($) => /[A-Za-z_][A-Za-z0-9_]*Dto/,

    signature: ($) =>
      seq(
        field("noun", $.identifier),
        choice(".", "::"),
        field("verb", $.method_name),
        optional($.http_route),
        $.parameters
      ),

    method_name: ($) => /[a-zA-Z][a-zA-Z0-9_-]*/,

    // [ENT] field-source binding: an optional "@ METHOD /path/{seg}/{seg-star}" clause between the
    // verb and the parameters. One anchored token (@ + space + verb + space + slash-led path), so
    // it never collides with @docs (no space after the @) or // line comments.
    http_route: ($) => token(seq("@", /\\s+/, /[A-Za-z]+/, /\\s+/, "/", /[^\\s()]*/)),

    // [ENT:ws] socket-header path: "@ /path" — like http_route but with no HTTP verb (a WS
    // handshake is always a GET). A distinct token so the lexer never confuses "@ /x" with
    // "@ VERB /x" (http_route) or "@docs" (no space after the @).
    ws_route: ($) => token(seq("@", /\\s+/, "/", /[^\\s()]*/)),

    parameters: ($) => seq("(", optional($._param_list), ")"),

    _param_list: ($) =>
      seq($._param, repeat(seq(",", optional($._ws), $._param))),

    _param: ($) =>
      choice(
        $.inline_dto,
        $.typed_param,
        prec(2, $.dto_reference),
        $.param_name
      ),

    typed_param: ($) => seq($.param_name, ":", $._type),

    param_name: ($) => /[a-zA-Z_][a-zA-Z0-9_]*/,

    inline_dto: ($) =>
      seq(
        "{",
        optional(
          seq(
            optional($._ws),
            $.dto_property,
            repeat(seq(",", optional($._ws), $.dto_property)),
            optional($._ws)
          )
        ),
        "}"
      ),

    _ws: ($) => /[\\s]+/,

    dto_property: ($) => $.property_name,

    property_name: ($) => /[a-zA-Z_][a-zA-Z0-9_]*/,

    _type: ($) => choice(prec(2, $.dto_reference), $.type_name),

    type_name: ($) => /[a-zA-Z_][a-zA-Z0-9_]*/,

    return_type: ($) =>
      seq($._return_type_single, repeat(seq("|", $._return_type_single))),

    _return_type_single: ($) =>
      prec.right(
        choice(
          $.array_type,
          $.generic_type,
          prec(2, $.dto_reference),
          prec(1, $.type_name)
        )
      ),

    array_type: ($) =>
      prec(5, seq(choice(prec(2, $.dto_reference), $.type_name), "[", "]")),

    generic_type: ($) =>
      seq($.type_name, "<", $._generic_inner, ">"),

    _generic_inner: ($) =>
      seq(
        choice(prec(2, $.dto_reference), $.type_name),
        repeat(seq(",", choice(prec(2, $.dto_reference), $.type_name)))
      ),

    step_line: ($) => seq($.signature, ":", $.return_type),

    // [ENT:ws] topic line: a bare "verb(InputDto): OutputDto" (no noun. prefix) under a socket
    // header. step_line's signature requires a dotted noun.verb, so topics need their own rule.
    // The verb MUST be $.identifier (the same leading token step_line uses) — using method_name
    // would make the lexer commit to it before the parser sees a dotted form's ".", spuriously
    // erroring real steps. After the identifier, the next token ("." / "::" vs "(") disambiguates.
    ws_topic_line: ($) => seq(field("verb", $.identifier), $.parameters, ":", $.return_type),

    // The boundary prefix is the external service_prefix token (\`name:\`, a
    // single colon — distinct from the \`::\` static separator, which the DFA
    // can't tell apart without the scanner's lookahead).
    boundary_line: ($) =>
      seq($.service_prefix, $.signature, ":", $.return_type),

    // [SRV] body: <transport>:<name>: <ENV, ...> consumed as one line token.
    srv_spec: ($) => token(/[^\\n]+/),

    // \`@docs <url>\` — the required documentation link under an [SRV]. Its own
    // line rule (not a *_desc) so it parses cleanly instead of as an ERROR node;
    // the url reuses the greedy srv_spec token so a \`//\` inside it is NOT lexed
    // as a comment.
    srv_docs_line: ($) => seq("@docs", optional($.srv_spec)),

    dto_def_name: ($) => /[A-Za-z_][A-Za-z0-9_]*Dto/,

    dto_prop: ($) =>
      seq(
        choice($.dto_array_prop, prec(2, $.dto_reference), $.property_name),
        optional($.dto_optional_marker)
      ),

    dto_optional_marker: ($) => "?",

    dto_array_prop: ($) => seq($.property_name, $.dto_array_suffix),

    dto_array_suffix: ($) => /\\([a-z]+\\)/,

    typ_name: ($) => /[a-zA-Z_][a-zA-Z0-9_]*/,

    typ_type: ($) =>
      choice(
        $.typ_generic_type,
        $.typ_tuple_type,
        $.typ_enum_type,
        prec(1, $.type_name)
      ),

    typ_generic_type: ($) => seq($.type_name, "<", $._generic_inner, ">"),

    typ_tuple_type: ($) =>
      seq("[", $.type_name, repeat(seq(",", optional($._ws), $.type_name)), "]"),

    typ_enum_type: ($) =>
      seq($.typ_enum_value, repeat1(seq("|", $.typ_enum_value))),

    typ_enum_value: ($) => /"[^"]*"/,

    identifier: ($) => /[a-zA-Z_][a-zA-Z0-9_]*/,
  },
});
`;
}

/** Build the contents of queries/highlights.scm from the registry. */
export function buildHighlights(reg) {
  const lines = [
    "; Rune syntax highlighting",
    "; GENERATED from new/keywords.json by new/generate.mjs — do not edit by hand.",
    "; Capture names match the @rune.* groups defined in the editor ftplugin;",
    "; every pattern references a node that exists in the generated grammar.",
    "",
    "; Tags: structural anchors",
  ];

  for (const tag of reg.tags) lines.push(`(${tag.id}_tag) @rune.tag`);

  lines.push("", "; Nouns: subjects (before . or ::) and declared names");
  lines.push("(req_line (identifier) @rune.noun)");
  lines.push("(signature (identifier) @rune.noun)");
  for (const tag of reg.tags) {
    if (tag.follows === "identifier" || tag.follows === "case") {
      lines.push(`(${tag.id}_line (identifier) @rune.noun)`);
    }
  }

  lines.push(
    "",
    "; Verbs: actions (after . or ::)",
    "(method_name) @rune.verb",
    "",
    "; Types: DTOs and type references",
    "(dto_reference) @rune.type",
    "(dto_def_name) @rune.type",
    "(return_type (type_name) @rune.type)",
    "(array_type (type_name) @rune.type)",
    "(generic_type (type_name) @rune.type)",
    "(typed_param (type_name) @rune.type)",
    "(typ_type (type_name) @rune.type)",
    "(typ_generic_type (type_name) @rune.type)",
    "(typ_tuple_type (type_name) @rune.type)",
    "",
    "; String enum values",
    "(typ_enum_value) @rune.fault",
    "",
    "; Parameters, DTO properties, and declared type names",
    "(param_name) @rune.param",
    "(property_name) @rune.param",
    "(typ_name) @rune.param",
    "",
    "; Boundaries: system edges (service: prefix)",
    "(service_prefix) @rune.boundary",
    "",
    "; Faults",
    "(fault_line) @rune.fault",
    "",
    "; Punctuation / chrome",
    "(dto_optional_marker) @rune.chrome",
    "(dto_array_suffix) @rune.chrome",
    "",
    "; Descriptions & comments",
    "(typ_desc) @rune.comment",
    "(dto_desc) @rune.comment",
    "(non_desc) @rune.comment",
    "(srv_docs_line) @rune.comment",
    "(comment) @rune.comment",
  );

  return lines.join("\n") + "\n";
}

/** Map registry palette keys to the @rune.* capture names used in highlights. */
export function captureColors(reg) {
  return {
    "rune.tag": reg.palette.tag,
    "rune.noun": reg.palette.noun,
    "rune.verb": reg.palette.verb,
    "rune.dto": reg.palette.dto,
    "rune.builtin": reg.palette.builtin,
    "rune.boundary": reg.palette.boundary,
    "rune.fault": reg.palette.fault,
    "rune.comment": reg.palette.comment,
  };
}
