// The external scanner: the two things a DFA cannot decide line by line.
//
//   service_prefix  `name:` with exactly ONE colon (not the `::` static separator)
//   *_desc          an indented prose line that is not code
//
// Faults are no longer the scanner's business: a fault line declares itself with
// the registry's marker (`! not-found`), so the grammar lexes it (REQ-018).
// Indentation is presentation (REQ-033): prose is any indented line that is not
// a tag, a fault, a doc link, a comment or a step — the exact column is `rune
// fmt`'s, and the constants below come from the registry's indent table.

#include "tree_sitter/parser.h"
#include "scanner-config.h"
#include <stdbool.h>

enum TokenType {
  TYP_DESC,
  DTO_DESC,
  NON_DESC,
  SERVICE_PREFIX,
};

void *tree_sitter_rune_external_scanner_create() { return NULL; }
void tree_sitter_rune_external_scanner_destroy(void *payload) {}
unsigned tree_sitter_rune_external_scanner_serialize(void *payload, char *buffer) { return 0; }
void tree_sitter_rune_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {}

static bool is_ident_start(int32_t c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
}

static bool is_ident_char(int32_t c) {
  return is_ident_start(c) || (c >= '0' && c <= '9');
}

static bool is_verb_char(int32_t c) {
  return is_ident_char(c) || c == '-';
}

// Does the line read as code — a step `noun.verb(` / `Noun::verb(` (with an
// optional `@ METHOD /path` clause before the parens) or a ws topic
// `verb(…):` — rather than prose? Prose like "e.g. put()" or "note(s) are kept"
// does not: the step shape needs the separator and the paren contiguous with the
// names, the topic shape needs `):` after the parens.
static bool looks_like_code(const char *buf, int len) {
  int i = 0;
  if (i >= len || !is_ident_start(buf[i])) return false;
  while (i < len && is_ident_char(buf[i])) i++;
  if (i < len && buf[i] == '(') {
    // ws topic: verb(…): …
    while (i < len && buf[i] != ')') i++;
    if (i >= len) return false;
    i++;
    while (i < len && buf[i] == ' ') i++;
    return i < len && buf[i] == ':';
  }
  if (i < len && buf[i] == '.') i++;
  else if (i + 1 < len && buf[i] == ':' && buf[i + 1] == ':') i += 2;
  else return false;
  if (i >= len || !is_ident_start(buf[i])) return false;
  while (i < len && is_verb_char(buf[i])) i++;
  while (i < len && buf[i] == ' ') i++;
  if (i < len && buf[i] == '@') {
    while (i < len && buf[i] != '(') i++;
  }
  return i < len && buf[i] == '(';
}

bool tree_sitter_rune_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  bool want_typ_desc = valid_symbols[TYP_DESC];
  bool want_dto_desc = valid_symbols[DTO_DESC];
  bool want_non_desc = valid_symbols[NON_DESC];
  bool want_desc = want_typ_desc || want_dto_desc || want_non_desc;
  bool want_service = valid_symbols[SERVICE_PREFIX];
  if (!want_desc && !want_service) return false;

  // The scanner is invoked at the raw line start (before the indent is consumed
  // as extras), so both externals share one entry point.
  if (lexer->get_column(lexer) != 0) return false;

  // Indentation, in columns: a tab is one indent unit (the registry's).
  int columns = 0;
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
    columns += lexer->lookahead == '\t' ? RUNE_INDENT_UNIT : 1;
    lexer->advance(lexer, false);
  }

  char buf[256];
  int len = 0;

  // Service boundary prefix: an identifier + exactly ONE colon (not `::`).
  if (is_ident_start(lexer->lookahead)) {
    while (is_verb_char(lexer->lookahead) && len < 255) {
      buf[len++] = (char)lexer->lookahead;
      lexer->advance(lexer, false);
    }
    if (lexer->lookahead == ':') {
      lexer->advance(lexer, false);
      if (lexer->lookahead != ':') {
        if (!want_service) return false;
        lexer->result_symbol = SERVICE_PREFIX;
        lexer->mark_end(lexer);
        return true;
      }
      if (len < 255) buf[len++] = ':';
    }
  }

  // Prose: indented, wanted, and not something else by its first token.
  if (!want_desc || columns == 0) return false;
  if (len == 0) {
    int32_t c = lexer->lookahead;
    if (c == '[' || c == RUNE_FAULT_MARKER || c == '@' || c == '/' ||
        c == '\n' || c == '\r' || c == 0) {
      return false;
    }
  }
  while (lexer->lookahead != '\n' && lexer->lookahead != '\r' && lexer->lookahead != 0 && len < 255) {
    buf[len++] = (char)lexer->lookahead;
    lexer->advance(lexer, false);
  }
  buf[len] = '\0';
  if (looks_like_code(buf, len)) return false;

  if (want_typ_desc) lexer->result_symbol = TYP_DESC;
  else if (want_dto_desc) lexer->result_symbol = DTO_DESC;
  else lexer->result_symbol = NON_DESC;
  return true;
}
