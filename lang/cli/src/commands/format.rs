//! Format command - formats a .rune file

use std::fs;
use std::path::Path;

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

/// Format rune content
fn format_content(content: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut in_block = false;
    let mut consecutive_empty = 0;
    let mut after_step = false;
    // Are we inside a [PLY] block? Its case steps/faults nest one level deeper
    // (8/10). The block closes at a blank line, the next top-level declaration, a
    // [NEW]/[RET], or a step that returns to REQ level. We can't infer that from
    // the already-normalized output, so track it as state and use the AUTHOR'S
    // original indent to tell a case step (deep) from a step that closes the
    // block (shallow) — otherwise the REQ's terminal step gets folded into the
    // last [CSE], silently changing meaning.
    let mut in_poly = false;
    // Are we inside an `[ENT]`/`[ENT:ws]` block? The entrypoint header sits at column 0
    // and its body — the dispatched `[REQ]` (a regular `[ENT]`) or the indented
    // `verb(In): Out` topic lines (`[ENT:ws]`) — is indented 4. We track this as state
    // because a body `[REQ]` is indistinguishable from a top-level `[REQ]` by content
    // alone; the AUTHOR'S indent (orig_indent > 0) tells a body line from a new
    // top-level declaration, exactly like the in_poly handling. Without this, fmt
    // mistakes the header for a `surface.action(...)` step and indents it to 4 while
    // pulling the body `[REQ]` to column 0 — inverting the block, which demotes the
    // dispatch target to a duplicate top-level `[REQ]` and makes the next `rune check`
    // fail as "[ENT] ... is ambiguous — 2 [REQ]s share that signature".
    let mut in_ent = false;

    for line in content.lines() {
        let trimmed = line.trim();
        let orig_indent = line.len() - line.trim_start().len();

        if trimmed.is_empty() {
            consecutive_empty += 1;
            // Keep max 2 consecutive empty lines between REQs
            if consecutive_empty <= 2 {
                lines.push(String::new());
            }
            in_block = false;
            after_step = false;
            // Do NOT reset in_poly here: a blank line is legal/cosmetic inside a
            // [PLY] body, so it must not collapse the poly block. The block is
            // closed when the next non-blank step returns to REQ-level indent
            // (handled below via the `in_poly && orig_indent >= 6` check) or by a
            // [REQ]/[DTO]/[TYP]/[NON]/[NEW]/[RET] tag.
            continue;
        }

        consecutive_empty = 0;

        // A comment line is emitted as written (trailing whitespace aside) and is
        // invisible to every piece of state below. Both parsers skip `//` lines
        // outright — `rune check` never reads their indent — so re-indenting one only
        // rewrote the author's text, and letting it reset `after_step` demoted a fault
        // written under a comment to prose (REQ-002). A column-0 comment is the
        // author's section header; an indented one annotates whatever follows it.
        if trimmed.starts_with("//") {
            lines.push(line.trim_end().to_string());
            continue;
        }

        // [ENT] body dispatch. A `[REQ]` (regular `[ENT]`) or a `verb(In): Out` topic
        // (`[ENT:ws]`) line the author indented under the entrypoint header stays
        // indented 4 — it is the dispatch-target reference / ws topic, NOT a new
        // top-level declaration. A dedent to column 0, or any top-level `[tag]`, closes
        // the block and falls through to the normal formatting below. Blank lines do
        // not close it (they may visually group ws topics), mirroring the parser.
        if in_ent {
            let is_body_req = orig_indent > 0 && is_tag(trimmed, "REQ");
            let is_ws_topic = orig_indent > 0 && !trimmed.starts_with('[');
            if is_body_req || is_ws_topic {
                lines.push(format!("    {}", trimmed));
                after_step = false;
                continue;
            }
            in_ent = false;
        }

        // Normalize line based on content. Tags are matched with `is_tag`, which
        // accepts the `[TAG:modifier]` forms the parser does (`[REQ:open]`,
        // `[DTO:core]`, `[TYP:ext,uuid]`, `[ENT:ws]`, …). A bare
        // `starts_with("[REQ]")` let `[REQ:open]` fall through to the step heuristic
        // and land at indent 4 — which the parser, trimming the line, then accepted
        // without a word (REQ-001).
        if is_tag(trimmed, "REQ") {
            // REQ at column 0
            lines.push(trimmed.to_string());
            in_block = true;
            after_step = false;
            in_poly = false;
        } else if is_tag(trimmed, "ENT") {
            // [ENT]/[ENT:ws]/[ENT:card]/… entrypoint header at column 0; its body (the
            // dispatched [REQ], or [ENT:ws] topics) is indented 4 and consumed by the
            // in_ent block above. This branch MUST precede is_step_line(): the header
            // carries a `surface.action(...)` signature, so without it fmt mistakes the
            // header for a step (indent 4) and pulls the body [REQ] to column 0 —
            // inverting the block and creating a duplicate top-level [REQ].
            lines.push(trimmed.to_string());
            in_block = false;
            after_step = false;
            in_poly = false;
            in_ent = true;
        } else if DEFINITION_TAGS.iter().any(|tag| is_tag(trimmed, tag)) {
            // Definitions at column 0 — [DTO]/[TYP]/[NON] and the file-level [MOD]/
            // [SRV] declarations, with or without a modifier. Their indented prose
            // (a description, a [SRV]'s `@docs` line) follows at 4.
            lines.push(trimmed.to_string());
            in_block = true;
            after_step = false;
            in_poly = false;
        } else if trimmed.starts_with("[PLY]") {
            // Opens a polymorphic block; the tag itself sits at REQ-step level (4).
            lines.push(format!("    {}", trimmed));
            after_step = false;
            in_poly = true;
        } else if trimmed.starts_with("[NEW]") || trimmed.starts_with("[RET]") {
            // REQ-level tags at 4 spaces; they close any open poly block.
            lines.push(format!("    {}", trimmed));
            after_step = false;
            in_poly = false;
        } else if trimmed.starts_with("[CSE]") {
            // A case only appears inside a [PLY] block — at 8 spaces.
            lines.push(format!("        {}", trimmed));
            after_step = false;
            in_poly = true;
        } else if is_step_line(trimmed) {
            // A step is 8 spaces only when it's genuinely nested in a poly case —
            // i.e. the author indented it past REQ level. A step at REQ level
            // (shallow) closes the block and stays at 4, even right after a [PLY].
            let indent = if in_poly && orig_indent >= 6 {
                8
            } else {
                in_poly = false;
                4
            };
            lines.push(format!("{}{}", " ".repeat(indent), trimmed));
            after_step = true;
        } else if after_step && orig_indent >= 6 && is_fault_line(trimmed) {
            // Faults at 6 spaces (or 10 inside a poly case). Only a line that the
            // author ALREADY placed at fault level (indent >= 6) is treated as a
            // fault — this mirrors the parser, which only recognizes a Fault at
            // actual_indent >= 6 (parser lib.rs). Free-text prose after a step
            // (typically at the description indent 4) is all-lowercase too, so
            // without this guard it would be misclassified as a fault and
            // re-indented to 6, fabricating fault names and changing meaning.
            let indent = if in_poly { 10 } else { 6 };
            lines.push(format!("{}{}", " ".repeat(indent), trimmed));
        } else if in_block && !trimmed.contains(':') {
            // Description lines at 4 spaces (comments were emitted verbatim above)
            lines.push(format!("    {}", trimmed));
            after_step = false;
        } else {
            // Preserve original indentation for unknown lines
            lines.push(line.to_string());
            after_step = false;
        }
    }

    // Remove trailing empty lines
    while lines.last() == Some(&String::new()) {
        lines.pop();
    }

    // Ensure final newline
    let mut result = lines.join("\n");
    if !result.is_empty() {
        result.push('\n');
    }

    result
}

