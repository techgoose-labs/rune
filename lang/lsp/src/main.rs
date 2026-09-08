use ropey::Rope;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::*;
use tower_lsp::{Client, LanguageServer, LspService, Server};

use rune_parser::{parse_document, LineKind};

#[derive(Debug)]
struct Backend {
    client: Client,
    documents: Arc<RwLock<std::collections::HashMap<Url, Rope>>>,
}

/// The authoritative full-document text for a `textDocument/didChange` under
/// TextDocumentSyncKind::FULL. Each change carries the full new document and the
/// spec says changes apply in receive order, so the LAST change wins. Returns
/// `None` only when the notification carries no changes.
fn full_sync_text(changes: Vec<TextDocumentContentChangeEvent>) -> Option<String> {
    changes.into_iter().last().map(|c| c.text)
}

/// The project's shared [SRV] service names for the spec at `uri`. Mirrors the
/// engine's `resolveRoot` + `loadCoreSrvs`:
///   - root = the dir above the canonical `spec/runes/` staging dir or a singular
///     `spec/` folder, else the dir above an outermost `src/<module>/`, else the
///     spec's own dir;
///   - core spec = the FIRST readable of `src/core/core.rune`, the `spec/runes/`
///     staging dir (`spec/runes/core.rune`, `specs/runes/core.rune`), the legacy
///     flat `spec/core.rune` / `specs/core.rune`, flat `core.rune`, then the
///     `.in-prog.rune` draft variants of each (a draft core still supplies shared
///     services while it is iterated on — finalized core, listed first, wins when
///     both exist).
/// Best-effort + filesystem-based; returns an empty set when there's no core spec.
fn core_services_for(uri: &Url) -> HashSet<String> {
    let mut out = HashSet::new();
    let Ok(path) = uri.to_file_path() else {
        return out;
    };
    let Some(spec_dir) = path.parent() else {
        return out;
    };
    let dir_name = |p: &std::path::Path| {
        p.file_name().and_then(|n| n.to_str()).map(|s| s.to_string())
    };
    // resolveRoot: the canonical `spec/runes/` staging dir (root is two levels up,
    // past `runes/` and `spec/`) or a singular `spec/` folder (root is its parent)
    // is the project's staging dir; a spec already moved into `src/<module>/`
    // resolves to the dir above that `src/`; otherwise the spec's own dir is root.
    let root = if dir_name(spec_dir).as_deref() == Some("runes")
        && spec_dir.parent().and_then(dir_name).as_deref() == Some("spec")
    {
        spec_dir.parent().unwrap().parent().unwrap().to_path_buf()
    } else if dir_name(spec_dir).as_deref() == Some("spec") {
        spec_dir.parent().unwrap().to_path_buf()
    } else if spec_dir.parent().and_then(dir_name).as_deref() == Some("src") {
        spec_dir.parent().unwrap().parent().unwrap().to_path_buf()
    } else {
        spec_dir.to_path_buf()
    };
    for cand in [
        root.join("src/core/core.rune"),
        root.join("spec/runes/core.rune"),
        root.join("specs/runes/core.rune"),
        root.join("spec/core.rune"),
        root.join("specs/core.rune"),
        root.join("core.rune"),
        root.join("src/core/core.in-prog.rune"),
        root.join("spec/runes/core.in-prog.rune"),
        root.join("specs/runes/core.in-prog.rune"),
        root.join("spec/core.in-prog.rune"),
        root.join("specs/core.in-prog.rune"),
        root.join("core.in-prog.rune"),
    ] {
        if cand == path {
            continue; // never load the file being checked as its own core
        }
        if let Ok(text) = std::fs::read_to_string(&cand) {
            for l in parse_document(&text) {
                if let LineKind::Srv { name, .. } = l.kind {
                    out.insert(name);
                }
            }
            if !out.is_empty() {
                break;
            }
        }
    }
    out
}

impl Backend {
    fn new(client: Client) -> Self {
        Self {
            client,
            documents: Arc::new(RwLock::new(std::collections::HashMap::new())),
        }
    }

    // Diagnostics mirror what `rune sync`/`manifest` (the TS parser) actually
    // enforces: structure + the documented shape rules. They deliberately do NOT
    // invent scope/usage rules — the generator performs none, and the valid
    // corpus exercises specs those rules would wrongly reject (e.g. instance
    // nouns that are never "produced"). Keeping the LSP in lock-step with the
    // generator is what makes it trustworthy.
    async fn validate(&self, uri: &Url) {
        let docs = self.documents.read().await;
        let Some(rope) = docs.get(uri) else { return };
        let text = rope.to_string();
        drop(docs);

        let core_services = core_services_for(uri);
        let diagnostics = Self::compute_diagnostics(&text, &core_services);

        self.client
            .publish_diagnostics(uri.clone(), diagnostics, None)
            .await;
    }

