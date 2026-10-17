//! The rune grammar as a tree-sitter language (REQ-032): the one parser of
//! record, generated from `lang/keywords.json`, linked here for `rune fmt`, the
//! LSP's hover / definitions / completions, and anything else on the Rust side.
//!
//! ```
//! let mut parser = tree_sitter::Parser::new();
//! parser.set_language(&tree_sitter_rune::LANGUAGE.into()).unwrap();
//! let tree = parser.parse("[MOD] x\n", None).unwrap();
//! assert!(!tree.root_node().has_error());
//! ```

use tree_sitter_language::LanguageFn;

unsafe extern "C" {
    fn tree_sitter_rune() -> *const ();
}

/// The tree-sitter [`LanguageFn`] for this grammar.
pub const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_rune) };

/// The content of the [`node-types.json`][] file for this grammar.
///
/// [`node-types.json`]: https://tree-sitter.github.io/tree-sitter/using-parsers/6-static-node-types
pub const NODE_TYPES: &str = include_str!("../../src/node-types.json");

/// The syntax highlighting query (generated from the registry).
pub const HIGHLIGHTS_QUERY: &str = include_str!("../../../queries/highlights.scm");

#[cfg(test)]
mod tests {
    #[test]
    fn can_load_grammar() {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&super::LANGUAGE.into())
            .expect("Error loading rune parser");
        let tree = parser
            .parse("[REQ] a.b(InDto): OutDto\n    x::y(InDto): OutDto\n      ! timeout\n", None)
            .unwrap();
        assert!(!tree.root_node().has_error(), "{}", tree.root_node().to_sexp());
    }
}
