import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ask } from "../server/ai";
import { DATA } from "../server/config";

test("a locked worker folder does not discard a successful result or mask an actual evaluation error", async () => {
  const write = fs.writeFile.bind(fs),
    remove = fs.rm.bind(fs);
  const originalProvider = process.env.AI_PROVIDER,
    originalBin = process.env.CODEX_BIN;
  const dirs: string[] = [];
  let response = '{"ok":true}';
  try {
    process.env.AI_PROVIDER = "codex";
    process.env.CODEX_BIN = process.execPath;
    mock.method(
      fs,
      "writeFile",
      async (...args: Parameters<typeof fs.writeFile>) => {
        await write(...args);
        if (String(args[0]).endsWith("schema.json")) {
          const dir = path.dirname(String(args[0]));
          dirs.push(dir);
          // Stand-in CLI consumes stdin and writes the expected structured result.
          await write(
            path.join(dir, "exec"),
            `import fs from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],${JSON.stringify(response)}));`,
          );
        }
      },
    );
    mock.method(fs, "rm", async () => {
      throw Object.assign(new Error("folder locked"), { code: "EBUSY" });
    });
    const warning = mock.method(console, "warn", () => {});
    assert.deepEqual(
      await ask(
        z.object({ ok: z.boolean() }),
        "Test only",
        {},
        { timeout: 5000 },
      ),
      { ok: true },
    );
    response = "invalid JSON";
    await assert.rejects(
      ask(z.object({ ok: z.boolean() }), "Test only", {}, { timeout: 5000 }),
      SyntaxError,
    );
    assert.equal(warning.mock.callCount(), 2);
  } finally {
    mock.restoreAll();
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = originalBin;
    for (const dir of dirs) {
      assert.ok(
        path.resolve(dir).startsWith(path.resolve(DATA, "workers") + path.sep),
      );
      await remove(dir, { recursive: true, force: true });
    }
  }
});