    /// Pure diagnostic computation, split out of the publish-to-client path so
    /// the corpus-parity tests can drive validation directly. Mirrors what
    /// `rune sync`/`manifest` enforces.
    fn compute_diagnostics(text: &str, core_services: &HashSet<String>) -> Vec<Diagnostic> {
        let lines = parse_document(text);
        let mut diagnostics = Vec::new();

        // Service-presence: every boundary `service:noun.verb(...)` must resolve
        // to a declared [SRV] — local, or shared from the project's core.rune
        // (passed in by validate(); empty in the pure/test path, where corpus
        // files declare their services locally). Mirrors strict `rune check`.
        let mut declared: HashSet<String> = core_services.clone();
        for l in &lines {
            if let LineKind::Srv { name, .. } = &l.kind {
                declared.insert(name.clone());
            }
        }
        for l in &lines {
            if let LineKind::BoundaryStep { prefix, .. } = &l.kind {
                let svc = prefix.trim_end_matches(':');
                if !declared.contains(svc) {
                    diagnostics.push(diag_err(
                        l.line_num,
                        format!(
                            "undeclared service \"{}\" — declare it as `[SRV] (TRANSPORT){}: <ENV,…>` in src/core/core.rune",
                            svc, svc
                        ),
                    ));
                }
            }
        }

        // 80 column limit. Count CHARACTERS, not bytes — a multibyte char (e.g.
        // an em-dash, 1 char / 3 UTF-8 bytes) must not be counted as 3 columns,
        // else a line that is exactly 80 columns wide false-positives. Mirrors the
        // engine, which measures display width in characters.
        for (line_num, line) in text.lines().enumerate() {
            let cols = line.chars().count();
            if cols > 80 {
                diagnostics.push(Diagnostic {
                    range: Range {
                        start: Position { line: line_num as u32, character: 80 },
                        end: Position { line: line_num as u32, character: cols as u32 },
                    },
                    severity: Some(DiagnosticSeverity::ERROR),
                    message: format!("Line exceeds 80 columns ({} chars)", cols),
                    ..Default::default()
                });
            }
        }

        // Every [SRV] MUST declare an `@docs <url>` line (mirrors `rune check`):
        // scan each [SRV]'s block for a non-empty `@docs` line; flag the [SRV] if
        // none is found before the block closes (a blank line or the next tag).
        for (idx, pl) in lines.iter().enumerate() {
            if let LineKind::Srv { name, .. } = &pl.kind {
                let mut has_docs = false;
                for next in &lines[idx + 1..] {
                    match &next.kind {
                        LineKind::SrvDocs { url, .. } if !url.trim().is_empty() => {
                            has_docs = true;
                            break;
                        }
                        // empty `@docs` (flagged separately) / description prose /
                        // comments keep the [SRV] block open — keep scanning.
                        LineKind::SrvDocs { .. }
                        | LineKind::Prose { .. }
                        | LineKind::Comment { .. } => continue,
                        // a blank line or any other tag closes the block.
                        _ => break,
                    }
                }
                if !has_docs {
                    diagnostics.push(diag_err(
                        pl.line_num,
                        format!("[SRV] {} requires an @docs <url> line", name),
                    ));
                }
            }
        }

        // Definitions collected in the first pass (shape checks only — no usage).
        let mut seen_reqs: HashSet<String> = HashSet::new();
        let mut defined_dtos: HashSet<String> = HashSet::new();
        let mut defined_dtos_lines: HashMap<String, usize> = HashMap::new();
        let mut defined_types: HashMap<String, String> = HashMap::new();
        let mut defined_types_lines: HashMap<String, usize> = HashMap::new();
        let mut defined_nouns_lines: HashMap<String, usize> = HashMap::new();
        let mut dto_has_desc: HashSet<String> = HashSet::new();
        let mut dto_properties: HashMap<String, Vec<(usize, String)>> = HashMap::new();
        let mut last_dto_name: Option<String> = None;
        let mut first_pass_dto: Option<String> = None;

        // First pass: collect DTO/TYP/NON definitions, DTO properties, descriptions.
        for parsed_line in &lines {
            let line_num = parsed_line.line_num;
            match &parsed_line.kind {
                LineKind::DtoDef { name, properties } => {
                    if let Some(&first) = defined_dtos_lines.get(name) {
                        diagnostics.push(diag_err(line_num, format!(
                            "Duplicate DTO definition '{}' (first defined on line {})",
                            name, first + 1)));
                    } else {
                        defined_dtos.insert(name.clone());
                        defined_dtos_lines.insert(name.clone(), line_num);
                    }
                    for prop in properties {
                        let base = prop.trim_end_matches('?');
                        let pname = match base.find('(') {
                            Some(p) => base[..p].to_string(),
                            None => base.to_string(),
                        };
                        dto_properties.entry(name.clone()).or_default().push((line_num, pname));
                    }
                    first_pass_dto = Some(name.clone());
                    last_dto_name = Some(name.clone());
                }
                LineKind::DtoProperty { name, .. } => {
                    if let Some(d) = &first_pass_dto {
                        dto_properties.entry(d.clone()).or_default().push((line_num, name.clone()));
                    }
                }
                LineKind::DtoArrayProperty { property_name, .. } => {
                    if let Some(d) = &first_pass_dto {
                        dto_properties.entry(d.clone()).or_default().push((line_num, property_name.clone()));
                    }
                }
                LineKind::DtoDesc { .. } => {
                    if let Some(d) = &last_dto_name {
                        dto_has_desc.insert(d.clone());
                    }
                }
                LineKind::Empty => {
                    first_pass_dto = None;
                }
                LineKind::TypDef { name, type_name, .. } => {
                    if let Some(&first) = defined_types_lines.get(name) {
                        diagnostics.push(diag_err(line_num, format!(
                            "Duplicate type definition '{}' (first defined on line {})",
                            name, first + 1)));
                    } else {
                        defined_types.insert(name.clone(), type_name.clone());
                        defined_types_lines.insert(name.clone(), line_num);
                    }
                }
                LineKind::NonDef { name } => {
                    if let Some(&first) = defined_nouns_lines.get(name) {
                        diagnostics.push(diag_err(line_num, format!(
                            "Duplicate noun definition '{}' (first defined on line {})",
                            name, first + 1)));
                    } else {
                        defined_nouns_lines.insert(name.clone(), line_num);
                    }
                }
                _ => {}
            }
        }

        // Every property used in a [DTO] must resolve to a declared type — a
        // [TYP], a nested [DTO] (direct name or the <Name>Dto convention). Mirrors
        // the TS parser's check so the LSP flags the same missing-TYP errors.
        for (dto_name, props) in &dto_properties {
            for (prop_line, pname) in props {
                let resolved = defined_types.contains_key(pname)
                    || defined_dtos.contains(pname)
                    || defined_dtos.contains(&format!("{}Dto", to_pascal(pname)));
                if !resolved {
                    diagnostics.push(diag_err(*prop_line, format!(
                        "[DTO] {}: property \"{}\" has no [TYP] or [DTO] — declare \"[TYP] {}: <type>\"",
                        dto_name, pname, pname)));
                }
            }
        }

        // Second-pass state.
        let mut method_signatures: HashMap<String, (usize, Vec<String>, String)> = HashMap::new();
        let mut poly_stack: Vec<usize> = Vec::new(); // indents of open [PLY] scopes
        let mut in_req = false;
        // True while we are in an [ENT]'s dispatch body: an [ENT] line is followed
        // by an INDENTED `[REQ] noun.verb(...)` that REFERENCES the [REQ] it
        // dispatches to (the documented form, spec.md §[ENT]). That reference is
        // not a declaration, so it must not be flagged as misplaced or duplicate.
        let mut in_ent = false;
        let mut last_step_indent: Option<usize> = None;
        let mut last_was_req = false;
        let mut consecutive_empty: usize = 0;

        // Second pass: structure + shape validation.
        for parsed_line in &lines {
            let line_num = parsed_line.line_num;

            // Close [PLY] scopes whose body has ended (indentation dropped to/below
            // the [PLY] line). Faults and tags handle their own scope, so only
            // step-like lines participate here.
            if let Some(li) = step_like_indent(&parsed_line.kind) {
                while let Some(&p) = poly_stack.last() {
                    if li <= p {
                        poly_stack.pop();
                    } else {
                        break;
                    }
                }
            }
            let depth = poly_stack.len();
            let step_expected = if depth == 0 { 4 } else { poly_stack.last().unwrap() + 4 };

            match &parsed_line.kind {
                LineKind::Mod { .. } => {
                    in_req = false;
                    in_ent = false;
                    poly_stack.clear();
                    last_was_req = false;
                    consecutive_empty = 0;
                }

                LineKind::Ent { input, output, indent, method, .. } => {
                    if *indent != 0 {
                        diagnostics.push(diag_err(line_num, "[ENT] must start at column 0".to_string()));
                    }
                    if !input.is_empty() && !input.ends_with("Dto") && !input.starts_with('{') {
                        diagnostics.push(diag_err(line_num, format!("[ENT] input must be a DTO, got '{}'", input)));
                    }
                    if !output.ends_with("Dto") {
                        diagnostics.push(diag_err(line_num, format!("[ENT] output must be a DTO, got '{}'", output)));
                    }
                    // An explicit `@ METHOD` must name a real HTTP verb (mirrors the TS engine).
                    if let Some(m) = method {
                        if !matches!(m.as_str(), "get" | "post" | "put" | "patch" | "delete") {
                            diagnostics.push(diag_err(
                                line_num,
                                format!(
                                    "[ENT] HTTP method must be one of GET, POST, PUT, PATCH, DELETE (got \"{}\")",
                                    m.to_uppercase()
                                ),
                            ));
                        }
                    }
                    in_req = false;
                    in_ent = true;
                    poly_stack.clear();
                    last_was_req = false;
                    consecutive_empty = 0;
                }

                LineKind::Req { noun, verb, input, output, indent, modifier, .. } => {
                    // An INDENTED [REQ] directly under an [ENT] is that entrypoint's
                    // dispatch reference, not a new declaration — the engine accepts
                    // it, so skip the column/duplicate checks to stay in lock-step.
                    if in_ent && *indent != 0 {
                        continue;
                    }
                    in_ent = false;
                    if let Some(m) = modifier {
                        // Parity with the TS parser. `:open` is the OPENNESS
                        // MARKER — the one modifier [REQ] takes: it declares
                        // that this endpoint is reachable without a credential,
                        // and codegen emits it as `x-bedrock-auth: {access}` on
                        // the operation, which is where the backend's policy
                        // table comes from. Unmarked means authenticated, the
                        // slot default — openness is stated, never inferred.
                        if m == "open" {
                            // valid
                        } else if m == "core" {
                            diagnostics.push(diag_err(line_num, "[REQ:core] is invalid — coordinators are module-level".to_string()));
                        } else {
                            diagnostics.push(diag_err(line_num, format!("[REQ] unknown modifier \"{}\" — the only one is :open", m)));
                        }
                    }
                    if *indent != 0 {
                        diagnostics.push(diag_err(line_num, "[REQ] must start at column 0".to_string()));
                    }
                    let key = format!("{}.{}", noun, verb);
                    if seen_reqs.contains(&key) {
                        diagnostics.push(diag_err(line_num, format!("Duplicate REQ: {}", key)));
                    }
                    seen_reqs.insert(key);
                    if !input.is_empty() && !input.ends_with("Dto") && !input.starts_with('{') {
                        diagnostics.push(diag_err(line_num, format!("REQ input must be a DTO, got '{}'", input)));
                    }
                    if !output.ends_with("Dto") {
                        diagnostics.push(diag_err(line_num, format!("REQ output must be a DTO, got '{}'", output)));
                    }
                    if last_was_req && consecutive_empty < 2 {
                        diagnostics.push(diag_warn(line_num, "Expected double blank line between requirements".to_string()));
                    }
                    in_req = true;
                    poly_stack.clear();
                    last_step_indent = None;
                    last_was_req = true;
                    consecutive_empty = 0;
                }

                LineKind::Step { noun, verb, indent, params, output, is_static } => {
                    if !in_req {
                        diagnostics.push(diag_err(line_num, "Step outside [REQ]".to_string()));
                        continue;
                    }
                    if *indent != step_expected {
                        diagnostics.push(diag_err(line_num, format!("Step should be indented {} spaces, got {}", step_expected, indent)));
                    }
                    check_sig(&mut diagnostics, &mut method_signatures, line_num, noun, verb, *is_static, params, output);
                    if output.is_empty() {
                        diagnostics.push(diag_err(line_num, "Step missing return type".to_string()));
                    }
                    last_step_indent = Some(*indent);
                    last_was_req = false;
                    consecutive_empty = 0;
                }

                LineKind::BoundaryStep { prefix, noun, verb, indent, params, output, is_static } => {
                    if !in_req {
                        diagnostics.push(diag_err(line_num, "Boundary step outside [REQ]".to_string()));
                        continue;
                    }
                    if *indent != step_expected {
                        diagnostics.push(diag_err(line_num, format!("Boundary step should be indented {} spaces, got {}", step_expected, indent)));
                    }
                    check_sig(&mut diagnostics, &mut method_signatures, line_num, noun, verb, *is_static, params, output);
                    // The service name (any lowercase prefix) is validated for
                    // PRESENCE below against declared [SRV]s + core.rune — no
                    // fixed prefix allowlist anymore.
                    for param in params {
                        if !is_dto_or_primitive(param, &defined_types) {
                            diagnostics.push(diag_err(line_num, format!("{} boundary parameter must be a DTO or primitive, got '{}'", prefix, param)));
                        }
                    }
                    if !is_dto_or_primitive(output, &defined_types) {
                        diagnostics.push(diag_err(line_num, format!("{} boundary must return a DTO or primitive, got '{}'", prefix, output)));
                    }
                    last_step_indent = Some(*indent);
                    last_was_req = false;
                    consecutive_empty = 0;
                }

                LineKind::Fault { indent, .. } => {
                    if last_step_indent.is_none() {
                        diagnostics.push(diag_err(line_num, "Orphan fault: not under a step".to_string()));
                    } else {
                        let expected = last_step_indent.unwrap() + 2;
                        if *indent != expected {
                            diagnostics.push(diag_err(line_num, format!("Fault should be indented {} spaces (2 more than step), got {}", expected, indent)));
                        }
                    }
                    last_was_req = false;
                    consecutive_empty = 0;
                }

                LineKind::Ply { noun, verb, params, output, indent, is_static } => {
                    if !in_req {
                        diagnostics.push(diag_err(line_num, "[PLY] outside [REQ]".to_string()));
                        continue;
                    }
                    if *indent != step_expected {
                        diagnostics.push(diag_err(line_num, format!("[PLY] should be indented {} spaces, got {}", step_expected, indent)));
                    }
                    check_sig(&mut diagnostics, &mut method_signatures, line_num, noun, verb, *is_static, params, output);
                    poly_stack.push(*indent);
                    last_step_indent = Some(*indent);
                    last_was_req = false;
                    consecutive_empty = 0;
                }

                LineKind::Cse { name, indent: _ } => {
                    if poly_stack.is_empty() {
                        diagnostics.push(diag_err(line_num, format!("[CSE] {} must be inside a [PLY] block", name)));
                    }
                    // Indent is NOT strictly checked — the TS engine (the source
                    // of truth for `rune check`) accepts [CSE] at any indent
                    // deeper than its [PLY], so the LSP must not flag it either.
                    last_step_indent = None;
                    last_was_req = false;
                    consecutive_empty = 0;
                }

                LineKind::DtoDef { name, .. } => {
                    if !name.ends_with("Dto") {
                        diagnostics.push(diag_err(line_num, format!("DTO name '{}' must end in 'Dto'", name)));
                    }
                    in_req = false;
                    poly_stack.clear();
                    last_step_indent = None;
                    last_was_req = false;
                    consecutive_empty = 0;
                }

                LineKind::TypDef { name, type_name, modifier } => {
                    if let Some(m) = modifier {
                        for msg in validate_typ_modifiers(m, name, type_name) {
                            diagnostics.push(diag_err(line_num, msg));
                        }
                    }
                    in_req = false;
                    poly_stack.clear();
                    last_was_req = false;
                    consecutive_empty = 0;
                }

                LineKind::NonDef { .. } => {
                    in_req = false;
                    poly_stack.clear();
                    last_was_req = false;
                    consecutive_empty = 0;
                }

                LineKind::Ret { value: _, indent } => {
                    if !in_req {
                        diagnostics.push(diag_err(line_num, "[RET] outside [REQ]".to_string()));
                        continue;
                    }
                    if *indent != step_expected {
                        diagnostics.push(diag_err(line_num, format!("[RET] should be indented {} spaces, got {}", step_expected, indent)));
                    }
                    last_step_indent = Some(*indent);
                    last_was_req = false;
                    consecutive_empty = 0;
                }

                LineKind::New { indent, .. } => {
                    if !in_req {
                        diagnostics.push(diag_err(line_num, "[NEW] outside [REQ]".to_string()));
                        continue;
                    }
                    if *indent != step_expected {
                        diagnostics.push(diag_err(line_num, format!("[NEW] should be indented {} spaces, got {}", step_expected, indent)));
                    }
                    last_step_indent = Some(*indent);
                    last_was_req = false;
                    consecutive_empty = 0;
                }

                LineKind::MultilineContinuation { expected_indent, actual_indent } => {
                    if expected_indent != actual_indent {
                        diagnostics.push(diag_err(line_num, format!(
                            "Inconsistent indentation: expected {} spaces, got {}",
                            expected_indent, actual_indent)));
                    }
                    consecutive_empty = 0;
                }

                LineKind::Unknown(text) => {
                    let msg = if text.contains('.') && !text.contains('(') {
                        "Missing parameters: expected 'noun.verb(args): type'".to_string()
                    } else if text.contains('(') && !text.contains(':') {
                        "Missing return type after ':'".to_string()
                    } else if text.starts_with('[') {
                        text.clone()
                    } else {
                        format!("Unexpected '{}' - expected a tag, step, fault, or definition", text)
                    };
                    diagnostics.push(diag_err(line_num, msg));
                    consecutive_empty = 0;
                }

                LineKind::Empty => {
                    consecutive_empty += 1;
                }

                // [SRV] declaration: the only check is a valid transport;
                // service-presence (boundary → declared service) is a
                // project-wide rule left to `rune lint`, not the single-file LSP.
                LineKind::Srv { transport, .. } => {
                    let valid = ["SDK", "HTTP", "WEBSOCKET", "SIDECAR", "NATIVE"];
                    if !valid.contains(&transport.as_str()) {
                        diagnostics.push(diag_err(
                            line_num,
                            format!("[SRV] unknown transport \"{}\" — expected SDK/HTTP/WEBSOCKET/SIDECAR/NATIVE", transport),
                        ));
                    }
                    consecutive_empty = 0;
                }

                // Definitions handled in the first pass; descriptions / refs are
                // prose with no second-pass checks.
                LineKind::DtoDesc { .. }
                | LineKind::TypDesc { .. }
                | LineKind::NonDesc { .. }
                | LineKind::Prose { .. }
                | LineKind::DtoProperty { .. }
                | LineKind::DtoArrayProperty { .. }
                | LineKind::DtoRef(_) => {
                    consecutive_empty = 0;
                }

                LineKind::SrvDocs { name, url, .. } => {
                    if url.trim().is_empty() {
                        diagnostics.push(diag_err(
                            line_num,
                            format!("[SRV] {}: @docs needs a URL", name),
                        ));
                    }
                    consecutive_empty = 0;
                }

                // [ENT:ws] socket header — benign for the single-file LSP. The TS engine owns the
                // deeper checks (empty socket, coordinator match); a malformed header already
                // arrives here as LineKind::Unknown above.
                LineKind::WsSocket { .. } => {
                    in_req = false;
                    in_ent = false;
                    poly_stack.clear();
                    last_was_req = false;
                    consecutive_empty = 0;
                }

                // A `verb(In): Out` topic line under an [ENT:ws] socket — a malformed one arrives
                // as LineKind::Unknown above, so a well-formed topic needs no further checks.
                LineKind::WsTopic { .. } => {
                    consecutive_empty = 0;
                }

                LineKind::Comment { .. } => {}
            }
        }

        // Duplicate DTO properties within the same DTO.
        for (dto_name, props) in &dto_properties {
            let mut seen: HashMap<&String, usize> = HashMap::new();
            for (line_num, prop_name) in props {
                if let Some(&first) = seen.get(prop_name) {
                    diagnostics.push(diag_err(*line_num, format!(
                        "Duplicate property '{}' in {} (first defined on line {})",
                        prop_name, dto_name, first + 1)));
                } else {
                    seen.insert(prop_name, *line_num);
                }
            }
        }

        // Every DTO needs a description.
        for (dto_name, line_num) in &defined_dtos_lines {
            if !dto_has_desc.contains(dto_name) {
                diagnostics.push(diag_err(*line_num, format!(
                    "DTO '{}' is missing a description (add a 4-space indented description on the next line)",
                    dto_name)));
            }
        }

        diagnostics
    }
}

