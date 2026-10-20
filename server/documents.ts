import type { PoolClient } from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { z } from "zod";
import { DATA } from "./config";
import { pool } from "./db";
import { draft, draftResume, evaluate, type documentSchema } from "./ai";
import { renderResume, type ResumeContent } from "./resume";
export async function renderDocument(
  kind: "resume" | "cover",
  content: z.infer<typeof documentSchema> | ResumeContent,
  file: string,
) {
  if (kind === "cover") {
    if (!("sections" in content))
      throw new Error("Cover letter content is invalid");
    const paragraphs = [
      new Paragraph({ text: content.title, heading: HeadingLevel.TITLE }),
      ...content.sections.flatMap((s) => [
        ...(s.heading
          ? [
              new Paragraph({
                text: s.heading,
                heading: HeadingLevel.HEADING_1,
              }),
            ]
          : []),
        ...s.paragraphs.map(
          (p) =>
            new Paragraph({
              children: [new TextRun(p.text)],
              spacing: { after: 160 },
            }),
        ),
      ]),
    ];
    const doc = new Document({
      styles: {
        default: {
          document: {
            run: { font: "Calibri", size: 22, color: "000000" },
            paragraph: { spacing: { line: 276 } },
          },
        },
      },
      sections: [
        {
          properties: {
            page: {
              size: { width: 11906, height: 16838 },
              margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 },
            },
          },
          children: paragraphs,
        },
      ],
    });
    await fs.writeFile(file, await Packer.toBuffer(doc));
  } else {
    if (!("edits" in content))
      throw new Error("Resume must use the original PDF template");
    return renderResume(content, file);
  }
}
let active = false;
let wakeAgain = false;
export async function drainArtifacts() {
  if (active) {
    wakeAgain = true;
    return;
  }
  active = true;
  let client: PoolClient | undefined;
  let locked = false;
  try {
    client = await pool.connect();
    locked = (
      await client.query("SELECT pg_try_advisory_lock(7284520) AS locked")
    ).rows[0].locked;
    if (!locked) return;
    await client.query(`UPDATE tasks SET state='queued' WHERE state='running'`);
    do {
      wakeAgain = false;
      for (;;) {
        const task = (
          await client.query(
            `UPDATE tasks SET state='running' WHERE id=(SELECT id FROM tasks WHERE state='queued' ORDER BY created_at LIMIT 1) RETURNING *`,
          )
        ).rows[0];
        if (!task) break;
        try {
          const job = (
            await client.query("SELECT * FROM jobs WHERE id=$1", [task.job_id])
          ).rows[0];
          if (!job || job.state !== "evaluated" || Number(job.score) < 2)
            throw new Error(
              "Job needs a completed evaluation and score of at least 2",
            );
          const kind = task.kind as "resume" | "cover",
            content =
              kind === "resume"
                ? await draftResume(job, job.evaluation)
                : await draft("cover", job, job.evaluation);
          const dir = path.join(DATA, "artifacts");
          await fs.mkdir(dir, { recursive: true });
          const filename = `${task.id}.${kind === "resume" ? "pdf" : "docx"}`;
          const renderedText = await renderDocument(
            kind,
            content,
            path.join(dir, filename),
          );
          // Retain structured edits for faithful re-rendering without another AI call.
          await fs.writeFile(
            path.join(dir, `${task.id}.json`),
            JSON.stringify(content),
          );
          const tailoredEvaluation =
            kind === "resume" ? await evaluate(job, renderedText) : null;
          await client.query(
            `UPDATE tasks SET state='completed',result=$2,finished_at=now() WHERE id=$1`,
            [
              task.id,
              {
                filename,
                download_url: `/api/tasks/${task.id}/download`,
                changes: content.changes,
                remainingGaps: content.remainingGaps,
                tailoredEvaluation,
                originalScore: job.score,
                contentHash: job.content_hash,
                reviewRequired: true,
              },
            ],
          );
        } catch (e) {
          await client.query(
            `UPDATE tasks SET state='error',error=$2,finished_at=now() WHERE id=$1`,
            [task.id, String(e)],
          );
        }
      }
    } while (wakeAgain);
  } finally {
    try {
      if (locked && client)
        await client.query("SELECT pg_advisory_unlock(7284520)");
    } finally {
      client?.release();
      active = false;
    }
  }
}
