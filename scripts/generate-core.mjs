// Derive the tree-sitter artifacts from the keyword registry.
//
// This is the ONE place keywords turn into a grammar. generate.mjs imports it
// to write the committed grammar.js, highlights.scm and scanner-config.h; the
// studio imports the same module for its "Export" buttons, so the preview and
// the committed grammar can never drift.

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
        : `seq(${t}, $.signature, ":", $.return_type${tag.follows === "poly" ? ", optional($.value_name)" : ""})`;
      return sigForm;
    }
    case "typedef":
      return `seq(${t}, $.typ_name, ":", $.typ_type)`;
    case "dtodef":
      return `seq(${t}, $.dto_def_name, ":", $.dto_prop, repeat(seq(",", optional($._ws), $.dto_prop)))`;
    case "identifier":
    case "case": // a polymorphic case is followed by a bare case name
      // [MOD] name: prose — the module's front-door description may follow the
      // name after a colon (the rest of the line, like a [SRV] body).
      if (tag.id === "mod") {
        return `seq(${t}, field("name", $.mod_name), optional(seq(":", alias($.srv_spec, $.mod_desc))))`;
      }
      return `seq(${t}, field("name", $.identifier))`;
    case "value":
      return `seq(${t}, choice(prec(2, $.dto_reference), $.type_name))`;
    case "service":
      // [SRV] (TRANSPORT)<name>: <ENV, ENV2> — the spec body is consumed as one
      // token; the engine's lowering does the structural parse of it.
      return `seq(${t}, $.srv_spec)`;
    case "none":
      return `${t}`;
    default:
      throw new Error(
        `Unknown "follows" kind: ${tag.follows} (tag ${tag.tag})`,
      );
  }
}

// Modifier-aware tags take an open-ended modifier list ([TYP:ext,uuid],
// [TYP:min=0,max=100], [ENT:card], [REQ:open]) — enumerating every literal
// can't cover valued/composed modifiers, so these tags get a token PATTERN
// rule, and the engine's lowering validates the modifier (so a wrong one is a
// precise finding, never a parse error that loses the line). The rest stay
// literal-only.
const MODIFIER_PATTERN_TAGS = new Set(["req", "ent", "dto", "typ", "non"]);

/** A `[TAG]`/`[TAG:mods]` token pattern: [TYP] -> token(seq("[TYP", …, "]")). */
function tagTokenPattern(literal) {
  const head = literal.replace(/\]$/, "");
  // A modifier value may carry spaces (`[TYP:example=Buy groceries]`): the
  // slot runs to the closing bracket.
  return `token(seq(${
    JSON.stringify(head)
  }, optional(seq(":", /[^\\]]+/)), "]"))`;
}

const HEADER = (comment) =>
  `${comment} GENERATED from lang/keywords.json by scripts/generate.mjs — do not edit by hand.\n${comment} Edit the registry and regenerate.`;

