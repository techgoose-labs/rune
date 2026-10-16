// GENERATED from lang/keywords.json by scripts/generate.mjs — do not edit by hand.
// Edit the registry and regenerate.
#ifndef RUNE_SCANNER_CONFIG_H
#define RUNE_SCANNER_CONFIG_H

// The registry's indent table (the columns `rune fmt` writes).
#define RUNE_INDENT_UNIT 4
#define RUNE_INDENT_STEP 4
#define RUNE_INDENT_FAULT 6
#define RUNE_INDENT_CASE 8
#define RUNE_INDENT_CASE_STEP 8
#define RUNE_INDENT_CASE_FAULT 10
#define RUNE_INDENT_DESCRIPTION 4
#define RUNE_INDENT_BODY 4
#define RUNE_INDENT_FAULT_OFFSET 2

// The fault marker: a line starting with it is never prose.
#define RUNE_FAULT_MARKER '!'

#endif
