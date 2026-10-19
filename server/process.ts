import { spawn } from "node:child_process";
export function runProcess(
  exe: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    timeout?: number;
    signal?: AbortSignal;
  } = {},
) {
  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Worker cancelled"));
      return;
    }
    const child = spawn(exe, args, {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      error ? reject(error) : resolve(stdout);
    };
    const stop = (message: string) => {
      // Terminate only this owned worker and its descendants, never unrelated processes.
      if (process.platform === "win32" && child.pid)
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        }).on("error", () => {});
      else child.kill("SIGTERM");
      finish(new Error(message));
    };
    const cancel = () => stop("Worker cancelled");
    const timer = setTimeout(
      () => stop("Worker timed out"),
      options.timeout || 600000,
    );
    options.signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (b) => {
      stdout += b;
      if (stdout.length > 5000000) stop("Worker output exceeded its limit");
    });
    child.stderr.on("data", (b) => {
      stderr = (stderr + b).slice(-12000);
    });
    child.on("error", (e) => finish(e));
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(`${exe} failed (${code}): ${stderr.slice(-2000)}`),
      ),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(options.input || "");
  });
}
