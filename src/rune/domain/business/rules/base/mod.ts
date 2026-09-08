import type { EntryTarget, PipelineContext } from "@core/dto/types.ts";

export type CheckFn = (
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
) => Promise<string[] | null>;

export type BuildPromptFn = (
  violations: string[],
  path: string,
  target: EntryTarget,
) => string;
