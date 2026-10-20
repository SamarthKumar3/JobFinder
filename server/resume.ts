import path from "node:path";
import { z } from "zod";
import { ROOT } from "./config";
import { runProcess } from "./process";

export const resumeSchema = z.object({
  edits: z.array(
    z.object({
      id: z.string(),
      text: z.string().min(1),
      boldKeywords: z.array(z.string().min(1)),
      evidence: z.array(z.string().min(1)).min(1),
    }),
  ),
  changes: z.array(z.string()),
  remainingGaps: z.array(z.string()),
});
export type ResumeContent = z.infer<typeof resumeSchema>;
export type ResumeTemplate = {
  pages: number;
  cv: string;
  slots: {
    id: string;
    section: string;
    context: string;
    text: string;
    maxLines: number;
  }[];
};
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
export function validateResumeEdits(
  content: ResumeContent,
  template: ResumeTemplate,
) {
  const originals = new Map(template.slots.map((s) => [s.id, s]));
  const seen = new Set<string>();
  for (const edit of content.edits) {
    const original = originals.get(edit.id);
    if (!original || seen.has(edit.id))
      throw new Error("Unknown or duplicate resume paragraph");
    seen.add(edit.id);
    if (/\bdraft\b/i.test(edit.text))
      throw new Error("Draft labels are not allowed in resumes");
    for (const evidence of edit.evidence)
      if (
        !normalize(evidence) ||
        !normalize(original.text).includes(normalize(evidence))
      )
        throw new Error(
          `Resume evidence must match the original paragraph ${edit.id}`,
        );
    for (const keyword of edit.boldKeywords)
      if (!edit.text.toLowerCase().includes(keyword.toLowerCase()))
        throw new Error(`Bold keyword is missing from ${edit.id}`);
  }
  if (seen.size !== originals.size)
    throw new Error("Resume is missing original paragraphs");
  if (!content.edits.some((e) => e.boldKeywords.length))
    throw new Error("Resume must bold relevant keywords");
}
export async function resumeWorker(
  command: "template" | "check" | "render",
  content?: ResumeContent,
  file?: string,
) {
  return JSON.parse(
    await runProcess(
      process.env.PYTHON_BIN || path.join(ROOT, ".venv/Scripts/python.exe"),
      [
        "-X",
        "utf8",
        path.join(ROOT, "scripts/resume_pdf.py"),
        command,
        path.resolve(
          process.env.RESUME_PATH || "Samarth_Kumar_Bhardwaj_Resume.pdf",
        ),
        ...(file ? [file] : []),
      ],
      {
        cwd: ROOT,
        input: content ? JSON.stringify(content) : undefined,
        timeout: 60000,
      },
    ),
  );
}
export async function resumeTemplate(): Promise<ResumeTemplate> {
  return resumeWorker("template");
}
export async function renderResume(
  content: ResumeContent,
  file: string,
): Promise<string> {
  validateResumeEdits(content, await resumeTemplate());
  return (await resumeWorker("render", content, file)).text;
}
