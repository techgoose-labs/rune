//! `rune-syntax format` end to end, through the built binary (`rune fmt` is a
//! verbatim pass-through to it — src/bootstrap/mod.ts). REQ-001 / REQ-002.
//!
//! `fixtures/payments.rune` is a spec `rune check` accepts, shaped like the one
//! in coms ticket 20260921T050158Z-w15-47057: every top-level tag form
//! (`[MOD]`, `[REQ:open]`, `[DTO:core]`, `[TYP:ext,uuid]`, `[TYP:example=…]`,
//! `[NON]`), comments at column 0 directly after a body, comments inside a step's
//! faults, and a poly block. Formatting it must be a no-op, byte for byte.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

fn fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

/// Write `content` to a temp .rune, run `rune-syntax format [--check]` on it, and
/// return the process output plus the file's content afterwards.
fn format_in_temp(content: &str, check: bool) -> (Output, String) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("payments.rune");
    fs::write(&path, content).unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_rune-syntax"));
    cmd.arg("format").arg(&path);
    if check {
        cmd.arg("--check");
    }
    let out = cmd.output().expect("run rune-syntax");
    let after = fs::read_to_string(&path).unwrap();
    (out, after)
}

fn stdout(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn req_001_canonical_spec_round_trips_byte_identically() {
    // The ticket's repro: copy the spec, run fmt on the copy, diff — empty diff.
    let canon = fixture("payments.rune");
    let (out, after) = format_in_temp(&canon, false);
    assert!(out.status.success(), "stderr:\n{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(after, canon, "format changed a check-clean spec");
}

#[test]
fn req_001_check_mode_accepts_the_canonical_spec() {
    let canon = fixture("payments.rune");
    let (out, after) = format_in_temp(&canon, true);
    assert!(out.status.success(), "stdout:\n{}", stdout(&out));
    assert!(stdout(&out).contains("properly formatted"), "stdout:\n{}", stdout(&out));
    assert_eq!(after, canon, "--check must not write");
}

#[test]
fn req_001_mis_indented_top_level_tags_are_pulled_to_column_zero() {
    // payments.messy.rune = the canonical spec with every column-0 tag line
    // indented 4 (comments untouched). fmt restores the canonical file exactly.
    let canon = fixture("payments.rune");
    let messy = fixture("payments.messy.rune");
    assert_ne!(messy, canon, "the messy fixture must differ from the canonical one");
    let (out, after) = format_in_temp(&messy, false);
    assert!(out.status.success(), "stderr:\n{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(after, canon);
}

#[test]
fn req_002_comment_lines_are_left_exactly_as_written() {
    // A column-0 comment right after a body, and a comment among a step's
    // faults, both survive untouched — the parser skips comment lines, so their
    // indent is the author's alone.
    let spec = "[TYP] ok: boolean\n    whether it answered\n// minted by the gateway\n[TYP:ext,uuid] cardId: string\n    a token\n\n[REQ] card.open(OpenCardDto): CardDto\n    ex:nmi.tokenise(pan): cardId\n      // the issuer said no\n      ! declined\n    card::toDto(cardId): CardDto\n";
    let (out, after) = format_in_temp(spec, false);
    assert!(out.status.success());
    assert_eq!(after, spec);
}