/// The column-0 declarations besides [REQ]/[ENT]: data definitions plus the
/// file-level module and service declarations.
const DEFINITION_TAGS: [&str; 5] = ["DTO", "TYP", "NON", "MOD", "SRV"];

/// Does `s` open with `[TAG]` or `[TAG:modifier…]`? Mirrors the parser's
/// `match_tag` (lang/parser), which accepts a `:modifier` on every top-level tag —
/// `[REQ:open]`, `[DTO:core]`, `[TYP:ext,uuid]`, `[TYP:example=…]`, `[ENT:ws]`.
/// `[REQUIRE]` is not `[REQ]`: the tag must be closed by `]` or followed by `:`.
fn is_tag(s: &str, tag: &str) -> bool {
    match s.strip_prefix('[').and_then(|rest| rest.strip_prefix(tag)) {
        Some(rest) => rest.starts_with(']') || rest.starts_with(':'),
        None => false,
    }
}

fn is_step_line(s: &str) -> bool {
    let boundary_prefixes = ["db:", "fs:", "mq:", "ex:", "os:", "lg:"];
    for prefix in boundary_prefixes {
        if s.starts_with(prefix) {
            return true;
        }
    }
    (s.contains('.') || s.contains("::")) && s.contains('(') && s.contains(')')
}

