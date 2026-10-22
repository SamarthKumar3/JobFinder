import test from "node:test";
import assert from "node:assert/strict";
import { evaluationDate } from "../src/date";
import {
  canStartEvaluation,
  EVALUATION_TIMEOUT_MS,
  FINISH_RESERVE_MS,
} from "../server/workflow-budget";
import { withSourceBudget } from "../server/company";

test("evaluation dates use the requested clock/date format in India regardless of host timezone", () => {
  assert.equal(
    evaluationDate("2026-10-22T18:05:00Z"),
    "11:35 PM 22 Oct. 2026.",
  );
  assert.equal(
    evaluationDate("2026-10-22T20:00:00Z"),
    "01:30 AM 23 Oct. 2026.",
  );
  assert.equal(evaluationDate(null), "—");
});
test("workflow reserves enough time to finish an evaluation and persist its result", () => {
  const now = 1000,
    needed = EVALUATION_TIMEOUT_MS + FINISH_RESERVE_MS;
  assert.equal(canStartEvaluation(now + needed, now), true);
  assert.equal(canStartEvaluation(now + needed - 1, now), false);
  assert.equal(canStartEvaluation(now - 1, now), false);
});
test("company source deadlines bound even a stalled provider or DNS operation", async () => {
  const start = Date.now();
  await assert.rejects(
    withSourceBudget(() => new Promise(() => {}), 30),
    /time limit/,
  );
  assert.ok(Date.now() - start < 1000);
  const controller = new AbortController();
  const work = withSourceBudget(
    () => new Promise(() => {}),
    10000,
    controller.signal,
  );
  controller.abort(new Error("Test cancelled"));
  await assert.rejects(work, /Test cancelled/);
});
