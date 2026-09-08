import { z } from "#zod";

export type EntryTarget = string | "folder";

export interface ExportInfo {
  name: string;
  kind: string;
  type: string;
}

export interface Location {
  uri: string;
  line: number;
  character: number;
}

export interface Diagnostic {
  message: string;
  severity: "error" | "warning" | "info" | "hint";
  line: number;
  character: number;
}

export interface LspConfig {
  command: string;
  args: string[];
  initializationOptions?: Record<string, unknown>;
}

export interface LspCapabilities {
  documentSymbol: boolean;
  hover: boolean;
  references: boolean;
  implementation: boolean;
  definition: boolean;
  diagnostics: boolean;
}

export interface LspContext {
  capabilities: LspCapabilities;
  getExportTypes(relPath: string): Promise<ExportInfo[]>;
  getSiblingExportSignatures(
    businessDir: string,
    featureDirs: string[],
  ): Promise<Map<string, ExportInfo[]>>;
  getSymbolType(relPath: string, symbolName: string): Promise<string | null>;
  findSymbolReferences(
    relPath: string,
    symbolName: string,
  ): Promise<Location[]>;
  findSymbolImplementations(
    relPath: string,
    symbolName: string,
  ): Promise<Location[]>;
  findSymbolDefinition(
    relPath: string,
    symbolName: string,
  ): Promise<Location[]>;
  getDiagnostics(relPath: string): Promise<Diagnostic[]>;
}

export const PipelineContextSchema = z.object({
  targetDir: z.string(),
  files: z.array(z.string()),
  dirs: z.array(z.string()),
});

export interface PipelineContext {
  targetDir: string;
  files: string[];
  dirs: string[];
  getFileContent(rel: string): Promise<string>;
  getImports(rel: string): Promise<string[]>;
  lsp: LspContext | null;
}

export const EntryResultSchema = z.object({
  path: z.string(),
  target: z.string(),
  rule: z.string(),
  violations: z.array(z.string()),
  suggestion: z.string().optional(),
});

export interface EntryResult {
  path: string;
  target: EntryTarget;
  rule: string;
  violations: string[];
  suggestion?: string;
}

export interface RuleDefinition {
  name: string;
  description: string;
  check(
    path: string,
    target: EntryTarget,
    ctx: PipelineContext,
  ): Promise<string[] | null>;
  systemPrompt: string;
  buildPrompt(violations: string[], path: string, target: EntryTarget): string;
}
