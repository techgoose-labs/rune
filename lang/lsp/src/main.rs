use ropey::Rope;
use std::sync::{Arc, OnceLock};
use tokio::sync::RwLock;
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::*;
use tower_lsp::{Client, LanguageServer, LspService, Server};

// The registry, embedded (REQ-025): tags, modifiers and the fault vocabulary
// the completions offer come from it, never from a list of our own.
const REGISTRY: &str = include_str!("../../keywords.json");

fn registry() -> &'static serde_json::Value {
    static REG: OnceLock<serde_json::Value> = OnceLock::new();
    REG.get_or_init(|| serde_json::from_str(REGISTRY).expect("lang/keywords.json is valid JSON"))
}

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

impl Backend {
    fn new(client: Client) -> Self {
        Self {
            client,
            documents: Arc::new(RwLock::new(std::collections::HashMap::new())),
        }
    }

    // Diagnostics come from the one checker (REQ-015): the buffer is piped to
    // `rune check --json --stdin --path <file>` and its findings are published
    // as-is, rule id and all. The LSP never computes a verdict of its own, so an
    // editor — and an LLM fed these diagnostics after every edit — sees exactly
    // what `rune check` and the merge gate will say.
    async fn validate(&self, uri: &Url) {
        let docs = self.documents.read().await;
        let Some(rope) = docs.get(uri) else { return };
        let text = rope.to_string();
        drop(docs);

        let path = uri
            .to_file_path()
            .unwrap_or_else(|_| std::path::PathBuf::from(uri.path()));
        let diagnostics = diagnostics_with(&rune_binary(), &path, &text).await;

        self.client
            .publish_diagnostics(uri.clone(), diagnostics, None)
            .await;
    }

}

/// The `rune` binary diagnostics come from: `RUNE_BIN` when set, else the
/// `rune` beside this executable (the installer drops both into one dir), else
/// `rune` on PATH.
fn rune_binary() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("RUNE_BIN")
        && !p.is_empty()
    {
        return std::path::PathBuf::from(p);
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let sibling = dir.join("rune");
        if sibling.is_file() {
            return sibling;
        }
    }
    std::path::PathBuf::from("rune")
}

/// One finding of `rune check --json` (REQ-013's CheckReport).
#[derive(serde::Deserialize)]
struct CheckFinding {
    id: String,
    severity: String,
    /// 1-based; 0 = the whole file.
    line: u32,
    message: String,
    #[serde(default)]
    fix: Option<String>,
}

#[derive(serde::Deserialize)]
struct CheckReport {
    findings: Vec<CheckFinding>,
}

/// Run `<bin> check --json --stdin --path <path>` over `text` and translate the
/// report into LSP diagnostics. A checker that cannot run or answers garbage is
/// itself reported as one diagnostic on line 0, so the editor shows WHY it is
/// blind instead of going silent.
async fn diagnostics_with(bin: &std::path::Path, path: &std::path::Path, text: &str) -> Vec<Diagnostic> {
    use tokio::io::AsyncWriteExt;
    let mut child = match tokio::process::Command::new(bin)
        .arg("check")
        .arg("--json")
        .arg("--stdin")
        .arg("--path")
        .arg(path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return vec![checker_down(format!(
                "rune-lsp: cannot run `{} check` ({}) — install rune, or set RUNE_BIN to the binary",
                bin.display(),
                e
            ))];
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        // A write error means the child died early; its stderr explains below.
        let _ = stdin.write_all(text.as_bytes()).await;
        drop(stdin);
    }
    let out = match child.wait_with_output().await {
        Ok(o) => o,
        Err(e) => return vec![checker_down(format!("rune-lsp: `rune check` failed to finish ({})", e))],
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let report: CheckReport = match serde_json::from_str(&stdout) {
        Ok(r) => r,
        Err(e) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return vec![checker_down(format!(
                "rune-lsp: `rune check --json` returned no report ({}): {}",
                e,
                stderr.trim().lines().next().unwrap_or("")
            ))];
        }
    };
    report
        .findings
        .into_iter()
        .map(|f| Diagnostic {
            range: line_range(f.line.saturating_sub(1) as usize),
            severity: Some(if f.severity == "warning" {
                DiagnosticSeverity::WARNING
            } else {
                DiagnosticSeverity::ERROR
            }),
            code: Some(NumberOrString::String(f.id)),
            source: Some("rune".to_string()),
            message: match f.fix {
                Some(fix) => format!("{}\nfix: {}", f.message, fix),
                None => f.message,
            },
            ..Default::default()
        })
        .collect()
}

