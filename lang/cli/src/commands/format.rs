//! Format command - formats a .rune file
//!
//! Indentation is presentation (REQ-033): a line's KIND comes from the grammar
//! (the tree-sitter CST, the one parser of record — REQ-032) and its COLUMN from
//! the registry's indent table. Nothing here decides what a line means by where
//! the author put it, with the one documented exception: nesting is relative —
//! a step the author indented deeper than its [PLY] belongs to the case, a
//! `[REQ]` indented under an [ENT] is that entrypoint's body.
//!
//! The formatter also carries the mechanical migrations of the language
//! changes: a pre-marker fault line is rewritten with the marker (REQ-018) and
//! `[CTR]` becomes `[NEW]` (REQ-021). Everything else is byte-preserved.

use std::fs;
use std::path::Path;
use std::sync::OnceLock;

use tree_sitter::{Node, Parser};

/// The registry, embedded: the indent table and the fault marker come from it,
/// never from a literal here.
const REGISTRY: &str = include_str!("../../../keywords.json");

struct Indent {
    step: usize,
    fault: usize,
    case: usize,
    case_step: usize,
    case_fault: usize,
    description: usize,
    body: usize,
}

struct Registry {
    indent: Indent,
    fault_marker: String,
}

fn registry() -> &'static Registry {
    static REG: OnceLock<Registry> = OnceLock::new();
    REG.get_or_init(|| {
        let v: serde_json::Value =
            serde_json::from_str(REGISTRY).expect("lang/keywords.json is valid JSON");
        let i = &v["indent"];
        let col = |k: &str| i[k].as_u64().expect("indent table column") as usize;
        Registry {
            indent: Indent {
                step: col("step"),
                fault: col("fault"),
                case: col("case"),
                case_step: col("caseStep"),
                case_fault: col("caseFault"),
                description: col("description"),
                body: col("body"),
            },
            fault_marker: v["faults"]["marker"]
                .as_str()
                .expect("faults.marker")
                .to_string(),
        }
    })
}

/// Format a .rune file
pub fn format(input_path: &Path, check_only: bool) -> Result<bool, String> {
    let content = fs::read_to_string(input_path)
        .map_err(|e| format!("Failed to read {}: {}", input_path.display(), e))?;

    let formatted = format_content(&content);

    if check_only {
        // Return true if already formatted, false if needs formatting
        Ok(content == formatted)
    } else {
        // Write formatted content
        fs::write(input_path, &formatted)
            .map_err(|e| format!("Failed to write {}: {}", input_path.display(), e))?;
        Ok(true)
    }
}

/// What a source line IS, as the grammar sees it (or, for a line the grammar
/// rejected, as its shape says).
#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    /// [MOD]/[DTO]/[TYP]/[NON]/[SRV] — a column-0 declaration with a prose body.
    Decl,
    Req,
    Ent,
    Ply,
    Cse,
    /// [NEW] / [RET] / a step / a boundary step.
    Step,
    Fault,
    /// A pre-marker fault line (REQ-018): rewritten with the marker.
    BareFault,
    Prose,
    Docs,
    /// A row inside a multi-line node (a wrapped parameter list): verbatim.
    Continuation,
    /// Nothing the grammar or the shape table knows: verbatim.
    Unknown,
}

/// The kind of every row, from one parse of the whole text. A row with an ERROR
/// node on it (or two nodes) is classified by shape instead, so a malformed
/// line never hides the lines below it.
fn kinds(content: &str) -> Vec<Kind> {
    let lines: Vec<&str> = content.lines().collect();
    let mut kinds = vec![Kind::Unknown; lines.len()];
    let mut decided = vec![false; lines.len()];
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_rune::LANGUAGE.into())
        .expect("the rune grammar loads");
    if let Some(tree) = parser.parse(content, None) {
        let root = tree.root_node();
        let mut per_row = vec![0usize; lines.len() + 1];
        let mut cursor = root.walk();
        for n in root.children(&mut cursor) {
            if n.kind() != "comment" {
                per_row[n.start_position().row] += 1;
            }
        }
        let mut cursor = root.walk();
        for n in root.children(&mut cursor) {
            if n.kind() == "comment" {
                continue;
            }
            let row = n.start_position().row;
            if row >= lines.len() || n.has_error() || per_row[row] > 1 {
                continue; // shape-classified below
            }
            kinds[row] = kind_of_node(&n);
            decided[row] = true;
            for r in row + 1..=n.end_position().row.min(lines.len() - 1) {
                kinds[r] = Kind::Continuation;
                decided[r] = true;
            }
        }
    }
    for (i, line) in lines.iter().enumerate() {
        if !decided[i] {
            kinds[i] = kind_of_shape(line.trim());
        }
    }
    kinds
}

