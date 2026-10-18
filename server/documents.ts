import fs from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { z } from "zod";
import { DATA } from "./config";
import { pool } from "./db";
import { draft, evaluate, type documentSchema } from "./ai";
export async function renderDocument(
  kind: "resume" | "cover",
  content: z.infer<typeof documentSchema>,
  file: string,
) {
  if (kind === "cover") {
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
    const pdf = new PDFDocument({
      size: "A4",
      margin: 45,
      info: { Title: content.title },
    });
    const chunks: Buffer[] = [];
    pdf.on("data", (b) => chunks.push(b));
    const done = new Promise<Buffer>((resolve, reject) => {
      pdf.on("end", () => resolve(Buffer.concat(chunks)));
      pdf.on("error", reject);
    });
    pdf.font("Helvetica-Bold").fontSize(17).text(content.title).moveDown(0.6);
    for (const section of content.sections) {
      if (section.heading) {
        if (pdf.y > 720) pdf.addPage();
        pdf
          .font("Helvetica-Bold")
          .fontSize(11)
          .text(section.heading)
          .moveDown(0.3);
      }
      for (const p of section.paragraphs)
        pdf
          .font("Helvetica")
          .fontSize(10)
          .text(p.text, { lineGap: 2 })
          .moveDown(0.5);
      pdf.moveDown(0.3);
    }
    pdf.end();
    await fs.writeFile(file, await done);
  }
}
let active = false;
export async function drainArtifacts() {
  if (active) return;
  active = true;
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (
      await client.query("SELECT pg_try_advisory_lock(7284520) AS locked")
    ).rows[0].locked;
    if (!locked) return;
    await client.query(`UPDATE tasks SET state='queued' WHERE state='running'`);
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
          content = await draft(kind, job, job.evaluation);
        const dir = path.join(DATA, "artifacts");
        await fs.mkdir(dir, { recursive: true });
        const filename = `${task.id}.${kind === "resume" ? "pdf" : "docx"}`;
        await renderDocument(kind, content, path.join(dir, filename));
        const tailoredEvaluation =
          kind === "resume"
            ? await evaluate(
                job,
                content.sections
                  .flatMap((s) => s.paragraphs.map((p) => p.text))
                  .join("\n"),
              )
            : null;
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
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(7284520)");
    client.release();
    active = false;
  }
}