fn line_range(line: usize) -> Range {
    Range {
        start: Position {
            line: line as u32,
            character: 0,
        },
        end: Position {
            line: line as u32,
            character: 1000, // Reasonable max line length
        },
    }
}

fn to_pascal(s: &str) -> String {
    s.split(|c| c == '-' || c == '_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut ch = w.chars();
            match ch.next() {
                Some(f) => f.to_uppercase().collect::<String>() + ch.as_str(),
                None => String::new(),
            }
        })
        .collect()
}

fn diag_err(line: usize, message: String) -> Diagnostic {
    Diagnostic {
        range: line_range(line),
        severity: Some(DiagnosticSeverity::ERROR),
        message,
        ..Default::default()
    }
}

fn diag_warn(line: usize, message: String) -> Diagnostic {
    Diagnostic {
        range: line_range(line),
        severity: Some(DiagnosticSeverity::WARNING),
        message,
        ..Default::default()
    }
}

/// Indent of the lines that participate in [PLY] scope nesting.
fn step_like_indent(kind: &LineKind) -> Option<usize> {
    match kind {
        LineKind::Step { indent, .. }
        | LineKind::BoundaryStep { indent, .. }
        | LineKind::Ply { indent, .. }
        | LineKind::Cse { indent, .. }
        | LineKind::Ret { indent, .. }
        | LineKind::New { indent, .. } => Some(*indent),
        _ => None,
    }
}

