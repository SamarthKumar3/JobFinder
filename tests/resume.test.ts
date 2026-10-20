import test from "node:test";
import assert from "node:assert/strict";
import {
  resumeSchema,
  validateResumeEdits,
  type ResumeTemplate,
} from "../server/resume";

const template: ResumeTemplate = {
  pages: 1,
  cv: "Built Python services.",
  slots: [
    {
      id: "p1-1",
      section: "WORK EXPERIENCE",
      context: "Employer A",
      text: "Built Python services.",
      maxLines: 1,
    },
  ],
};
const content = () =>
  resumeSchema.parse({
    edits: [
      {
        id: "p1-1",
        text: "Built Python services.",
        boldKeywords: ["Python"],
        evidence: ["Built Python services."],
      },
    ],
    changes: [],
    remainingGaps: [],
  });
test("resume edits retain every original paragraph and its own source evidence", () => {
  assert.doesNotThrow(() => validateResumeEdits(content(), template));
  const missing = content();
  missing.edits = [];
  assert.throws(
    () => validateResumeEdits(missing, template),
    /missing original paragraphs/,
  );
  const duplicate = content();
  duplicate.edits.push(duplicate.edits[0]);
  assert.throws(() => validateResumeEdits(duplicate, template), /duplicate/);
  const foreign = content();
  foreign.edits[0].evidence = ["Worked at Employer B"];
  assert.throws(
    () => validateResumeEdits(foreign, template),
    /original paragraph/,
  );
});
test("resume styling requires real keywords and excludes draft banners", () => {
  const draft = content();
  draft.edits[0].text = "Draft Python resume";
  assert.throws(() => validateResumeEdits(draft, template), /Draft labels/);
  const absent = content();
  absent.edits[0].boldKeywords = ["Kubernetes"];
  assert.throws(() => validateResumeEdits(absent, template), /missing/);
  const plain = content();
  plain.edits[0].boldKeywords = [];
  assert.throws(
    () => validateResumeEdits(plain, template),
    /bold relevant keywords/,
  );
});