fn checker_down(message: String) -> Diagnostic {
    Diagnostic {
        range: line_range(0),
        severity: Some(DiagnosticSeverity::ERROR),
        code: Some(NumberOrString::String("checker-unavailable".to_string())),
        source: Some("rune".to_string()),
        message,
        ..Default::default()
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

// ---- the document, read through the grammar (REQ-032) ----------------------
//
// Hover, definitions, references and completions read the tree-sitter CST of
// the buffer — the one parser of record, built from the registry — never a
// second hand-written parse. The CST is a line soup: a declaration's prose is
// the `*_desc` lines right after it, which `declarations` folds back in.

#[derive(Debug, Clone, PartialEq)]
enum DeclKind {
    /// `[TYP] name: primitive`
    Typ { type_name: String },
    /// `[DTO] NameDto: prop, prop`
    Dto { props: Vec<String> },
    /// `[NON] name`
    Non,
    /// `[SRV] (TRANSPORT)name: ENV` with its `@docs` link.
    Srv { transport: String, docs: Option<String> },
}

#[derive(Debug, Clone, PartialEq)]
struct Decl {
    name: String,
    kind: DeclKind,
    /// 0-based line of the declaration.
    line: usize,
    /// The indented prose lines under it, joined with spaces.
    description: Option<String>,
}

fn parse_tree(text: &str) -> Option<tree_sitter::Tree> {
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&tree_sitter_rune::LANGUAGE.into())
        .expect("the rune grammar loads");
    parser.parse(text, None)
}

fn node_text<'a>(n: tree_sitter::Node, text: &'a str) -> &'a str {
    n.utf8_text(text.as_bytes()).unwrap_or("")
}

fn child_of_kind<'t>(n: tree_sitter::Node<'t>, kind: &str) -> Option<tree_sitter::Node<'t>> {
    let mut cursor = n.walk();
    n.children(&mut cursor).find(|c| c.kind() == kind)
}

/// Every [TYP]/[DTO]/[NON]/[SRV] in the document with its prose and @docs link.
fn declarations(text: &str) -> Vec<Decl> {
    let Some(tree) = parse_tree(text) else { return Vec::new() };
    let root = tree.root_node();
    let mut out: Vec<Decl> = Vec::new();
    // Prose attaches to the declaration above it only until another line
    // intervenes (a step after a [REQ] is not the [DTO]'s description).
    let mut open = false;
    let mut cursor = root.walk();
    for n in root.children(&mut cursor) {
        match n.kind() {
            "typ_line" => {
                open = true;
                let name = child_of_kind(n, "typ_name").map(|c| node_text(c, text)).unwrap_or("");
                let type_name = child_of_kind(n, "typ_type").map(|c| node_text(c, text)).unwrap_or("");
                out.push(Decl {
                    name: name.to_string(),
                    kind: DeclKind::Typ { type_name: type_name.trim().to_string() },
                    line: n.start_position().row,
                    description: None,
                });
            }
            "dto_line" => {
                open = true;
                let name = child_of_kind(n, "dto_def_name").map(|c| node_text(c, text)).unwrap_or("");
                let mut c2 = n.walk();
                let props = n
                    .children(&mut c2)
                    .filter(|c| c.kind() == "dto_prop")
                    .map(|c| node_text(c, text).trim().to_string())
                    .collect();
                out.push(Decl {
                    name: name.to_string(),
                    kind: DeclKind::Dto { props },
                    line: n.start_position().row,
                    description: None,
                });
            }
            "non_line" => {
                open = true;
                let name = n.child_by_field_name("name").map(|c| node_text(c, text)).unwrap_or("");
                out.push(Decl {
                    name: name.to_string(),
                    kind: DeclKind::Non,
                    line: n.start_position().row,
                    description: None,
                });
            }
            "srv_line" => {
                open = true;
                // `(TRANSPORT)name: ENV, ENV` — the body is one token; split it here.
                let spec = child_of_kind(n, "srv_spec").map(|c| node_text(c, text)).unwrap_or("").trim();
                let (transport, rest) = match spec.strip_prefix('(').and_then(|r| r.split_once(')')) {
                    Some((t, r)) => (t.trim().to_string(), r),
                    None => (String::new(), spec),
                };
                let name = rest.split(':').next().unwrap_or("").trim().to_string();
                out.push(Decl {
                    name,
                    kind: DeclKind::Srv { transport, docs: None },
                    line: n.start_position().row,
                    description: None,
                });
            }
            "srv_docs_line" => {
                if !open {
                    continue;
                }
                if let Some(Decl { kind: DeclKind::Srv { docs, .. }, .. }) = out.last_mut() {
                    let url = child_of_kind(n, "srv_spec").map(|c| node_text(c, text)).unwrap_or("").trim();
                    if !url.is_empty() {
                        *docs = Some(url.to_string());
                    }
                }
            }
            "typ_desc" | "dto_desc" | "non_desc" => {
                // Prose right under the last declaration is its description; the
                // scanner emits one of the three kinds regardless of the tag above.
                if !open {
                    continue;
                }
                if let Some(last) = out.last_mut() {
                    let line = node_text(n, text).trim();
                    last.description = Some(match &last.description {
                        Some(d) => format!("{} {}", d, line),
                        None => line.to_string(),
                    });
                }
            }
            "comment" => {}
            // Any other line ends the prose block of the declaration above.
            _ => open = false,
        }
    }
    out
}