/// A `noun.verb` (or `Noun::verb`) must keep one signature throughout a document.
fn check_sig(
    diagnostics: &mut Vec<Diagnostic>,
    sigs: &mut HashMap<String, (usize, Vec<String>, String)>,
    line_num: usize,
    noun: &str,
    verb: &str,
    is_static: bool,
    params: &[String],
    output: &str,
) {
    let sep = if is_static { "::" } else { "." };
    let key = format!("{}{}{}", noun, sep, verb);
    if let Some((first_line, first_params, first_output)) = sigs.get(&key) {
        if first_params != params || first_output != output {
            diagnostics.push(diag_err(line_num, format!(
                "Inconsistent signature for '{}': expected ({}) -> {} (from line {}), got ({}) -> {}",
                key,
                first_params.join(", "),
                first_output,
                first_line + 1,
                params.join(", "),
                output)));
        }
    } else {
        sigs.insert(key, (line_num, params.to_vec(), output.to_string()));
    }
}

/// Check if a type is a raw primitive (string, number, boolean, etc.)
fn is_primitive(s: &str) -> bool {
    matches!(
        s,
        "string" | "number" | "boolean" | "void" | "Uint8Array" | "Primitive"
    )
}

/// Check if a value is valid for boundary crossing:
/// - DTOs (ends in "Dto")
/// - Raw primitives (string, number, boolean, void, Uint8Array)
/// - Type names that resolve to primitives (e.g., `url: string`)
fn is_dto_or_primitive(s: &str, defined_types: &HashMap<String, String>) -> bool {
    // DTOs are always valid at boundaries
    if s.ends_with("Dto") {
        return true;
    }

    // Raw primitives are valid
    if is_primitive(s) {
        return true;
    }

    // Check if it's a type name that resolves to a primitive
    if let Some(underlying_type) = defined_types.get(s) {
        return is_primitive(underlying_type);
    }

    false
}

/// Validate a `[TYP:...]` constraint-modifier list (e.g. `ext,uuid` or
/// `min=0,max=100`) against the design contract §5. Returns one message per
/// problem, byte-identical to the TS engine + studio so all three emit the
/// same diagnostics. `name` is the type name, `declared_type` the primitive it
/// aliases (e.g. "string", "number").
/// Mirrors the TS engine's `^-?\d+(\.\d+)?$` numeric-value check exactly:
/// plain decimals only — no exponents, no leading `+`, no bare `.5` / `5.`.
fn is_plain_decimal(v: &str) -> bool {
    let s = v.strip_prefix('-').unwrap_or(v);
    let mut parts = s.splitn(2, '.');
    let all_digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    let int = parts.next().unwrap_or("");
    let frac = parts.next();
    all_digits(int) && frac.map_or(true, all_digits)
}

fn validate_typ_modifiers(raw: &str, name: &str, declared_type: &str) -> Vec<String> {
    let mut errors = Vec::new();
    for item in raw.split(',') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        // `min=0` splits into id + value; bare modifiers have no value.
        // NO trim around '=' — the TS engine slices at indexOf('=') verbatim,
        // so `min = 5` yields the unknown modifier `min ` there; mirror that.
        let (id, value) = match item.split_once('=') {
            Some((i, v)) => (i, Some(v)),
            None => (item, None),
        };
        // Required base type per modifier; None = ext/core/example/from (no base requirement).
        let base: Option<&str> = match id {
            "ext" | "core" | "example" | "from" => None,
            "uuid" | "email" | "url" | "nonempty" | "json" => Some("string"),
            "int" | "min" | "max" | "positive" => Some("number"),
            _ => {
                errors.push(format!(
                    "[TYP] unknown modifier \"{}\" (allowed: ext, core, uuid, email, url, nonempty, json, int, min=<n>, max=<n>, positive, example=<value>, from=<path|path*|query|header>)",
                    id
                ));
                continue;
            }
        };
        let takes_value = id == "min" || id == "max";
        let takes_text = id == "example" || id == "from";
        // Closed-set value modifiers (`from` ∈ path|path*|query|header); None = any non-empty text.
        let allowed_values: Option<&[&str]> = match id {
            "from" => Some(&["path", "path*", "query", "header"]),
            _ => None,
        };
        if takes_value {
            let numeric = value.map(is_plain_decimal).unwrap_or(false);
            if !numeric {
                errors.push(format!(
                    "[TYP] modifier \"{}\" requires a numeric value (e.g. min=0)",
                    id
                ));
                continue;
            }
        } else if takes_text {
            // Free-text value, mirrors the TS engine: required and non-empty.
            if value.map_or(true, |v| v.is_empty()) {
                errors.push(format!(
                    "[TYP] modifier \"{}\" requires a value (e.g. example=orders)",
                    id
                ));
                continue;
            }
            // A closed-set value modifier rejects anything outside its set (byte-exact w/ engine).
            if let Some(set) = allowed_values {
                let v = value.unwrap_or("");
                if !set.contains(&v) {
                    errors.push(format!(
                        "[TYP] modifier \"{}\" must be one of {} (got \"{}\")",
                        id,
                        set.join(", "),
                        v
                    ));
                    continue;
                }
            }
        } else if value.is_some() {
            errors.push(format!("[TYP] modifier \"{}\" does not take a value", id));
            continue;
        }
        if let Some(b) = base {
            if declared_type != b {
                errors.push(format!(
                    "[TYP] modifier \"{}\" requires a {} type, but \"{}\" is {}",
                    id, b, name, declared_type
                ));
            }
        }
    }
    errors
}

