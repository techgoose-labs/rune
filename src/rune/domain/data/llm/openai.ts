import type { EntryResult } from "@core/dto/types.ts";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

async function callOpenAI(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      temperature: 0,
      max_tokens: 300,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

/** Generate suggestions for violations that need LLM intelligence */
export async function suggestForResults(
  results: EntryResult[],
  specJson: string,
  readFile: (path: string) => Promise<string>,
): Promise<void> {
  const needsLlm = results.filter(
    (r) =>
      (r.rule === "structure" &&
        r.violations.some((v) => v.includes("not allowed"))) ||
      r.rule === "module-fragmentation",
  );

  if (needsLlm.length === 0) return;

  // Dedupe by path — same file might have multiple violations
  const byPath = new Map<string, EntryResult>();
  for (const r of needsLlm) {
    if (!byPath.has(r.path)) byPath.set(r.path, r);
  }

  const system =
    `You are a code architecture advisor. Given a file/folder that violates a project structure spec, suggest the EXACT path it should be moved to or the EXACT action to take.

Canonical structure spec:
${specJson}

Rules:
- Folders: key ends with "/" (e.g. "src/", "business/")
- Files: string value = any extension, object with "ext" = restricted extensions
- "<name>" = wildcard pattern matching any name
- Modules live under src/ and must have mod-root.ts, domain/, entrypoints/, dto/
- Business features need mod.ts + test.ts
- Entrypoints need a named subfolder with mod.ts inside

Respond with ONLY the suggestion — one or two sentences. Be specific with exact paths. No preamble.`;

  // Fire all calls concurrently
  const promises = [...byPath.entries()].map(async ([path, result]) => {
    try {
      let fileContent = "";
      try {
        const raw = await readFile(path);
        // Truncate to first 50 lines to keep prompt small
        fileContent = raw.split("\n").slice(0, 50).join("\n");
      } catch {
        // folder or unreadable — that's fine
      }

      const userPrompt = [
        `Path: ${path}`,
        `Target: ${result.target}`,
        `Rule: ${result.rule}`,
        `Violations: ${result.violations.join("; ")}`,
        fileContent ? `\nFile content (first 50 lines):\n${fileContent}` : "",
      ].join("\n");

      const suggestion = await callOpenAI(system, userPrompt);
      result.suggestion = suggestion;
    } catch {
      // skip failed suggestions silently
    }
  });

  await Promise.all(promises);
}