/// The hover text for a word: a [TYP] shows its primitive and prose, a [NON]
/// its prose, a DTO its properties, a `service:` prefix the [SRV] it names.
fn hover_text(decls: &[Decl], word: &str) -> Option<String> {
    let d = decls.iter().find(|d| d.name == word)?;
    let desc = |s: &str| match &d.description {
        Some(p) => format!("{}\n\n{}", s, p),
        None => s.to_string(),
    };
    Some(match &d.kind {
        DeclKind::Typ { type_name } => desc(&format!("**{}**: `{}`", d.name, type_name)),
        DeclKind::Non => desc(&format!("**{}** (noun)", d.name)),
        DeclKind::Dto { props } => {
            if props.is_empty() {
                format!("**{}** {{}}", d.name)
            } else {
                format!("**{}** {{ {} }}", d.name, props.join(", "))
            }
        }
        DeclKind::Srv { transport, docs } => {
            let mut s = format!("**{}:** service ({})", d.name, transport);
            if let Some(p) = &d.description {
                s.push_str(&format!("\n\n{}", p));
            }
            if let Some(u) = docs {
                s.push_str(&format!("\n\n@docs {}", u));
            }
            s
        }
    })
}

/// The 0-based line a word is declared on.
fn definition_line(decls: &[Decl], word: &str) -> Option<usize> {
    decls.iter().find(|d| d.name == word).map(|d| d.line)
}

