/// <reference types="tree-sitter-cli/dsl" />
// @ts-check
//
// GENERATED from lang/keywords.json by scripts/generate.mjs — do not edit by hand.
// Edit the registry and regenerate.

module.exports = grammar({
  name: "rune",

  extras: ($) => [/ /, /\t/, $.comment],

  externals: ($) => [$.typ_desc, $.dto_desc, $.non_desc, $.service_prefix],

  rules: {
    source_file: ($) => repeat(choice($._line, /\r?\n/)),

    _line: ($) =>
      choice(
        $.req_line,
        $.mod_line,
        $.ent_line,
        $.ply_line,
        $.cse_line,
        $.new_line,
        $.ret_line,
        $.typ_line,
        $.dto_line,
        $.non_line,
        $.srv_line,
        $.srv_docs_line,
        $.boundary_line,
        $.step_line,
        $.fault_line,
        $.dto_desc,
        $.typ_desc,
        $.non_desc,
      ),

    // ---- generated keyword rules --------------------------------------
    // [REQ] Requirement (indent 0)
    req_tag: ($) => token(seq("[REQ", optional(seq(":", /[^\]]+/)), "]")),
    req_line: ($) => seq($.req_tag, field("noun", $.identifier), optional(seq(choice(".", "::"), field("verb", $.method_name))), optional($.http_route), $.parameters, ":", $.return_type),

    // [MOD] Module (indent 0)
    mod_tag: ($) => "[MOD]",
    mod_line: ($) => seq($.mod_tag, field("name", $.mod_name), optional(seq(":", alias($.srv_spec, $.mod_desc)))),

    // [ENT] Entrypoint (indent 0)
    ent_tag: ($) => token(seq("[ENT", optional(seq(":", /[^\]]+/)), "]")),
    ent_line: ($) => seq($.ent_tag, $.signature, ":", $.return_type),

    // [PLY] Polymorphic step (indent 4)
    ply_tag: ($) => "[PLY]",
    ply_line: ($) => seq($.ply_tag, $.signature, ":", $.return_type, optional($.value_name)),

    // [CSE] Case (indent 8)
    cse_tag: ($) => "[CSE]",
    cse_line: ($) => seq($.cse_tag, field("name", $.identifier)),

    // [NEW] Constructor (indent 4)
    new_tag: ($) => "[NEW]",
    new_line: ($) => seq($.new_tag, field("name", $.identifier)),

    // [RET] Return (indent 4)
    ret_tag: ($) => "[RET]",
    ret_line: ($) => seq($.ret_tag, choice(prec(2, $.dto_reference), $.type_name)),

    // [TYP] Type definition (indent 0)
    typ_tag: ($) => token(seq("[TYP", optional(seq(":", /[^\]]+/)), "]")),
    typ_line: ($) => seq($.typ_tag, $.typ_name, ":", $.typ_type),

    // [DTO] DTO definition (indent 0)
    dto_tag: ($) => token(seq("[DTO", optional(seq(":", /[^\]]+/)), "]")),
    dto_line: ($) => seq($.dto_tag, $.dto_def_name, ":", $.dto_prop, repeat(seq(",", optional($._ws), $.dto_prop))),

    // [NON] Noun declaration (indent 0)
    non_tag: ($) => token(seq("[NON", optional(seq(":", /[^\]]+/)), "]")),
    non_line: ($) => seq($.non_tag, field("name", $.identifier)),

    // [SRV] Service declaration (indent 0)
    srv_tag: ($) => "[SRV]",
    srv_line: ($) => seq($.srv_tag, $.srv_spec),
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
    http_route: ($) => token(seq("@", /\s+/, /[A-Za-z]+/, optional(seq(/\s+/, "/", /[^\s()]*/)))),

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

    _ws: ($) => /[\s]+/,

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

    // The boundary prefix is the external service_prefix token (`name:`, a
    // single colon — distinct from the `::` static separator, which the DFA
    // can't tell apart without the scanner's lookahead).
    boundary_line: ($) =>
      seq($.service_prefix, $.signature, optional(seq(":", $.return_type, optional($.value_name)))),

    // A fault line declares its kind by its first token, the registry's marker
    // (REQ-018): "! not-found timeout card-expired=402".
    // The names (each optionally =STATUS) are one line token: the engine's
    // lowering splits and validates them against the registry's fault shape.
    fault_marker: ($) => "!",
    fault_line: ($) => seq($.fault_marker, alias($.srv_spec, $.fault_list)),

    // [SRV] body: <transport>:<name>: <ENV, ...> consumed as one line token.
    srv_spec: ($) => token(/[^\n]+/),

    // `@docs <url>` — the required documentation link under an [SRV]. Its own
    // line rule (not a *_desc) so it parses cleanly instead of as an ERROR node;
    // the url reuses the greedy srv_spec token so a `//` inside it is NOT lexed
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

    dto_array_suffix: ($) => /\([a-z]+\??\)/,

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
