import test from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../server/process";
import { withSourceBudget, safeGet } from "../server/company";
test("timed-out owned workers reject promptly instead of leaving a running workflow", async () => {
  const start = Date.now();
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeout: 100,
    }),
    /timed out/,
  );
  assert.ok(Date.now() - start < 3000);
});
test("cancelled workflow aborts its owned worker", async () => {
  const controller = new AbortController();
  const work = runProcess(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(work, /cancelled/);
});
test("expired company budget prevents further fetch attempts", async () => {
  await assert.rejects(
    withSourceBudget(() => safeGet("https://example.com/"), -1),
    /time limit/,
  );
});