/// Every fault name the document declares (for completions on a fault line).
fn fault_names(text: &str) -> Vec<String> {
    let Some(tree) = parse_tree(text) else { return Vec::new() };
    let root = tree.root_node();
    let mut cursor = root.walk();
    let mut out: Vec<String> = Vec::new();
    for n in root.children(&mut cursor) {
        if n.kind() != "fault_line" {
            continue;
        }
        let list = child_of_kind(n, "fault_list").map(|c| node_text(c, text)).unwrap_or("");
        for item in list.split_whitespace() {
            let name = item.split('=').next().unwrap_or(item).to_string();
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
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
                        "!".to_string(),
                        "[".to_string(),
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
        Ok(Some(CompletionResponse::Array(completions_for(&text, &prefix))))
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
        let current_line = lines.get(pos.line as usize).unwrap_or(&"");
        let col = pos.character as usize;

        let word = get_word_at_position(current_line, col);
        if word.is_empty() {
            return Ok(None);
        }
        let decls = declarations(&text);
        Ok(hover_text(&decls, &word).map(|value| Hover {
            contents: HoverContents::Markup(MarkupContent {
                kind: MarkupKind::Markdown,
                value,
            }),
            range: None,
        }))
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
        let current_line = lines.get(pos.line as usize).unwrap_or(&"");
        let col = pos.character as usize;
        let word = get_word_at_position(current_line, col);
        if word.is_empty() {
            return Ok(None);
        }
        let decls = declarations(&text);
        Ok(definition_line(&decls, &word).map(|line| {
            GotoDefinitionResponse::Array(vec![Location {
                uri: uri.clone(),
                range: line_range(line),
            }])
        }))
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

/// The completion items for a cursor whose line reads `prefix` so far: the
/// registry's tags at a line start, its modifiers inside an open `[TAG:`, the
/// document's `[SRV]` names as boundary prefixes, primitives after a colon,
/// and on a fault line the registry's well-known faults plus the document's.
fn completions_for(text: &str, prefix: &str) -> Vec<CompletionItem> {
    let reg = registry();
    let trimmed = prefix.trim_start();
    let mut items = Vec::new();

    // `[TAG:` open — the modifiers that apply to that tag.
    if let Some(open) = trimmed.strip_prefix('[')
        && let Some((tag, _)) = open.split_once(':')
        && !open.contains(']')
    {
        let tag_id = tag.to_lowercase();
        for m in reg["modifiers"].as_array().into_iter().flatten() {
            let applies = m["appliesTo"]
                .as_array()
                .is_some_and(|a| a.iter().any(|t| t.as_str() == Some(&tag_id)));
            if applies {
                items.push(CompletionItem {
                    label: m["id"].as_str().unwrap_or("").to_string(),
                    kind: Some(CompletionItemKind::ENUM_MEMBER),
                    detail: Some(m["syntax"].as_str().unwrap_or("").to_string()),
                    documentation: m["description"].as_str().map(|d| Documentation::String(d.to_string())),
                    ..Default::default()
                });
            }
        }
        return items;
    }

    // A fault line: the well-known faults (with their status) and the ones
    // already declared in this document.
    let marker = reg["faults"]["marker"].as_str().unwrap_or("!");
    if trimmed.starts_with(marker) {
        for f in reg["faults"]["wellKnown"].as_array().into_iter().flatten() {
            let id = f["id"].as_str().unwrap_or("");
            if id.contains('*') {
                continue; // a glob, not a name to insert
            }
            items.push(CompletionItem {
                label: id.to_string(),
                kind: Some(CompletionItemKind::ENUM_MEMBER),
                detail: Some(format!("HTTP {} — {}", f["status"], f["summary"].as_str().unwrap_or(""))),
                ..Default::default()
            });
        }
        for name in fault_names(text) {
            if items.iter().any(|i| i.label == name) {
                continue;
            }
            items.push(CompletionItem {
                label: name,
                kind: Some(CompletionItemKind::ENUM_MEMBER),
                detail: Some("declared in this spec".to_string()),
                ..Default::default()
            });
        }
        return items;
    }

    // Tags, at a line start (or an opened bracket).
    if trimmed.is_empty() || trimmed.starts_with('[') {
        for t in reg["tags"].as_array().into_iter().flatten() {
            items.push(CompletionItem {
                label: t["tag"].as_str().unwrap_or("").to_string(),
                kind: Some(CompletionItemKind::KEYWORD),
                detail: Some(t["label"].as_str().unwrap_or("").to_string()),
                documentation: t["summary"].as_str().map(|d| Documentation::String(d.to_string())),
                ..Default::default()
            });
        }
    }

    // Primitive types after a colon.
    if prefix.ends_with(':') || prefix.ends_with(": ") {
        for t in ["string", "number", "boolean", "void", "Uint8Array"] {
            items.push(CompletionItem {
                label: t.to_string(),
                kind: Some(CompletionItemKind::TYPE_PARAMETER),
                ..Default::default()
            });
        }
    }

    // The document's own names: declared services as `name:` prefixes, nouns,
    // types and DTOs.
    if trimmed.is_empty() || trimmed.chars().all(|c| c.is_alphanumeric() || c == '_') {
        for d in declarations(text) {
            let (label, kind, detail) = match &d.kind {
                DeclKind::Srv { transport, .. } => (
                    format!("{}:", d.name),
                    CompletionItemKind::MODULE,
                    format!("boundary service ({})", transport),
                ),
                DeclKind::Non => (d.name.clone(), CompletionItemKind::CLASS, "noun".to_string()),
                DeclKind::Typ { type_name } => (d.name.clone(), CompletionItemKind::TYPE_PARAMETER, type_name.clone()),
                DeclKind::Dto { .. } => (d.name.clone(), CompletionItemKind::STRUCT, "DTO".to_string()),
            };
            items.push(CompletionItem {
                label,
                kind: Some(kind),
                detail: Some(detail),
                ..Default::default()
            });
        }
    }

    items
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

    /// A fake `rune` that records its argv and stdin in the one finding it
    /// returns, so the delegation contract (REQ-015) is asserted end to end
    /// without building the real engine.
    fn fake_rune(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("rune");
        std::fs::write(&bin, format!("#!/bin/sh\n{}\n", body)).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    /// REQ-015: diagnostics are `rune check --json --stdin --path <file>` over
    /// the buffer — id as the code, 1-based line mapped to the editor's 0-based
    /// line, severity kept, fix appended to the message.
    #[tokio::test]
    async fn req_015_diagnostics_are_rune_check_json_over_the_buffer() {
        let dir = std::env::temp_dir().join("rune-lsp-req-015-delegate");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = fake_rune(
            &dir,
            r#"BUF=$(cat | tr "\n" "|"); printf '{"path":"x","ok":false,"findings":[{"id":"mod-duplicate","severity":"error","path":"x","line":2,"message":"duplicate [MOD]","fix":"remove one"},{"id":"typ-unused","severity":"warning","path":"x","line":0,"message":"argv=%s stdin=%s"}]}' "$*" "$BUF""#,
        );
        let spec = std::path::Path::new("/tmp/proj/spec/runes/x.rune");
        let diags = diagnostics_with(&bin, spec, "[MOD] one\n[MOD] two").await;
        assert_eq!(diags.len(), 2, "{:?}", diags);
        assert_eq!(diags[0].code, Some(NumberOrString::String("mod-duplicate".into())));
        assert_eq!(diags[0].range.start.line, 1, "1-based line 2 → editor line 1");
        assert_eq!(diags[0].severity, Some(DiagnosticSeverity::ERROR));
        assert_eq!(diags[0].message, "duplicate [MOD]\nfix: remove one");
        assert_eq!(diags[1].severity, Some(DiagnosticSeverity::WARNING));
        assert_eq!(diags[1].range.start.line, 0, "line 0 = whole file → editor line 0");
        assert_eq!(
            diags[1].message,
            "argv=check --json --stdin --path /tmp/proj/spec/runes/x.rune stdin=[MOD] one|[MOD] two"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// REQ-015: a checker that cannot run is reported, not swallowed.
    #[tokio::test]
    async fn req_015_missing_checker_is_one_diagnostic_naming_the_cause() {
        let bin = std::path::Path::new("/nonexistent/rune-binary");
        let diags = diagnostics_with(bin, std::path::Path::new("/tmp/x.rune"), "[MOD] x").await;
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].code, Some(NumberOrString::String("checker-unavailable".into())));
        assert!(diags[0].message.contains("cannot run"), "{}", diags[0].message);
        assert!(diags[0].message.contains("RUNE_BIN"), "{}", diags[0].message);
    }

    /// REQ-015: a checker that answers garbage is reported with its stderr.
    #[tokio::test]
    async fn req_015_garbage_report_is_one_diagnostic_with_stderr() {
        let dir = std::env::temp_dir().join("rune-lsp-req-015-garbage");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = fake_rune(&dir, r#"echo "boom: no such project" >&2; echo "not json""#);
        let diags = diagnostics_with(&bin, std::path::Path::new("/tmp/x.rune"), "[MOD] x").await;
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].code, Some(NumberOrString::String("checker-unavailable".into())));
        assert!(diags[0].message.contains("returned no report"), "{}", diags[0].message);
        assert!(diags[0].message.contains("boom: no such project"), "{}", diags[0].message);
        let _ = std::fs::remove_dir_all(&dir);
    }

    const SPEC: &str = "[MOD] m\n\n[REQ] task.create(InDto): TaskDto\n    db:task.save(InDto): TaskDto\n      ! timeout card-expired=402\n\n[TYP] id: string\n    a unique identifier,\n    minted by the system\n[DTO] TaskDto: id, title?\n    a persisted task\n[NON] task\n    a single todo item\n[SRV] (SIDECAR)db: DB_URL\n    the datastore\n    @docs https://docs.example.com/db\n";

    /// REQ-032: hover, definitions and the names on offer come from the grammar's
    /// CST — the prose is the desc lines under a declaration, a service's docs
    /// link is its @docs line, a DTO's shape its properties.
    #[test]
    fn req_032_hover_and_definitions_come_from_the_tree_sitter_cst() {
        let decls = declarations(SPEC);
        assert_eq!(decls.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["id", "TaskDto", "task", "db"]);
        assert_eq!(
            hover_text(&decls, "id").as_deref(),
            Some("**id**: `string`\n\na unique identifier, minted by the system")
        );
        assert_eq!(hover_text(&decls, "TaskDto").as_deref(), Some("**TaskDto** { id, title? }"));
        assert_eq!(hover_text(&decls, "task").as_deref(), Some("**task** (noun)\n\na single todo item"));
        assert_eq!(
            hover_text(&decls, "db").as_deref(),
            Some("**db:** service (SIDECAR)\n\nthe datastore\n\n@docs https://docs.example.com/db")
        );
        assert_eq!(hover_text(&decls, "nothing"), None);
        assert_eq!(definition_line(&decls, "id"), Some(6));
        assert_eq!(definition_line(&decls, "TaskDto"), Some(9));
        assert_eq!(definition_line(&decls, "task"), Some(11));
        assert_eq!(definition_line(&decls, "db"), Some(13));
        assert_eq!(fault_names(SPEC), ["timeout", "card-expired"]);
    }

    /// REQ-032: completions read the registry — tags, a tag's modifiers, the
    /// well-known faults — and the document's declared services and names.
    #[test]
    fn req_032_completions_come_from_the_registry_and_the_document() {
        let labels = |items: Vec<CompletionItem>| items.into_iter().map(|i| i.label).collect::<Vec<_>>();
        let tags = labels(completions_for(SPEC, ""));
        assert!(tags.contains(&"[REQ]".to_string()) && tags.contains(&"[SRV]".to_string()), "{:?}", tags);
        assert!(!tags.contains(&"[CTR]".to_string()));
        assert!(tags.contains(&"db:".to_string()), "declared services complete as prefixes: {:?}", tags);
        let mods = labels(completions_for(SPEC, "[TYP:"));
        assert!(mods.contains(&"uuid".to_string()) && mods.contains(&"ext".to_string()), "{:?}", mods);
        assert!(!mods.contains(&"open".to_string()), "a [REQ] modifier is not offered on [TYP]: {:?}", mods);
        let faults = labels(completions_for(SPEC, "      ! "));
        assert!(faults.contains(&"not-found".to_string()), "{:?}", faults);
        assert!(faults.contains(&"card-expired".to_string()), "the document's own faults: {:?}", faults);
        assert!(!faults.iter().any(|f| f.contains('*')), "a glob is not a name: {:?}", faults);
    }

    #[test]
    fn full_sync_last_change_wins() {
        let changes = vec![
            TextDocumentContentChangeEvent { range: None, range_length: None, text: "first".into() },
            TextDocumentContentChangeEvent { range: None, range_length: None, text: "last".into() },
        ];
        assert_eq!(full_sync_text(changes).as_deref(), Some("last"));
        assert_eq!(full_sync_text(vec![]), None);
    }

    #[test]
    fn word_at_position_resolves_trailing_cursor() {
        assert_eq!(get_word_at_position("[TYP] id: string", 7), "id");
        assert_eq!(get_word_at_position("[TYP] id: string", 8), "id");
        assert_eq!(get_word_at_position("  ", 1), "");
        assert_eq!(word_match_columns("id id", "id"), vec![(0, 2), (3, 5)]);
        assert_eq!(completion_prefix("héllo", 2), "hé");
    }
}
