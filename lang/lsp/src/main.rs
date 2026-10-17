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
    if let Ok(p) = std::env::var("RUNE_BIN") {
        if !p.is_empty() {
            return std::path::PathBuf::from(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sibling = dir.join("rune");
            if sibling.is_file() {
                return sibling;
            }
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

    /// REQ-015: a checker that answers without a report is reported with its stderr.
    #[tokio::test]
    async fn req_015_garbage_report_is_one_diagnostic_with_stderr() {
        let dir = std::env::temp_dir().join("rune-lsp-req-015-garbage");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = fake_rune(&dir, "cat >/dev/null; echo 'boom: no such root' >&2; exit 2");
        let diags = diagnostics_with(&bin, std::path::Path::new("/tmp/x.rune"), "[MOD] x").await;
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].code, Some(NumberOrString::String("checker-unavailable".into())));
        assert!(diags[0].message.contains("boom: no such root"), "{}", diags[0].message);
        let _ = std::fs::remove_dir_all(&dir);
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
