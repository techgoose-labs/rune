; Rune syntax highlighting
; GENERATED from lang/keywords.json by scripts/generate.mjs — do not edit by hand.
; Edit the registry and regenerate.
; Capture names match the @rune.* groups defined in the editor ftplugin;
; every pattern references a node that exists in the generated grammar.

; Tags: structural anchors
(req_tag) @rune.tag
(mod_tag) @rune.tag
(ent_tag) @rune.tag
(ply_tag) @rune.tag
(cse_tag) @rune.tag
(new_tag) @rune.tag
(ret_tag) @rune.tag
(typ_tag) @rune.tag
(dto_tag) @rune.tag
(non_tag) @rune.tag
(srv_tag) @rune.tag

; Nouns: subjects (before . or ::) and declared names
(req_line (identifier) @rune.noun)
(signature (identifier) @rune.noun)
(mod_line (mod_name) @rune.noun)
(cse_line (identifier) @rune.noun)
(new_line (identifier) @rune.noun)
(non_line (identifier) @rune.noun)

; Verbs: actions (after . or ::)
(method_name) @rune.verb

; Types: DTOs and type references
(dto_reference) @rune.type
(dto_def_name) @rune.type
(return_type (type_name) @rune.type)
(array_type (type_name) @rune.type)
(generic_type (type_name) @rune.type)
(typed_param (type_name) @rune.type)
(typ_type (type_name) @rune.type)
(typ_generic_type (type_name) @rune.type)
(typ_tuple_type (type_name) @rune.type)

; String enum values
(typ_enum_value) @rune.fault

; Parameters, DTO properties, declared type names and value names
(param_name) @rune.param
(property_name) @rune.param
(typ_name) @rune.param
(value_name (identifier) @rune.param)

; Boundaries: system edges (service: prefix)
(service_prefix) @rune.boundary

; Faults
(fault_marker) @rune.fault
(fault_list) @rune.fault

; Punctuation / chrome
(dto_optional_marker) @rune.chrome
(dto_array_suffix) @rune.chrome

; Descriptions & comments
(typ_desc) @rune.comment
(dto_desc) @rune.comment
(non_desc) @rune.comment
(srv_docs_line) @rune.comment
(comment) @rune.comment
