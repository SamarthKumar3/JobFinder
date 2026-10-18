import { spawn } from "node:child_process";
export function runProcess(
  exe: string,
  args: string[],
  options: { cwd?: string; input?: string; timeout?: number } = {},
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeout || 600000);
    child.stdout.on("data", (b) => {
      stdout += b;
      if (stdout.length > 5000000) child.kill();
    });
    child.stderr.on("data", (b) => {
      stderr = (stderr + b).slice(-12000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 && !timedOut
        ? resolve(stdout)
        : reject(
            new Error(
              timedOut
                ? "Worker timed out"
                : `${exe} failed (${code}): ${stderr.slice(-2000)}`,
            ),
          );
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input || "");
  });
}