fn kind_of_node(n: &Node) -> Kind {
    match n.kind() {
        "mod_line" | "dto_line" | "typ_line" | "non_line" | "srv_line" => Kind::Decl,
        "req_line" => Kind::Req,
        "ent_line" => Kind::Ent,
        "ply_line" => Kind::Ply,
        "cse_line" => Kind::Cse,
        "new_line" | "ret_line" | "step_line" | "boundary_line" => Kind::Step,
        "fault_line" => Kind::Fault,
        "typ_desc" | "dto_desc" | "non_desc" => Kind::Prose,
        "srv_docs_line" => Kind::Docs,
        _ => Kind::Unknown,
    }
}

/// A line the grammar rejected, by the tag it opens with (a malformed
/// declaration still sits where its tag sits), a retired `[CTR]`, or nothing.
fn kind_of_shape(trimmed: &str) -> Kind {
    if let Some(tag) = tag_of(trimmed) {
        return match tag {
            "MOD" | "DTO" | "TYP" | "NON" | "SRV" => Kind::Decl,
            "REQ" => Kind::Req,
            "ENT" => Kind::Ent,
            "PLY" => Kind::Ply,
            "CSE" => Kind::Cse,
            "NEW" | "RET" | "CTR" => Kind::Step,
            _ => Kind::Unknown,
        };
    }
    Kind::Unknown
}

/// `[TAG]` / `[TAG:mods]` at the start of a trimmed line → `TAG`.
fn tag_of(trimmed: &str) -> Option<&str> {
    let rest = trimmed.strip_prefix('[')?;
    let end = rest.find([']', ':'])?;
    let tag = &rest[..end];
    if !tag.is_empty() && tag.bytes().all(|b| b.is_ascii_uppercase()) {
        Some(tag)
    } else {
        None
    }
}

/// A pre-marker fault line: only slugs (`not-found`, `card-expired=402`).
fn is_bare_fault_line(trimmed: &str) -> bool {
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    !parts.is_empty()
        && parts.iter().all(|p| {
            let (name, status) = match p.split_once('=') {
                Some((n, s)) => (n, Some(s)),
                None => (*p, None),
            };
            name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
                && name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
                && status.is_none_or(|s| s.len() == 3 && s.bytes().all(|b| b.is_ascii_digit()))
        })
}

