import { prepareDirectories } from "./config";
import { migrate, pool } from "./db";
import { runWorkflow } from "./workflow";
try {
  await prepareDirectories();
  await migrate();
  console.log(
    JSON.stringify(
      await runWorkflow(process.argv[2] || "scheduled-cli"),
      null,
      2,
    ),
  );
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