fn is_fault_line(s: &str) -> bool {
    let parts: Vec<&str> = s.split_whitespace().collect();
    !parts.is_empty() && parts.iter().all(|p| {
        p.chars().all(|c| c.is_lowercase() || c.is_numeric() || c == '-')
            && p.chars().next().map(|c| c.is_lowercase()).unwrap_or(false)
    })
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
        // A fault the author placed at a real fault position (indent >= 6)
        // normalizes to exactly 6 spaces. (We do NOT promote an indent-0 line to
        // a fault — that would fabricate faults from prose; see R5. The parser
        // only recognizes a Fault at actual_indent >= 6.)
        let content = "[REQ] test.run(In): Out\n    db:storage.save(): void\n        not-found";
        let formatted = format_content(content);
        assert!(formatted.contains("\n      not-found"), "got:\n{formatted}");
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
        let input = "[REQ] n.send(InDto): OutDto\n    [PLY] ch.deliver(InDto): OutDto\n        [CSE] email\n        ex:ch.mail(InDto): OutDto\n          timeout\n    n.toDto(): OutDto\n";
        let out = format_content(input);
        // the terminal step keeps 4 spaces; the case step stays at 8
        assert!(out.contains("\n    n.toDto(): OutDto"), "terminal step must stay at indent 4, got:\n{out}");
        assert!(out.contains("\n        ex:ch.mail(InDto): OutDto"), "case step must stay at indent 8");
    }

    #[test]
    fn r5_prose_after_step_is_not_treated_as_fault() {
        // Free-text prose after a step (all lowercase words, originally at the
        // description indent 4) must be treated as a description (indent 4), not
        // misclassified as a fault and re-indented to 6.
        let input = "[REQ] r.run(InDto): OutDto\n    id::create(name): id\n    creates a brand new id\n";
        let out = format_content(input);
        assert!(
            out.contains("\n    creates a brand new id"),
            "prose after a step must stay at description indent 4, got:\n{out}"
        );
        assert!(
            !out.contains("\n      creates a brand new id"),
            "prose after a step must NOT be re-indented to fault level 6, got:\n{out}"
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
        // The reported regression: the canonical [ENT] block — header at column 0, the
        // dispatched [REQ] indented 4 — must round-trip unchanged. Before the fix fmt
        // inverted it (header -> 4, body [REQ] -> 0), demoting the body to a duplicate
        // top-level [REQ] that `rune check` rejected as "ambiguous".
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
        // entrypoint.rune shape: bare [ENT] headers, then a blank, then a TOP-LEVEL
        // [REQ]. The post-blank [REQ] (orig_indent 0) must NOT be sucked into the [ENT]
        // body — it stays at column 0; only an INDENTED [REQ] is a dispatch reference.
        let input = "[ENT] http.createOrder(NewOrderDto): OrderDto\n[ENT] http.payOrder(PayDto): ReceiptDto\n\n[REQ] order.create(NewOrderDto): OrderDto\n    db:order.save(OrderDto): void\n";
        let out = format_content(input);
        assert_eq!(out, input, "got:\n{out}");
    }

    #[test]
    fn ent_ws_socket_topics_indent_to_four() {
        // [ENT:ws] header at column 0; its `verb(In): Out` topics (no leading bracket,
        // no `.`) normalize to indent 4 — they would otherwise be left untouched.
        let input = "[ENT:ws] chat @ /rooms/{room}\n    join(JoinDto): JoinedDto\n    leave(LeaveDto): void\n";
        let out = format_content(input);
        assert_eq!(out, input, "got:\n{out}");
        // and a mis-indented topic is pulled back to 4
        let messy = "[ENT:ws] chat @ /rooms/{room}\n        join(JoinDto): JoinedDto\n";
        let fixed = format_content(messy);
        assert_eq!(fixed, "[ENT:ws] chat @ /rooms/{room}\n    join(JoinDto): JoinedDto\n", "got:\n{fixed}");
    }

    #[test]
    fn ent_route_template_header_stays_at_column_zero() {
        // The `@ METHOD /template(...)` route-template header also carries a
        // `surface.action(...)` signature; it must stay at column 0, not be indented.
        let input = "[ENT] http.proxy @ POST /proxy/{target}/{path*}(ProxyReqDto): ProxyResDto\n\n[REQ] proxy.run(ProxyReqDto): ProxyResDto\n    noop::run(): void\n";
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

    // ---- REQ-001: every top-level declaration sits at column 0, modifier or not ----

    #[test]
    fn req_001_req_open_stays_at_column_zero() {
        // The reported corruption (coms 20260921T050158Z-w15-47057): `[REQ:open]` is
        // not `[REQ]` by prefix, so fmt took it for a `surface.action(...)` step and
        // indented it to 4 — silently, since the parser trims the line and `rune
        // check` still accepted it.
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
        // The reported corruption: a `//` line the author put at column 0 right after
        // a block body (no blank line between) was re-indented to 4 as if it were the
        // block's description. The parser skips comment lines outright, so their
        // indent is the author's — fmt has nothing to normalize.
        let input = "[TYP] ok: boolean\n    whether it answered\n// the gateway mints this\n[TYP:ext,uuid] cardId: string\n    a token\n";
        assert_eq!(format_content(input), input, "got:\n{}", format_content(input));
        let input2 = "[REQ] card.open(OpenCardDto): CardDto\n    card::toDto(pan): CardDto\n// charge a stored card\n[REQ] card.charge(ChargeDto): ReceiptDto\n    card::charge(ChargeDto): ReceiptDto\n";
        assert_eq!(format_content(input2), input2, "got:\n{}", format_content(input2));
    }

    #[test]
    fn req_002_indented_comment_keeps_its_indent() {
        let input = "[REQ] card.open(OpenCardDto): CardDto\n    ex:nmi.tokenise(pan): cardId\n      // the issuer said no\n      declined\n    // shape the response\n    card::toDto(cardId): CardDto\n";
        assert_eq!(format_content(input), input, "got:\n{}", format_content(input));
    }

    #[test]
    fn req_002_comment_between_step_and_fault_keeps_the_fault_a_fault() {
        // A comment is invisible to the parser, so a fault after it still belongs to
        // the step above. fmt must not let the comment reset its "after a step" state
        // and demote the fault to prose (indent 4).
        let input = "[REQ] card.open(OpenCardDto): CardDto\n    ex:nmi.tokenise(pan): cardId\n      // the issuer said no\n        declined\n";
        let out = format_content(input);
        assert!(out.contains("\n      declined\n"), "fault must normalize to 6, got:\n{out}");
    }
}