#[tower_lsp::async_trait]
impl LanguageServer for Backend {
    async fn initialize(&self, _: InitializeParams) -> Result<InitializeResult> {
        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                hover_provider: Some(HoverProviderCapability::Simple(true)),
                definition_provider: Some(OneOf::Left(true)),
                references_provider: Some(OneOf::Left(true)),
                completion_provider: Some(CompletionOptions {
                    trigger_characters: Some(vec![
                        ":".to_string(),
                        ".".to_string(),
                        "{".to_string(),
                    ]),
                    ..Default::default()
                }),
                ..Default::default()
            },
            ..Default::default()
        })
    }

    async fn initialized(&self, _: InitializedParams) {
        self.client
            .log_message(MessageType::INFO, "Rune LSP initialized")
            .await;
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        let uri = params.text_document.uri;
        let text = params.text_document.text;
        let rope = Rope::from_str(&text);

        self.documents.write().await.insert(uri.clone(), rope);
        self.validate(&uri).await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        let uri = params.text_document.uri;
        // Under TextDocumentSyncKind::FULL every change.text is a full-document
        // snapshot, and per the LSP spec changes apply in receive order, so the
        // LAST change is authoritative. A client batching multiple changes in one
        // notification must not lose all but the first.
        if let Some(text) = full_sync_text(params.content_changes) {
            let rope = Rope::from_str(&text);
            self.documents.write().await.insert(uri.clone(), rope);
            self.validate(&uri).await;
        }
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        self.documents
            .write()
            .await
            .remove(&params.text_document.uri);
    }

    async fn completion(&self, params: CompletionParams) -> Result<Option<CompletionResponse>> {
        let uri = params.text_document_position.text_document.uri;
        let pos = params.text_document_position.position;

        let docs = self.documents.read().await;
        let Some(rope) = docs.get(&uri) else {
            return Ok(None);
        };

        let text = rope.to_string();
        let lines_vec: Vec<&str> = text.lines().collect();
        let current_line = lines_vec.get(pos.line as usize).unwrap_or(&"");
        let col = pos.character as usize;
        let prefix = completion_prefix(current_line, col);
        let prefix = prefix.as_str();

        let mut items = Vec::new();

        // Boundary prefixes
        if prefix.trim().is_empty() || prefix.ends_with(' ') {
            for bp in ["db:", "fs:", "mq:", "ex:", "os:", "lg:"] {
                items.push(CompletionItem {
                    label: bp.to_string(),
                    kind: Some(CompletionItemKind::KEYWORD),
                    detail: Some(boundary_detail(bp)),
                    ..Default::default()
                });
            }
        }

        // Tags at column 0
        if prefix.trim().is_empty() && col == 0 || prefix.starts_with('[') {
            for tag in ["[REQ]", "[ENT]", "[DTO]", "[TYP]", "[NON]", "[PLY]", "[CSE]", "[NEW]", "[RET]", "[MOD]"] {
                items.push(CompletionItem {
                    label: tag.to_string(),
                    kind: Some(CompletionItemKind::KEYWORD),
                    detail: Some(match tag {
                        "[REQ]" => "requirement (endpoint)".to_string(),
                        "[ENT]" => "entrypoint / transport binding".to_string(),
                        "[DTO]" => "data transfer object".to_string(),
                        "[TYP]" => "type alias".to_string(),
                        "[NON]" => "noun declaration".to_string(),
                        "[PLY]" => "polymorphic dispatch".to_string(),
                        "[CSE]" => "polymorphism case".to_string(),
                        "[NEW]" => "construct a noun".to_string(),
                        "[RET]" => "return a value in scope".to_string(),
                        "[MOD]" => "module name".to_string(),
                        _ => "tag".to_string(),
                    }),
                    ..Default::default()
                });
            }
        }

        // Common types (after colon)
        if prefix.ends_with(':') || prefix.ends_with(": ") {
            for t in ["string", "number", "boolean", "void"] {
                items.push(CompletionItem {
                    label: t.to_string(),
                    kind: Some(CompletionItemKind::TYPE_PARAMETER),
                    ..Default::default()
                });
            }
        }

        // Common faults (indented lines)
        if prefix.starts_with("      ") && !prefix.contains('.') && !prefix.contains(':') {
            for f in ["not-found", "timeout", "network-error", "invalid", "forbidden", "unauthorized"] {
                items.push(CompletionItem {
                    label: f.to_string(),
                    kind: Some(CompletionItemKind::ENUM_MEMBER),
                    ..Default::default()
                });
            }
        }

        // Extract existing nouns, DTOs, faults from document
        let parsed = parse_document(&text);
        let mut nouns: HashSet<String> = HashSet::new();
        let mut dtos: HashSet<String> = HashSet::new();
        let mut faults: HashSet<String> = HashSet::new();

        for parsed_line in &parsed {
            match &parsed_line.kind {
                LineKind::Req { noun, .. }
                | LineKind::Step { noun, .. }
                | LineKind::BoundaryStep { noun, .. } => {
                    nouns.insert(noun.clone());
                }
                LineKind::NonDef { name } => {
                    nouns.insert(name.clone());
                }
                LineKind::DtoRef(name) | LineKind::DtoDef { name, properties: _ } => {
                    dtos.insert(name.clone());
                }
                LineKind::Fault { names, .. } => {
                    for name in names {
                        faults.insert(name.clone());
                    }
                }
                _ => {}
            }
        }

        // Add existing nouns
        for noun in nouns {
            items.push(CompletionItem {
                label: noun.clone(),
                kind: Some(CompletionItemKind::CLASS),
                detail: Some("noun".to_string()),
                ..Default::default()
            });
        }

        // Add existing DTOs
        for dto in dtos {
            items.push(CompletionItem {
                label: dto.clone(),
                kind: Some(CompletionItemKind::STRUCT),
                detail: Some("DTO".to_string()),
                ..Default::default()
            });
        }

        // Add existing faults (for fault lines)
        if prefix.starts_with("      ") {
            for fault in faults {
                items.push(CompletionItem {
                    label: fault.clone(),
                    kind: Some(CompletionItemKind::ENUM_MEMBER),
                    detail: Some("existing fault".to_string()),
                    ..Default::default()
                });
            }
        }

        Ok(Some(CompletionResponse::Array(items)))
    }

    async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
        let uri = params.text_document_position_params.text_document.uri;
        let pos = params.text_document_position_params.position;

        let docs = self.documents.read().await;
        let Some(rope) = docs.get(&uri) else {
            return Ok(None);
        };

        let text = rope.to_string();
        let lines: Vec<&str> = text.lines().collect();
        let parsed = parse_document(&text);

        let line_num = pos.line as usize;
        if line_num >= parsed.len() {
            return Ok(None);
        }

        // Build TYP definitions map for hover on type references
        let mut typ_defs: HashMap<String, (String, Option<String>)> = HashMap::new();
        // Build NON definitions map for hover on noun references
        let mut non_defs: HashMap<String, Option<String>> = HashMap::new();
        let mut i = 0;
        while i < parsed.len() {
            if let LineKind::TypDef { name, type_name, .. } = &parsed[i].kind {
                let mut desc_lines = Vec::new();
                let mut j = i + 1;
                while j < parsed.len() {
                    if let LineKind::TypDesc { text, .. } = &parsed[j].kind {
                        desc_lines.push(text.clone());
                        j += 1;
                    } else {
                        break;
                    }
                }
                let desc = if desc_lines.is_empty() {
                    None
                } else {
                    Some(desc_lines.join(" "))
                };
                typ_defs.insert(name.clone(), (type_name.clone(), desc));
            } else if let LineKind::NonDef { name } = &parsed[i].kind {
                let mut desc_lines = Vec::new();
                let mut j = i + 1;
                while j < parsed.len() {
                    if let LineKind::NonDesc { text, .. } = &parsed[j].kind {
                        desc_lines.push(text.clone());
                        j += 1;
                    } else {
                        break;
                    }
                }
                let desc = if desc_lines.is_empty() {
                    None
                } else {
                    Some(desc_lines.join(" "))
                };
                non_defs.insert(name.clone(), desc);
            }
            i += 1;
        }

        // Build DTO definitions map with properties
        let mut dto_defs: HashMap<String, Vec<String>> = HashMap::new();
        for parsed_line in &parsed {
            match &parsed_line.kind {
                LineKind::DtoDef { name, properties } => {
                    dto_defs.insert(name.clone(), properties.clone());
                }
                _ => {}
            }
        }

        let current_line = lines.get(line_num).unwrap_or(&"");
        let col = pos.character as usize;

        // Find word at cursor position
        let word = get_word_at_position(current_line, col);
        if word.is_empty() {
            return Ok(None);
        }

        // Check if it's a TYP reference
        if let Some((type_name, desc)) = typ_defs.get(&word) {
            let content = if let Some(d) = desc {
                format!("**{}**: `{}`\n\n{}", word, type_name, d)
            } else {
                format!("**{}**: `{}`", word, type_name)
            };
            return Ok(Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value: content,
                }),
                range: None,
            }));
        }

        // Check if it's a NON reference
        if let Some(desc) = non_defs.get(&word) {
            let content = if let Some(d) = desc {
                format!("**{}** (noun)\n\n{}", word, d)
            } else {
                format!("**{}** (noun)", word)
            };
            return Ok(Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value: content,
                }),
                range: None,
            }));
        }

        // Check if it's a DTO reference
        if word.ends_with("Dto") {
            if let Some(props) = dto_defs.get(&word) {
                let content = if props.is_empty() {
                    format!("**{}** {{}}", word)
                } else {
                    format!("**{}** {{ {} }}", word, props.join(", "))
                };
                return Ok(Some(Hover {
                    contents: HoverContents::Markup(MarkupContent {
                        kind: MarkupKind::Markdown,
                        value: content,
                    }),
                    range: None,
                }));
            }
        }

        // Check if it's a boundary prefix
        let boundary_prefixes = ["db:", "fs:", "mq:", "ex:", "os:", "lg:"];
        for bp in boundary_prefixes {
            if current_line.trim().starts_with(bp) && col <= current_line.find(bp).unwrap_or(0) + 3 {
                return Ok(Some(Hover {
                    contents: HoverContents::Markup(MarkupContent {
                        kind: MarkupKind::Markdown,
                        value: format!("**{}** {}", bp, boundary_detail(bp)),
                    }),
                    range: None,
                }));
            }
        }

        Ok(None)
    }

    async fn goto_definition(
        &self,
        params: GotoDefinitionParams,
    ) -> Result<Option<GotoDefinitionResponse>> {
        let uri = params.text_document_position_params.text_document.uri;
        let pos = params.text_document_position_params.position;

        let docs = self.documents.read().await;
        let Some(rope) = docs.get(&uri) else {
            return Ok(None);
        };

        let text = rope.to_string();
        let lines: Vec<&str> = text.lines().collect();
        let parsed = parse_document(&text);

        let current_line = lines.get(pos.line as usize).unwrap_or(&"");
        let col = pos.character as usize;
        let word = get_word_at_position(current_line, col);

        if word.is_empty() {
            self.client
                .log_message(MessageType::INFO, "gd: word is empty")
                .await;
            return Ok(None);
        }

        self.client
            .log_message(MessageType::INFO, format!("gd: looking for '{}'", word))
            .await;

        // Build maps of definitions with their line numbers
        let mut typ_lines: HashMap<String, usize> = HashMap::new();
        let mut dto_lines: HashMap<String, usize> = HashMap::new();
        let mut non_lines: HashMap<String, usize> = HashMap::new();

        for parsed_line in &parsed {
            match &parsed_line.kind {
                LineKind::TypDef { name, .. } => {
                    typ_lines.insert(name.clone(), parsed_line.line_num);
                }
                LineKind::DtoDef { name, properties: _ } => {
                    dto_lines.insert(name.clone(), parsed_line.line_num);
                }
                LineKind::NonDef { name } => {
                    non_lines.insert(name.clone(), parsed_line.line_num);
                }
                _ => {}
            }
        }

        self.client
            .log_message(MessageType::INFO, format!("gd: typ_lines keys: {:?}", typ_lines.keys().collect::<Vec<_>>()))
            .await;

        // Find TYP definition
        if let Some(&line_num) = typ_lines.get(&word) {
            self.client
                .log_message(MessageType::INFO, format!("gd: found TYP at line {}", line_num))
                .await;
            return Ok(Some(GotoDefinitionResponse::Array(vec![Location {
                uri: uri.clone(),
                range: line_range(line_num),
            }])));
        }

        // Find DTO definition
        if let Some(&line_num) = dto_lines.get(&word) {
            self.client
                .log_message(MessageType::INFO, format!("gd: found DTO at line {}", line_num))
                .await;
            return Ok(Some(GotoDefinitionResponse::Array(vec![Location {
                uri: uri.clone(),
                range: line_range(line_num),
            }])));
        }

        // Find NON definition
        if let Some(&line_num) = non_lines.get(&word) {
            self.client
                .log_message(MessageType::INFO, format!("gd: found NON at line {}", line_num))
                .await;
            return Ok(Some(GotoDefinitionResponse::Array(vec![Location {
                uri: uri.clone(),
                range: line_range(line_num),
            }])));
        }

        self.client
            .log_message(MessageType::INFO, format!("gd: '{}' not found in typ_lines, dto_lines, or non_lines", word))
            .await;

        Ok(None)
    }

    async fn references(&self, params: ReferenceParams) -> Result<Option<Vec<Location>>> {
        let uri = params.text_document_position.text_document.uri;
        let pos = params.text_document_position.position;

        let docs = self.documents.read().await;
        let Some(rope) = docs.get(&uri) else {
            return Ok(None);
        };

        let text = rope.to_string();
        let lines: Vec<&str> = text.lines().collect();

        let current_line = lines.get(pos.line as usize).unwrap_or(&"");
        let col = pos.character as usize;
        let word = get_word_at_position(current_line, col);

        if word.is_empty() {
            return Ok(None);
        }

        let mut locations = Vec::new();

        // Find all references to this word
        for (i, line) in lines.iter().enumerate() {
            for (char_start, char_end) in word_match_columns(line, &word) {
                locations.push(Location {
                    uri: uri.clone(),
                    range: Range {
                        start: Position {
                            line: i as u32,
                            character: char_start,
                        },
                        end: Position {
                            line: i as u32,
                            character: char_end,
                        },
                    },
                });
            }
        }

        if locations.is_empty() {
            Ok(None)
        } else {
            Ok(Some(locations))
        }
    }
}