/// Format rune content
fn format_content(content: &str) -> String {
    let reg = registry();
    let ind = &reg.indent;
    let kinds = kinds(content);
    let pad = |n: usize, text: &str| format!("{}{}", " ".repeat(n), text);

    let mut out: Vec<String> = Vec::new();
    let mut consecutive_empty = 0;
    // The author's column of the open [PLY]: a step indented deeper belongs to
    // its case; one at or above it closes the block.
    let mut ply_col: Option<usize> = None;
    // After an [ENT] header, an indented [REQ] is its body line.
    let mut in_ent = false;
    // The author's column of the last step, so a bare fault line (deeper than
    // it) is told from prose after a step (at or above it).
    let mut last_step_col: Option<usize> = None;
    let mut last_step_in_case = false;
    // A prose line belongs to the declaration above it; prose after a step is
    // left where the author put it (the engine reports it).
    let mut in_decl = false;

    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        let orig_indent = line.len() - line.trim_start().len();

        if trimmed.is_empty() {
            consecutive_empty += 1;
            // Keep max 2 consecutive empty lines between REQs
            if consecutive_empty <= 2 {
                out.push(String::new());
            }
            in_decl = false;
            last_step_col = None;
            // A blank line is cosmetic inside a [PLY] body and an [ENT] body:
            // neither block closes here (the engine's lowering does the same).
            continue;
        }
        consecutive_empty = 0;

        // A comment line is emitted as written (trailing whitespace aside) and is
        // invisible to every piece of state below (REQ-002).
        if trimmed.starts_with("//") {
            out.push(line.trim_end().to_string());
            continue;
        }

        let mut kind = kinds[i];
        // The shape rules the CST cannot carry: a prose-looking line that is
        // really a pre-marker fault (deeper than the step above it, REQ-018).
        if matches!(kind, Kind::Prose | Kind::Unknown)
            && last_step_col.is_some_and(|c| orig_indent > c)
            && is_bare_fault_line(trimmed)
        {
            kind = Kind::BareFault;
        }

        match kind {
            Kind::Decl => {
                out.push(trimmed.to_string());
                in_decl = true;
                in_ent = false;
                ply_col = None;
                last_step_col = None;
            }
            Kind::Req => {
                if in_ent && orig_indent > 0 {
                    // the [ENT]'s body line
                    out.push(pad(ind.body, trimmed));
                } else {
                    out.push(trimmed.to_string());
                }
                in_ent = false;
                in_decl = false;
                ply_col = None;
                last_step_col = None;
            }
            Kind::Ent => {
                out.push(trimmed.to_string());
                in_ent = true;
                in_decl = false;
                ply_col = None;
                last_step_col = None;
            }
            Kind::Ply => {
                out.push(pad(ind.step, trimmed));
                ply_col = Some(orig_indent);
                in_decl = false;
                last_step_col = None;
                in_ent = false;
            }
            Kind::Cse => {
                out.push(pad(ind.case, trimmed));
                if ply_col.is_none() {
                    ply_col = Some(ind.step);
                }
                in_decl = false;
                last_step_col = None;
            }
            Kind::Step => {
                let text = match trimmed.strip_prefix("[CTR]") {
                    // REQ-021: one spelling per concept.
                    Some(rest) => format!("[NEW]{}", rest),
                    None => trimmed.to_string(),
                };
                let in_case = ply_col.is_some_and(|c| orig_indent > c);
                if !in_case {
                    ply_col = None;
                }
                out.push(pad(if in_case { ind.case_step } else { ind.step }, &text));
                last_step_col = Some(orig_indent);
                last_step_in_case = in_case;
                in_decl = false;
                in_ent = false;
            }
            Kind::Fault | Kind::BareFault => {
                let col = if last_step_in_case { ind.case_fault } else { ind.fault };
                let text = if kind == Kind::BareFault {
                    format!("{} {}", reg.fault_marker, trimmed)
                } else {
                    trimmed.to_string()
                };
                out.push(pad(col, &text));
            }
            Kind::Prose | Kind::Docs => {
                if in_decl {
                    out.push(pad(ind.description, trimmed));
                } else {
                    // prose nowhere a declaration is open: the engine's finding,
                    // not fmt's — leave the author's column.
                    out.push(line.trim_end().to_string());
                    last_step_col = None;
                }
            }
            Kind::Continuation | Kind::Unknown => {
                // Preserve original indentation for lines fmt does not own.
                out.push(line.trim_end().to_string());
                last_step_col = None;
            }
        }
    }

    // Remove trailing empty lines
    while out.last() == Some(&String::new()) {
        out.pop();
    }

    // Ensure final newline
    let mut result = out.join("\n");
    if !result.is_empty() {
        result.push('\n');
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn formats_req_at_column_zero() {
        let content = "   [REQ] test.run(In): Out";
        let formatted = format_content(content);
        assert!(formatted.starts_with("[REQ]"));
    }

    #[test]
    fn formats_steps_at_four_spaces() {
        let content = "[REQ] test.run(In): Out\nid::create(name): id";
        let formatted = format_content(content);
        assert!(formatted.contains("\n    id::create(name): id"));
    }

    #[test]
    fn formats_faults_at_six_spaces() {
        // A fault at any column under a step normalizes to the registry's fault
        // column; the marker declares the kind (REQ-018).
        let content = "[REQ] test.run(In): Out\n    db:storage.save(): void\n ! not-found";
        let formatted = format_content(content);
        assert!(formatted.contains("\n      ! not-found"), "got:\n{formatted}");
    }

    #[test]
    fn req_018_bare_fault_lines_are_rewritten_with_the_marker() {
        // The pre-marker form: slugs on a line deeper than the step. fmt is the
        // migration — it prefixes the marker; statuses and extra names survive.
        let content = "[REQ] test.run(In): Out\n    db:storage.save(): void\n        not-found timeout\n    x::y(): Out\n      card-expired=402\n";
        let formatted = format_content(content);
        assert_eq!(
            formatted,
            "[REQ] test.run(In): Out\n    db:storage.save(): void\n      ! not-found timeout\n    x::y(): Out\n      ! card-expired=402\n",
            "got:\n{formatted}"
        );
        // Already marked: untouched, and idempotent.
        assert_eq!(format_content(&formatted), formatted);
    }

    #[test]
    fn req_021_ctr_is_rewritten_to_new() {
        let content = "[REQ] test.run(In): Out\n    [CTR] widget\n    widget.toDto(): Out\n";
        let formatted = format_content(content);
        assert_eq!(
            formatted,
            "[REQ] test.run(In): Out\n    [NEW] widget\n    widget.toDto(): Out\n",
            "got:\n{formatted}"
        );
    }

    #[test]
    fn req_032_value_names_and_statuses_round_trip() {
        // A check-clean spec of the current language is a fixed point of fmt.
        let spec = "[MOD] tasks\n\n[REQ] task.complete(TaskRefDto): TaskDto\n    db:task.load(id): TaskDto as stored\n      ! not-found card-expired=402\n    task::fromDto(stored): task\n    task.toDto(): TaskDto\n    db:task.save(TaskDto): void\n      ! timeout\n    [RET] TaskDto\n\n[ENT] http.complete(TaskRefDto): TaskDto\n    [REQ] task.complete(TaskRefDto): TaskDto\n\n[DTO] TaskRefDto: id\n    a reference\n[DTO] TaskDto: id\n    a task\n[TYP] id: string\n    the id\n[NON] task\n    a task\n";
        assert_eq!(format_content(spec), spec, "got:\n{}", format_content(spec));
    }

    #[test]
    fn check_only_returns_false_for_unformatted() {
        let temp = tempdir().unwrap();
        let input_path = temp.path().join("example.rune");

        fs::write(&input_path, "   [REQ] test.run(In): Out").unwrap();

        let result = format(&input_path, true);
        assert!(result.is_ok());
        assert!(!result.unwrap()); // Should need formatting
    }

    #[test]
    fn check_only_returns_true_for_formatted() {
        let temp = tempdir().unwrap();
        let input_path = temp.path().join("example.rune");

        fs::write(&input_path, "[REQ] test.run(In): Out\n").unwrap();

        let result = format(&input_path, true);
        assert!(result.is_ok());
        assert!(result.unwrap()); // Should be formatted
    }

    #[test]
    fn normalizes_consecutive_empty_lines() {
        let content = "[REQ] a.run(In): Out\n\n\n\n\n[REQ] b.run(In): Out";
        let formatted = format_content(content);
        // Should have at most 2 empty lines between REQs
        assert!(!formatted.contains("\n\n\n\n"));
    }

    #[test]
    fn terminal_step_after_ply_stays_at_req_level() {
        // The REQ's final step sits at indent 4 right after a [PLY] block; it must
        // NOT be folded into the last [CSE] (which would change its meaning).
        let input = "[REQ] n.send(InDto): OutDto\n    [PLY] ch.deliver(InDto): OutDto\n        [CSE] email\n        ex:ch.mail(InDto): OutDto\n          ! timeout\n    n.toDto(): OutDto\n";
        let out = format_content(input);
        // the terminal step keeps 4 spaces; the case step stays at 8
        assert!(out.contains("\n    n.toDto(): OutDto"), "terminal step must stay at indent 4, got:\n{out}");
        assert!(out.contains("\n        ex:ch.mail(InDto): OutDto"), "case step must stay at indent 8");
        assert!(out.contains("\n          ! timeout"), "case fault must stay at indent 10");
    }

    #[test]
    fn r5_prose_after_step_is_not_treated_as_fault() {
        // Free-text prose after a step (all lowercase words, at the step's own
        // column) is not a fault: a fault sits deeper than its step. fmt leaves
        // it where the author put it (the engine reports the line).
        let input = "[REQ] r.run(InDto): OutDto\n    id::create(name): id\n    creates a brand new id\n";
        let out = format_content(input);
        assert!(
            out.contains("\n    creates a brand new id"),
            "prose after a step must stay at indent 4, got:\n{out}"
        );
        assert!(
            !out.contains("! creates"),
            "prose after a step must NOT become a fault, got:\n{out}"
        );
    }

    #[test]
    fn r2_blank_line_inside_poly_does_not_collapse_case() {
        // A blank line between two case steps is legal/cosmetic inside a [PLY]
        // body. It must NOT collapse the poly block: the case step after the
        // blank must stay at case level (8), not be re-indented to REQ level (4).
        let input = "[REQ] n.send(InDto): OutDto\n    [PLY] ch.deliver(InDto): OutDto\n        [CSE] email\n        ex:ch.mail(InDto): OutDto\n\n        ex:ch.log(InDto): OutDto\n";
        let out = format_content(input);
        assert!(
            out.contains("\n        ex:ch.log(InDto): OutDto"),
            "case step after a blank line must stay at indent 8, got:\n{out}"
        );
    }

    #[test]
    fn ent_block_indentation_is_preserved() {
        // The canonical [ENT] block — header at column 0, the dispatched [REQ]
        // indented 4 — round-trips unchanged.
        let input = "[ENT] http.getNote(RefDto): NoteDto\n    [REQ] note.get(RefDto): NoteDto\n";
        let out = format_content(input);
        assert_eq!(out, input, "got:\n{out}");
    }

    #[test]
    fn fmt_is_idempotent_on_ent_block() {
        let canonical = "[ENT] http.getNote(RefDto): NoteDto\n    [REQ] note.get(RefDto): NoteDto\n";
        let once = format_content(canonical);
        assert_eq!(once, canonical, "first pass changed a clean spec, got:\n{once}");
        let twice = format_content(&once);
        assert_eq!(twice, canonical, "fmt is not idempotent, got:\n{twice}");
    }

    #[test]
    fn top_level_req_after_ent_header_stays_at_column_zero() {
        // bare [ENT] headers, then a blank, then a TOP-LEVEL [REQ]. The post-blank
        // [REQ] (orig_indent 0) must NOT be sucked into the [ENT] body — it stays
        // at column 0; only an INDENTED [REQ] is a dispatch reference.
        let input = "[ENT] http.createOrder(NewOrderDto): OrderDto\n[ENT] http.payOrder(PayDto): ReceiptDto\n\n[REQ] order.create(NewOrderDto): OrderDto\n    db:order.save(OrderDto): void\n";
        let out = format_content(input);
        assert_eq!(out, input, "got:\n{out}");
    }

    #[test]
    fn ent_route_template_header_stays_at_column_zero() {
        // The `@ METHOD /template(...)` route-template header also carries a
        // `surface.action(...)` signature; it must stay at column 0, not be indented.
        let input = "[ENT] http.proxy @ POST /proxy/{target}/{path*}(ProxyReqDto): ProxyResDto\n    [REQ] proxy.run(ProxyReqDto): ProxyResDto\n\n[REQ] proxy.run(ProxyReqDto): ProxyResDto\n    noop::run(): void\n";
        let out = format_content(input);
        assert_eq!(out, input, "got:\n{out}");
    }

    #[test]
    fn description_with_punctuation_is_untouched() {
        // (sanity) descriptions are free text; the formatter shouldn't choke on them
        let input = "[DTO] FooDto: x\n    an alert to rafac@monsterrg.com e.g. WGS\n";
        let out = format_content(input);
        assert!(out.contains("rafac@monsterrg.com e.g. WGS"));
    }

    #[test]
    fn multi_line_parameter_lists_are_left_as_written() {
        // A wrapped parameter list is one step spanning rows; fmt owns the first
        // row's column and leaves the continuation rows alone.
        let input = "[REQ] a.b(I): O\n    x::y(\n      I,\n      J\n    ): O\n";
        let out = format_content(input);
        assert_eq!(out, input, "got:\n{out}");
    }

    // ---- REQ-001: every top-level declaration sits at column 0, modifier or not ----

    #[test]
    fn req_001_req_open_stays_at_column_zero() {
        // `[REQ:open]` is not `[REQ]` by prefix; the grammar knows the modifier
        // form, so it sits at column 0 like any requirement.
        let input = "[REQ:open] health.check({}): HealthDto\n    ex:nmi.ping(): HealthDto\n";
        let out = format_content(input);
        assert_eq!(out, input, "got:\n{out}");
        let messy = "    [REQ:open] health.check({}): HealthDto\n    ex:nmi.ping(): HealthDto\n";
        assert_eq!(format_content(messy), input, "a mis-indented [REQ:open] must come back to 0");
    }

    #[test]
    fn req_001_modified_dto_typ_non_stay_at_column_zero() {
        let input = "[DTO:core] HealthDto: ok\n    the answer\n[TYP:ext,uuid] cardId: string\n    a token\n[TYP:example=4111] pan: string\n    the pan\n[NON] clock\n    the clock\n";
        assert_eq!(format_content(input), input);
        let messy: String = input
            .lines()
            .map(|l| if l.starts_with('[') { format!("  {l}") } else { l.to_string() })
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        assert_eq!(format_content(&messy), input, "got:\n{}", format_content(&messy));
    }

    #[test]
    fn req_001_mod_and_srv_stay_at_column_zero() {
        let input = "[MOD] payments\n    the payments module\n\n[SRV] (HTTP)ex: EX_BASE_URL\n    the gateway\n    @docs https://docs.nmi.com/reference\n";
        assert_eq!(format_content(input), input);
        let messy = "  [MOD] payments\n    the payments module\n\n  [SRV] (HTTP)ex: EX_BASE_URL\n    the gateway\n    @docs https://docs.nmi.com/reference\n";
        assert_eq!(format_content(messy), input, "got:\n{}", format_content(messy));
    }

    // ---- REQ-002: fmt never touches a comment line ----

    #[test]
    fn req_002_column_zero_comment_after_a_body_stays_at_column_zero() {
        // A `//` line the author put at column 0 right after a block body stays
        // there: the parser skips comment lines outright, so their indent is the
        // author's alone.
        let input = "[TYP] ok: boolean\n    whether it answered\n// the gateway mints this\n[TYP:ext,uuid] cardId: string\n    a token\n";
        assert_eq!(format_content(input), input, "got:\n{}", format_content(input));
        let input2 = "[REQ] card.open(OpenCardDto): CardDto\n    card::toDto(pan): CardDto\n// charge a stored card\n[REQ] card.charge(ChargeDto): ReceiptDto\n    card::charge(ChargeDto): ReceiptDto\n";
        assert_eq!(format_content(input2), input2, "got:\n{}", format_content(input2));
    }

    #[test]
    fn req_002_indented_comment_keeps_its_indent() {
        let input = "[REQ] card.open(OpenCardDto): CardDto\n    ex:nmi.tokenise(pan): cardId\n      // the issuer said no\n      ! declined\n    // shape the response\n    card::toDto(cardId): CardDto\n";
        assert_eq!(format_content(input), input, "got:\n{}", format_content(input));
    }

    #[test]
    fn req_002_comment_between_step_and_fault_keeps_the_fault_a_fault() {
        // A comment is invisible to the parser, so a fault after it still belongs to
        // the step above. fmt must not let the comment reset its "after a step" state
        // and demote the fault to prose (indent 4).
        let input = "[REQ] card.open(OpenCardDto): CardDto\n    ex:nmi.tokenise(pan): cardId\n      // the issuer said no\n        ! declined\n";
        let out = format_content(input);
        assert!(out.contains("\n      ! declined\n"), "fault must normalize to 6, got:\n{out}");
    }
}