/** Build the contents of grammar.js from the registry. */
export function buildGrammar(reg) {
  const tagRules = reg.tags
    .map((tag) => {
      const tagRule = MODIFIER_PATTERN_TAGS.has(tag.id)
        ? tagTokenPattern(tag.tag)
        : JSON.stringify(tag.tag);
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
    "$.fault_line",
    "$.dto_desc",
    "$.typ_desc",
    "$.non_desc",
  ]
    .map((r) => `        ${r},`)
    .join("\n");

  const marker = JSON.stringify(reg.faults.marker);

  return `/// <reference types="tree-sitter-cli/dsl" />
// @ts-check
//
${HEADER("//")}

module.exports = grammar({
  name: "rune",

  extras: ($) => [/ /, /\\t/, $.comment],

  externals: ($) => [$.typ_desc, $.dto_desc, $.non_desc, $.service_prefix],

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

    // [ENT] route clause: an optional "@ METHOD [/path/{seg}/{seg-star}]" clause between the
    // verb and the parameters — the verb alone overrides the method, a slash-led template the
    // route too. One anchored token (@ + space + verb …), so it never collides with @docs (no
    // space after the @) or // line comments.
    http_route: ($) => token(seq("@", /\\s+/, /[A-Za-z]+/, optional(seq(/\\s+/, "/", /[^\\s()]*/)))),

    // A parameter list may span lines: whitespace (newlines included) is
    // allowed after the opening paren and before the closing one.
    parameters: ($) => seq("(", optional($._ws), optional($._param_list), optional($._ws), ")"),

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
          $.inline_dto,
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

    // A step's value name: "… : TaskDto as loaded" names the value it yields, so a
    // second live value of one type can be told from the first (REQ-020).
    value_name: ($) => seq("as", field("name", $.identifier)),

    // A step yields a typed value: "… : Type [as name]". The return clause is
    // optional in the grammar so a step that forgot it is still a step (the
    // engine reports missing-return-type), never an unrecognized line.
    step_line: ($) => seq($.signature, optional(seq(":", $.return_type, optional($.value_name)))),

    // The boundary prefix is the external service_prefix token (\`name:\`, a
    // single colon — distinct from the \`::\` static separator, which the DFA
    // can't tell apart without the scanner's lookahead).
    boundary_line: ($) =>
      seq($.service_prefix, $.signature, optional(seq(":", $.return_type, optional($.value_name)))),

    // A fault line declares its kind by its first token, the registry's marker
    // (REQ-018): "! not-found timeout card-expired=402".
    // The names (each optionally =STATUS) are one line token: the engine's
    // lowering splits and validates them against the registry's fault shape.
    fault_marker: ($) => ${marker},
    fault_line: ($) => seq($.fault_marker, alias($.srv_spec, $.fault_list)),

    // [SRV] body: <transport>:<name>: <ENV, ...> consumed as one line token.
    srv_spec: ($) => token(/[^\\n]+/),

    // \`@docs <url>\` — the required documentation link under an [SRV]. Its own
    // line rule (not a *_desc) so it parses cleanly instead of as an ERROR node;
    // the url reuses the greedy srv_spec token so a \`//\` inside it is NOT lexed
    // as a comment.
    srv_docs_line: ($) => seq("@docs", optional($.srv_spec)),

    // Any identifier: the Dto suffix is the engine's dto-suffix rule, so a
    // misnamed contract is a precise finding, not a parse error.
    dto_def_name: ($) => /[A-Za-z_][A-Za-z0-9_]*/,

    // A property: a [TYP] name or a [DTO] name, optionally an array "(s)" /
    // lenient array "(s?)", optionally "?" (optional property).
    dto_prop: ($) =>
      seq(
        choice(prec(2, $.dto_reference), $.property_name),
        optional($.dto_array_suffix),
        optional($.dto_optional_marker)
      ),

    dto_optional_marker: ($) => "?",

    dto_array_suffix: ($) => /\\([a-z]+\\??\\)/,

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

    // A module name is a directory name: kebab-case is allowed.
    mod_name: ($) => /[a-zA-Z_][a-zA-Z0-9_-]*/,
  },
});
`;
}

/** Build the contents of queries/highlights.scm from the registry. */
export function buildHighlights(reg) {
  const lines = [
    "; Rune syntax highlighting",
    ...HEADER(";").split("\n"),
    "; Capture names match the @rune.* groups defined in the editor ftplugin;",
    "; every pattern references a node that exists in the generated grammar.",
    "",
    "; Tags: structural anchors",
  ];

  for (const tag of reg.tags) lines.push(`(${tag.id}_tag) @rune.tag`);

  lines.push("", "; Nouns: subjects (before . or ::) and declared names");
  lines.push("(req_line (identifier) @rune.noun)");
  lines.push("(signature (identifier) @rune.noun)");
  lines.push("(mod_line (mod_name) @rune.noun)");
  for (const tag of reg.tags) {
    if (tag.id === "mod") continue;
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
    "; Parameters, DTO properties, declared type names and value names",
    "(param_name) @rune.param",
    "(property_name) @rune.param",
    "(typ_name) @rune.param",
    "(value_name (identifier) @rune.param)",
    "",
    "; Boundaries: system edges (service: prefix)",
    "(service_prefix) @rune.boundary",
    "",
    "; Faults",
    "(fault_marker) @rune.fault",
    "(fault_list) @rune.fault",
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

/** Build the external scanner's configuration header from the registry's
 * indent table and fault marker (REQ-033): the scanner reads these, never a
 * literal of its own. */
export function buildScannerConfig(reg) {
  const i = reg.indent;
  const define = (k, v) => `#define ${k} ${v}`;
  return [
    HEADER("//"),
    "#ifndef RUNE_SCANNER_CONFIG_H",
    "#define RUNE_SCANNER_CONFIG_H",
    "",
    "// The registry's indent table (the columns `rune fmt` writes).",
    define("RUNE_INDENT_UNIT", i.unit),
    define("RUNE_INDENT_STEP", i.step),
    define("RUNE_INDENT_FAULT", i.fault),
    define("RUNE_INDENT_CASE", i.case),
    define("RUNE_INDENT_CASE_STEP", i.caseStep),
    define("RUNE_INDENT_CASE_FAULT", i.caseFault),
    define("RUNE_INDENT_DESCRIPTION", i.description),
    define("RUNE_INDENT_BODY", i.body),
    define("RUNE_INDENT_FAULT_OFFSET", i.faultOffset),
    "",
    "// The fault marker: a line starting with it is never prose.",
    define("RUNE_FAULT_MARKER", `'${reg.faults.marker}'`),
    "",
    "#endif",
    "",
  ].join("\n");
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