/// Every (start, end) column pair (as char offsets, the LSP `Position.character`
/// unit used elsewhere in this file) where `word` occurs in `line`. Substring
/// semantics, matching `references`' original `line.contains`/`line.find` intent,
/// but ALL occurrences, not just the first, and byte offsets converted to char
/// offsets so they are correct on multibyte lines.
fn word_match_columns(line: &str, word: &str) -> Vec<(u32, u32)> {
    if word.is_empty() {
        return Vec::new();
    }
    let word_chars = word.chars().count() as u32;
    let mut out = Vec::new();
    let mut search_from = 0usize; // byte offset
    while let Some(rel) = line[search_from..].find(word) {
        let byte_start = search_from + rel;
        let char_start = line[..byte_start].chars().count() as u32;
        out.push((char_start, char_start + word_chars));
        search_from = byte_start + word.len();
    }
    out
}

/// Build the completion prefix: the portion of `line` up to the cursor.
/// `col` is a character offset (matching `get_word_at_position`), not a byte
/// offset, so it must index by chars to stay correct on multibyte lines.
fn completion_prefix(line: &str, col: usize) -> String {
    line.chars().take(col).collect()
}

fn get_word_at_position(line: &str, col: usize) -> String {
    let chars: Vec<char> = line.chars().collect();
    let is_ident = |c: char| c.is_alphanumeric() || c == '_';

    // Anchor for the scan. When the cursor sits past the end, or on a
    // non-identifier char, but the PREVIOUS char is an identifier char (the
    // normal end-of-word / end-of-line cursor placement), back up by one so
    // the trailing-cursor case still resolves the word.
    let anchor = if col < chars.len() && is_ident(chars[col]) {
        col
    } else if col > 0 && is_ident(chars[col - 1]) {
        col - 1
    } else {
        return String::new();
    };

    let mut start = anchor;
    while start > 0 && is_ident(chars[start - 1]) {
        start -= 1;
    }

    let mut end = anchor;
    while end < chars.len() && is_ident(chars[end]) {
        end += 1;
    }

    chars[start..end].iter().collect()
}

fn boundary_detail(prefix: &str) -> String {
    match prefix {
        "db:" => "database / persistence".to_string(),
        "fs:" => "file system (local)".to_string(),
        "mq:" => "message queue".to_string(),
        "ex:" => "external service / provider".to_string(),
        "os:" => "object storage (S3, GCS)".to_string(),
        "lg:" => "logs".to_string(),
        _ => "boundary".to_string(),
    }
}

#[tokio::main]
async fn main() {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();

    let (service, socket) = LspService::new(Backend::new);
    Server::new(stdin, stdout, socket).serve(service).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/corpus")
    }

    /// Sorted list of `*.rune` files under a corpus subdirectory.
    fn rune_files(sub: &str) -> Vec<std::path::PathBuf> {
        let dir = corpus_dir().join(sub);
        let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("read_dir {:?}: {}", dir, e))
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map(|x| x == "rune").unwrap_or(false))
            .collect();
        files.sort();
        assert!(!files.is_empty(), "no .rune fixtures in {:?}", dir);
        files
    }

    /// Every fixture in the valid corpus must validate clean — this is the
    /// parity gate that keeps the Rust LSP in lock-step with the TS engine.
    #[test]
    fn valid_corpus_has_no_diagnostics() {
        let mut failures = Vec::new();
        for path in rune_files("valid") {
            let text = std::fs::read_to_string(&path).unwrap();
            let diags = Backend::compute_diagnostics(&text, &std::collections::HashSet::new());
            if !diags.is_empty() {
                let msgs: Vec<String> = diags.iter().map(|d| d.message.clone()).collect();
                failures.push(format!(
                    "{}:\n  - {}",
                    path.file_name().unwrap().to_string_lossy(),
                    msgs.join("\n  - ")
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "valid fixtures produced diagnostics:\n{}",
            failures.join("\n")
        );
    }

    /// Every fixture in the invalid corpus must produce at least one diagnostic.
    #[test]
    fn invalid_corpus_has_diagnostics() {
        let mut failures = Vec::new();
        for path in rune_files("invalid") {
            let text = std::fs::read_to_string(&path).unwrap();
            let diags = Backend::compute_diagnostics(&text, &std::collections::HashSet::new());
            if diags.is_empty() {
                failures.push(path.file_name().unwrap().to_string_lossy().to_string());
            }
        }
        assert!(
            failures.is_empty(),
            "invalid fixtures produced no diagnostics: {}",
            failures.join(", ")
        );
    }

    /// Mirrors the dooks layout: a finalized module spec lives in
    /// `src/<module>/` while the shared core is still a DRAFT in `spec/`. The LSP
    /// must resolve `db` from `spec/core.in-prog.rune` — same candidates as the
    /// engine's `loadCoreSrvs` — so a `db:` boundary step doesn't squiggle.
    #[test]
    fn core_services_resolve_from_a_spec_folder_draft_core() {
        let base = std::env::temp_dir().join("rune-lsp-core-srv-test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("spec")).unwrap();
        std::fs::create_dir_all(base.join("src/todos")).unwrap();
        std::fs::write(
            base.join("spec/core.in-prog.rune"),
            "[MOD] core\n[SRV] (SIDECAR)db: DB_URL\n    the datastore\n    @docs https://example.com\n",
        )
        .unwrap();

        // A module spec already moved into src/<module>/ (root = above that src/).
        let module = base.join("src/todos/todos.rune");
        std::fs::write(&module, "[MOD] todos\n").unwrap();
        let uri = Url::from_file_path(&module).unwrap();
        assert!(
            core_services_for(&uri).contains("db"),
            "module in src/todos must see db from spec/core.in-prog.rune"
        );

        // A draft module spec still in spec/ (root = the dir above spec/).
        let draft = base.join("spec/todos.in-prog.rune");
        std::fs::write(&draft, "[MOD] todos\n").unwrap();
        let draft_uri = Url::from_file_path(&draft).unwrap();
        assert!(
            core_services_for(&draft_uri).contains("db"),
            "draft in spec/ must resolve root above spec/ and see db"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The canonical layout: specs live in `spec/runes/` (beside `spec/misc/` and
    /// `spec/ui/`). A module spec there must hop TWO levels to the project root
    /// and resolve `db` from `spec/runes/core.rune` — mirroring `resolveRoot` +
    /// `loadCoreSrvs` so a `db:` boundary step doesn't squiggle in the new layout.
    #[test]
    fn core_services_resolve_from_the_spec_runes_staging_dir() {
        let base = std::env::temp_dir().join("rune-lsp-core-srv-runes-test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("spec/runes")).unwrap();
        std::fs::write(
            base.join("spec/runes/core.rune"),
            "[MOD] core\n[SRV] (SIDECAR)db: DB_URL\n    the datastore\n    @docs https://example.com\n",
        )
        .unwrap();

        let module = base.join("spec/runes/todos.rune");
        std::fs::write(&module, "[MOD] todos\n").unwrap();
        let uri = Url::from_file_path(&module).unwrap();
        assert!(
            core_services_for(&uri).contains("db"),
            "spec/runes/ module must resolve root above spec/ and see db from spec/runes/core.rune"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    fn change(text: &str) -> TextDocumentContentChangeEvent {
        TextDocumentContentChangeEvent {
            range: None,
            range_length: None,
            text: text.to_string(),
        }
    }

    /// R7: under FULL sync, a batched didChange must apply the LAST change (the
    /// authoritative full-document snapshot), not the first.
    #[test]
    fn r7_full_sync_uses_last_change() {
        // batched [OLD, NEW] -> NEW
        let picked = full_sync_text(vec![change("OLD"), change("NEW")]);
        assert_eq!(picked.as_deref(), Some("NEW"));

        // batched [CLEAN, BAD] -> BAD (the bug returned the first = CLEAN)
        let picked = full_sync_text(vec![change("clean"), change("bad")]);
        assert_eq!(picked.as_deref(), Some("bad"));

        // single change -> that change
        let picked = full_sync_text(vec![change("only")]);
        assert_eq!(picked.as_deref(), Some("only"));

        // no changes -> None
        let picked = full_sync_text(Vec::new());
        assert_eq!(picked, None);
    }

    /// R7 end-to-end via diagnostics: a batched [BAD(>80), CLEAN] update must
    /// leave the document CLEAN (last wins), producing no diagnostics; and
    /// [CLEAN, BAD] must surface the >80 diagnostic.
    #[test]
    fn r7_batched_full_sync_diagnostics_reflect_last_change() {
        let clean = "[REQ] x.run(InDto): OutDto\n";
        let bad = format!("[TYP] {}: string\n", "x".repeat(100));

        let last_clean = full_sync_text(vec![change(&bad), change(clean)]).unwrap();
        let diags = Backend::compute_diagnostics(&last_clean, &std::collections::HashSet::new());
        assert!(
            diags.is_empty(),
            "batched [BAD, CLEAN] must end CLEAN, got: {:?}",
            diags.iter().map(|d| &d.message).collect::<Vec<_>>()
        );

        let last_bad = full_sync_text(vec![change(clean), change(&bad)]).unwrap();
        let diags = Backend::compute_diagnostics(&last_bad, &std::collections::HashSet::new());
        assert!(
            diags.iter().any(|d| d.message.contains("80 columns")),
            "batched [CLEAN, BAD] must end BAD (>80 diagnostic), got: {:?}",
            diags.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
    }

    /// A [SRV] missing its required `@docs <url>` line is flagged (mirrors
    /// `rune check`). With the line present, no @docs diagnostic appears.
    #[test]
    fn srv_without_docs_is_flagged() {
        let text = "[SRV] (SDK)firebase: API_KEY\n    the backend";
        let diags = Backend::compute_diagnostics(text, &std::collections::HashSet::new());
        assert!(
            diags.iter().any(|d| d.message.contains("requires an @docs")),
            "expected a missing-@docs diagnostic, got: {:?}",
            diags.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
    }

    #[test]
    fn srv_with_docs_is_clean() {
        let text = "[SRV] (SDK)firebase: API_KEY\n    the backend\n    @docs https://x.dev/api";
        let diags = Backend::compute_diagnostics(text, &std::collections::HashSet::new());
        assert!(
            !diags.iter().any(|d| d.message.contains("@docs")),
            "expected no @docs diagnostic, got: {:?}",
            diags.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
    }

    /// Item 4: the empty-`@docs` diagnostic must name the service, matching the
    /// TS engine string `[SRV] <name>: @docs needs a URL`.
    #[test]
    fn srv_empty_docs_message_includes_service_name() {
        let text = "[SRV] (SDK)firebase: API_KEY\n    @docs";
        let diags = Backend::compute_diagnostics(text, &std::collections::HashSet::new());
        assert!(
            diags.iter().any(|d| d.message == "[SRV] firebase: @docs needs a URL"),
            "expected name-prefixed empty-@docs message, got: {:?}",
            diags.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
    }

    /// Item 1a (parity with `rune check`): a spec whose last step's output does
    /// NOT equal the REQ output must NOT be flagged — codegen derives the result
    /// from ANY core read, not the last step, so this is a valid spec.
    #[test]
    fn last_step_output_neq_req_output_is_not_flagged() {
        let text = "[MOD] search\n\
                    \n\
                    [REQ] search.run(QueryDto): ResultsDto\n\
                    \x20\x20\x20\x20db:index.query(QueryDto): ResultsDto\n\
                    \x20\x20\x20\x20db:audit.record(ResultsDto): AuditDto\n\
                    \n\
                    [DTO] QueryDto: query\n\
                    \x20\x20\x20\x20a search query\n\
                    \n\
                    [DTO] ResultsDto: items\n\
                    \x20\x20\x20\x20the matched results\n\
                    \n\
                    [DTO] AuditDto: items\n\
                    \x20\x20\x20\x20an audit record\n\
                    \n\
                    [TYP] query: string\n\
                    \x20\x20\x20\x20the query\n\
                    [TYP] items: string\n\
                    \x20\x20\x20\x20an item\n\
                    \n\
                    [SRV] (SIDECAR)db: DB_URL\n\
                    \x20\x20\x20\x20the datastore\n\
                    \x20\x20\x20\x20@docs https://docs.example.com/db\n";
        let diags = Backend::compute_diagnostics(text, &std::collections::HashSet::new());
        assert!(
            !diags.iter().any(|d| d.message.contains("Last step must return")),
            "last-step-output != REQ-output must not be flagged, got: {:?}",
            diags.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
    }

    /// Item 1b (parity with `rune check`): a [TYP] may alias a DTO or another
    /// [TYP] — the LSP must not require the type to be a primitive.
    #[test]
    fn typ_aliasing_dto_or_typ_is_not_flagged() {
        let text = "[MOD] catalog\n\
                    \n\
                    [REQ] item.add(AddItemDto): ItemDto\n\
                    \x20\x20\x20\x20db:item.save(AddItemDto): ItemDto\n\
                    \x20\x20\x20\x20[RET] ItemDto\n\
                    \n\
                    [TYP] name: string\n\
                    \x20\x20\x20\x20a name\n\
                    [TYP] itemRef: ItemDto\n\
                    \x20\x20\x20\x20an alias to the DTO\n\
                    [TYP] label: name\n\
                    \x20\x20\x20\x20an alias to another TYP\n\
                    \n\
                    [DTO] AddItemDto: name\n\
                    \x20\x20\x20\x20a request\n\
                    \n\
                    [DTO] ItemDto: name\n\
                    \x20\x20\x20\x20a stored item\n\
                    \n\
                    [SRV] (SIDECAR)db: DB_URL\n\
                    \x20\x20\x20\x20the datastore\n\
                    \x20\x20\x20\x20@docs https://docs.example.com/db\n";
        let diags = Backend::compute_diagnostics(text, &std::collections::HashSet::new());
        assert!(
            !diags.iter().any(|d| d.message.contains("must be primitives")),
            "[TYP] aliasing a DTO/TYP must not be flagged, got: {:?}",
            diags.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
    }

    // --- [TYP] constraint-modifier validator (design §5) -------------------

    #[test]
    fn typ_modifier_ok_compose() {
        assert!(validate_typ_modifiers("ext,uuid", "externalId", "string").is_empty());
        assert!(validate_typ_modifiers("min=0,max=100", "qty", "number").is_empty());
        assert!(validate_typ_modifiers("nonempty", "name", "string").is_empty());
        assert!(validate_typ_modifiers("json", "payloadJson", "string").is_empty());
        assert!(validate_typ_modifiers("core", "id", "string").is_empty());
        assert!(validate_typ_modifiers("int", "count", "number").is_empty());
        assert!(validate_typ_modifiers("positive", "amount", "number").is_empty());
        assert!(validate_typ_modifiers("example=orders", "tableName", "string").is_empty());
        assert!(validate_typ_modifiers("ext,example=42", "qty", "number").is_empty());
        // from= accepts the closed source set on any base type, and composes.
        for src in ["path", "path*", "query", "header"] {
            assert!(
                validate_typ_modifiers(&format!("from={src}"), "target", "string").is_empty(),
                "from={src} should be accepted"
            );
        }
        assert!(validate_typ_modifiers("from=query,example=widgets", "q", "string").is_empty());
    }

    #[test]
    fn typ_modifier_from_bad_source() {
        // Out-of-set value — byte-exact with the TS engine.
        assert_eq!(
            validate_typ_modifiers("from=body", "target", "string"),
            vec!["[TYP] modifier \"from\" must be one of path, path*, query, header (got \"body\")"
                .to_string()]
        );
        // Bare `from` (no value) is the generic free-text error, not the enum error.
        assert_eq!(
            validate_typ_modifiers("from", "target", "string"),
            vec!["[TYP] modifier \"from\" requires a value (e.g. example=orders)".to_string()]
        );
    }

    #[test]
    fn typ_modifier_unknown() {
        assert_eq!(
            validate_typ_modifiers("bogus", "id", "string"),
            vec!["[TYP] unknown modifier \"bogus\" (allowed: ext, core, uuid, email, url, nonempty, json, int, min=<n>, max=<n>, positive, example=<value>, from=<path|path*|query|header>)".to_string()]
        );
    }

    #[test]
    fn typ_modifier_example_needs_value() {
        assert_eq!(
            validate_typ_modifiers("example", "tableName", "string"),
            vec!["[TYP] modifier \"example\" requires a value (e.g. example=orders)".to_string()]
        );
        assert_eq!(
            validate_typ_modifiers("example=", "tableName", "string"),
            vec!["[TYP] modifier \"example\" requires a value (e.g. example=orders)".to_string()]
        );
    }

    #[test]
    fn typ_modifier_wrong_base() {
        assert_eq!(
            validate_typ_modifiers("uuid", "count", "number"),
            vec!["[TYP] modifier \"uuid\" requires a string type, but \"count\" is number".to_string()]
        );
        assert_eq!(
            validate_typ_modifiers("int", "name", "string"),
            vec!["[TYP] modifier \"int\" requires a number type, but \"name\" is string".to_string()]
        );
        assert_eq!(
            validate_typ_modifiers("json", "qty", "number"),
            vec!["[TYP] modifier \"json\" requires a string type, but \"qty\" is number".to_string()]
        );
    }

    #[test]
    fn typ_modifier_bad_value() {
        assert_eq!(
            validate_typ_modifiers("min", "qty", "number"),
            vec!["[TYP] modifier \"min\" requires a numeric value (e.g. min=0)".to_string()]
        );
        assert_eq!(
            validate_typ_modifiers("max=abc", "qty", "number"),
            vec!["[TYP] modifier \"max\" requires a numeric value (e.g. min=0)".to_string()]
        );
    }

    #[test]
    fn typ_modifier_unexpected_value() {
        assert_eq!(
            validate_typ_modifiers("uuid=5", "id", "string"),
            vec!["[TYP] modifier \"uuid\" does not take a value".to_string()]
        );
    }

    // Parity with the TS engine's `^-?\d+(\.\d+)?$` value check: the f64
    // grammar (exponents, leading +, bare dots) must be REJECTED, and
    // whitespace around `=` is NOT trimmed (`min = 5` → unknown "min ").
    #[test]
    fn typ_modifier_value_grammar_matches_engine() {
        let bad = |raw: &str| {
            assert_eq!(
                validate_typ_modifiers(raw, "qty", "number"),
                vec!["[TYP] modifier \"min\" requires a numeric value (e.g. min=0)".to_string()],
                "expected bad-value for {raw}"
            );
        };
        bad("min=1e3");
        bad("min=+5");
        bad("min=.5");
        bad("min=5.");
        bad("min=");
        assert!(validate_typ_modifiers("min=-3", "qty", "number").is_empty());
        assert!(validate_typ_modifiers("min=1.25", "qty", "number").is_empty());
        assert_eq!(
            validate_typ_modifiers("min = 5", "qty", "number"),
            vec!["[TYP] unknown modifier \"min \" (allowed: ext, core, uuid, email, url, nonempty, json, int, min=<n>, max=<n>, positive, example=<value>, from=<path|path*|query|header>)".to_string()]
        );
    }

    // --- [ENT] @ METHOD /template (field-source binding, Feature B) -------

    const ENT_TPL_SPEC: &str = "[MOD] m\n[ENT] http.proxy @ POST /proxy/{target}/{path*}(InDto): OutDto\n[REQ] proxy.run(InDto): OutDto\n    noop::run(): void\n[DTO] InDto: target\n    a\n[DTO] OutDto: status\n    b\n[TYP] target: string\n    c\n[TYP] status: string\n    d";

    #[test]
    fn ent_route_template_method_validated_and_verb_clean() {
        // A valid `@ POST` template produces NO method diagnostic, and the verb parses clean
        // (the `@ …` clause is stripped, so it doesn't leak into the verb / spurious errors).
        let good = Backend::compute_diagnostics(ENT_TPL_SPEC, &std::collections::HashSet::new());
        assert!(
            !good.iter().any(|d| d.message.contains("HTTP method")),
            "valid @ POST template must not flag the method: {good:?}"
        );
        // A bad method is flagged byte-exactly (mirrors the TS engine).
        let bad_spec = ENT_TPL_SPEC.replace("@ POST", "@ FETCH");
        let bad = Backend::compute_diagnostics(&bad_spec, &std::collections::HashSet::new());
        assert!(
            bad.iter().any(|d| d.message
                == "[ENT] HTTP method must be one of GET, POST, PUT, PATCH, DELETE (got \"FETCH\")"),
            "bad method must be flagged: {bad:?}"
        );
    }

    // --- service-presence (boundary -> declared [SRV]) --------------------

    const SVC_SPEC: &str = "[MOD] m\n[REQ] x.run(InDto): OutDto\n    cache:x.save(InDto): void\n    [RET] OutDto\n[DTO] InDto: id\n    a\n[DTO] OutDto: id\n    b\n[TYP] id: string\n    c";

    #[test]
    fn boundary_to_undeclared_service_is_flagged() {
        // No local [SRV], empty core -> the boundary service is undeclared.
        let diags = Backend::compute_diagnostics(SVC_SPEC, &std::collections::HashSet::new());
        assert!(
            diags.iter().any(|d| d.message.contains("undeclared service \"cache\"")),
            "expected undeclared-service diag, got: {:?}",
            diags.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
    }

    #[test]
    fn boundary_with_local_srv_is_clean() {
        let text = format!(
            "{}\n[SRV] (SIDECAR)cache: CACHE_URL\n    the cache\n    @docs https://x.dev",
            SVC_SPEC
        );
        let diags = Backend::compute_diagnostics(&text, &std::collections::HashSet::new());
        assert!(
            !diags.iter().any(|d| d.message.contains("undeclared service")),
            "expected no undeclared-service diag, got: {:?}",
            diags.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
    }

    #[test]
    fn boundary_with_core_service_is_clean() {
        // The service is declared in the project's core.rune (passed in).
        let mut core = std::collections::HashSet::new();
        core.insert("cache".to_string());
        let diags = Backend::compute_diagnostics(SVC_SPEC, &core);
        assert!(
            !diags.iter().any(|d| d.message.contains("undeclared service")),
            "expected no undeclared-service diag, got: {:?}",
            diags.iter().map(|d| &d.message).collect::<Vec<_>>()
        );
    }

    // --- Bug [B]: completion prefix must be char-indexed, not byte-indexed ---

    #[test]
    fn completion_prefix_multibyte_no_panic() {
        // `col` is an LSP/char offset; on a multibyte line, byte-slicing at
        // col=1 lands inside `é` (bytes 0..2) and panics.
        assert_eq!(completion_prefix("é", 1), "é");
    }

    #[test]
    fn completion_prefix_cursor_past_end() {
        // Cursor past the end of a multibyte line clamps to the whole line.
        assert_eq!(completion_prefix("é", 5), "é");
        assert_eq!(completion_prefix("ab", 5), "ab");
    }

    #[test]
    fn completion_prefix_ascii_unchanged() {
        assert_eq!(completion_prefix("hello world", 5), "hello");
        assert_eq!(completion_prefix("hello", 0), "");
    }

    // --- Bug [C]: get_word_at_position must resolve a trailing cursor --------

    #[test]
    fn word_at_position_end_of_line() {
        // Cursor at EOL, immediately after the last char of `UserDto`.
        // `"[DTO] UserDto"` has 13 chars; col=13 is one past the end.
        let line = "[DTO] UserDto";
        assert_eq!(get_word_at_position(line, 13), "UserDto");
    }

    #[test]
    fn word_at_position_trailing_within_line() {
        // Cursor just after a word but before a non-identifier char.
        // "id foo": cursor at col=2 (the space) sits right after `id`.
        assert_eq!(get_word_at_position("id foo", 2), "id");
    }

    #[test]
    fn word_at_position_inside_word_unchanged() {
        // Cursor inside a word still returns the whole word.
        assert_eq!(get_word_at_position("[DTO] UserDto", 8), "UserDto");
        assert_eq!(get_word_at_position("id foo", 0), "id");
    }

    #[test]
    fn word_at_position_on_whitespace_between_words() {
        // Cursor on whitespace between two words returns "".
        // "id  foo": col=2 is right after `id` (resolves to "id"); col=3 is a
        // space with a space before it (no adjacent identifier char) -> "".
        assert_eq!(get_word_at_position("id  foo", 3), "");
    }

    // --- Bug [D]: references must find ALL occurrences, as char offsets ------

    #[test]
    fn word_match_columns_multiple_occurrences() {
        // A word used twice on one line must yield BOTH locations.
        assert_eq!(word_match_columns("id id", "id"), vec![(0, 2), (3, 5)]);
    }

    #[test]
    fn word_match_columns_multibyte_char_offset() {
        // Leading multibyte char: `id` starts at char column 2, not byte 3.
        assert_eq!(word_match_columns("é id", "id"), vec![(2, 4)]);
    }

    #[test]
    fn word_match_columns_ascii_single() {
        assert_eq!(word_match_columns("hello id world", "id"), vec![(6, 8)]);
        assert_eq!(word_match_columns("no match here", "id"), Vec::<(u32, u32)>::new());
    }
}
