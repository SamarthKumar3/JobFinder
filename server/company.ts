import { AsyncLocalStorage } from "node:async_hooks";
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { OPS } from "./config";
import { load } from "cheerio";
import { recency, type IncomingJob } from "./domain";
import { collectWorkday, workdayBoard } from "./workday";
export type CompanyJobs = IncomingJob[] & { diagnostics?: string[] };
const sourceBudget = new AsyncLocalStorage<{
  deadline: number;
  signal?: AbortSignal;
  boards: Map<string, Promise<CompanyJobs>>;
}>();
export function withSourceBudget<T>(
  work: () => Promise<T>,
  timeout = 20000,
  signal?: AbortSignal,
  boards = new Map<string, Promise<CompanyJobs>>(),
) {
  const controller = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (failed: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      combined.removeEventListener("abort", aborted);
      failed ? reject(value) : resolve(value as T);
    };
    const aborted = () =>
      finish(true, combined.reason || new Error("Company source cancelled"));
    const timer = setTimeout(
      () => controller.abort(new Error("Company source time limit reached")),
      Math.max(1, timeout),
    );
    combined.addEventListener("abort", aborted, { once: true });
    if (combined.aborted) return aborted();
    sourceBudget
      .run({ deadline: Date.now() + timeout, signal: combined, boards }, () =>
        Promise.resolve().then(work),
      )
      .then(
        (value) => finish(false, value),
        (error) => finish(true, error),
      );
  });
}
export function publicIp(ip: string) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  );
}
export async function safeGet(
  raw: string,
  redirects = 0,
  opts: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<string> {
  const budget = sourceBudget.getStore();
  if (budget?.signal?.aborted || (budget && Date.now() >= budget.deadline))
    throw new Error("Company source time limit reached");
  const u = new URL(raw);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443")
  )
    throw new Error("Company sources require public HTTPS URLs");
  const addresses = await dns.lookup(u.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some((a) => !publicIp(a.address)))
    throw new Error("Private/local addresses are not allowed");
  return new Promise((resolve, reject) => {
    const remaining = Math.min(
      25000,
      budget ? Math.max(1, budget.deadline - Date.now()) : 25000,
    );
    const req = https.request(
      u,
      {
        method: opts.method || "GET",
        signal: budget?.signal,
        headers: {
          ...opts.headers,
          "User-Agent": "JobFinder/1.0 personal job search",
          Accept: "application/json,text/html",
        },
        lookup: ((_host: any, opts: any, cb: any) =>
          opts.all
            ? cb(null, [{ address: addresses[0].address, family: 4 }])
            : cb(null, addresses[0].address, 4)) as any,
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          if (redirects >= 4) return reject(new Error("Too many redirects"));
          safeGet(new URL(res.headers.location, u).href, redirects + 1).then(
            resolve,
            reject,
          );
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
          if (text.length > 4000000)
            req.destroy(new Error("Source response too large"));
        });
        res.on("end", () => resolve(text));
        res.on("error", reject);
      },
    );
    const deadlineTimer = setTimeout(
      () => req.destroy(new Error("Company source time limit reached")),
      remaining,
    );
    req.once("close", () => clearTimeout(deadlineTimer));
    req.setTimeout(remaining, () => req.destroy(new Error("Source timed out")));
    req.on("error", reject);
    req.end(opts.body);
  });
}
const plain = (text: string) => load(text).text().trim();
export async function collectCompany(
  url: string,
  depth = 0,
): Promise<CompanyJobs> {
  const u = new URL(url),
    parts = u.pathname.split("/").filter(Boolean);
  const board = workdayBoard(url);
  if (board) {
    const cache = sourceBudget.getStore()?.boards;
    const existing = cache?.get(board.key);
    if (existing) return existing;
    const budget = sourceBudget.getStore();
    const pending = collectWorkday(
      url,
      (raw, opts) => safeGet(raw, 0, opts),
      Date.now(),
      () =>
        !budget ||
        (!budget.signal?.aborted && Date.now() < budget.deadline - 1000),
    );
    cache?.set(board.key, pending);
    return pending;
  }
  const upstream = await upstreamCompany(url);
  if (upstream !== null) return upstream;
  let api = url,
    type = "html";
  if (
    u.hostname === "boards.greenhouse.io" ||
    u.hostname === "job-boards.greenhouse.io"
  ) {
    api = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(parts[0])}/jobs?content=true`;
    type = "greenhouse";
  } else if (u.hostname === "jobs.lever.co") {
    api = `https://api.lever.co/v0/postings/${encodeURIComponent(parts[0])}?mode=json`;
    type = "lever";
  } else if (u.hostname === "jobs.ashbyhq.com") {
    api = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(parts[0])}`;
    type = "ashby";
  }
  const body = await safeGet(api);
  if (type !== "html") {
    const data = JSON.parse(body);
    const rows = type === "lever" ? data : data.jobs;
    return rows.map((j: any) => ({
      title: j.title || j.text,
      company: j.companyName || parts[0],
      location: j.location?.name || j.categories?.location || j.location || "",
      source: "company",
      apply_url: j.absolute_url || j.applyUrl || j.hostedUrl || j.jobUrl,
      description: plain(
        j.content ||
          j.descriptionPlain ||
          j.descriptionHtml ||
          j.description ||
          "",
      ),
      metadata: { provider: type, source_url: url, ...j },
    }));
  }
  const $ = load(body);
  const nodes: any[] = [];
  function visit(n: any) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (n["@type"] === "JobPosting" || n["@type"]?.includes?.("JobPosting"))
      nodes.push(n);
    if (n["@graph"]) visit(n["@graph"]);
    if (n.itemListElement) visit(n.itemListElement);
    if (n.item) visit(n.item);
  }
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      visit(JSON.parse($(el).text()));
    } catch {}
  });
  if (!nodes.length && depth === 0) {
    // Follow a bounded set of actual links discovered on the supplied careers page.
    const candidates = new Map<string, number>();
    $("a[href]").each((_, a) => {
      try {
        const target = new URL($(a).attr("href")!, url);
        target.hash = "";
        if (target.protocol !== "https:" || target.href === u.href) return;
        const ats =
          [
            "boards.greenhouse.io",
            "job-boards.greenhouse.io",
            "jobs.lever.co",
            "jobs.ashbyhq.com",
          ].includes(target.hostname) ||
          target.hostname.endsWith(".myworkdayjobs.com") ||
          target.hostname.endsWith(".myworkdaysite.com") ||
          target.hostname.endsWith(".eightfold.ai") ||
          target.hostname === "jobs.smartrecruiters.com";
        const same = target.hostname === u.hostname;
        const label = $(a).text() + " " + target.pathname;
        if (
          ats ||
          (same && /jobs?|careers?|positions?|openings?|vacanc/i.test(label))
        )
          candidates.set(
            workdayBoard(target.href)?.base || target.href,
            ats
              ? 10
              : /engineer|artificial|intelligence|python|software|india|pune|bangalore|bengaluru|gurugram/i.test(
                    label,
                  )
                ? 5
                : 1,
          );
      } catch {}
    });
    const found: IncomingJob[] = [];
    const diagnostics: string[] = [];
    for (const [link] of [...candidates]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)) {
      try {
        const rows = await collectCompany(link, 1);
        found.push(...rows);
        diagnostics.push(
          ...(rows.diagnostics || []).map((message) => `${link}: ${message}`),
        );
      } catch (error) {
        diagnostics.push(`${link}: ${String(error)}`);
      }
    }
    if (found.length || diagnostics.length)
      return Object.assign(found, { diagnostics: [...new Set(diagnostics)] });
  }
  if (!nodes.length)
    throw new Error(
      "No readable jobs found after bounded careers-link discovery. Dynamic portal needs a dedicated adapter, ATS board URL, or imported job description.",
    );
  return nodes.map((j) => ({
    title: j.title,
    company: j.hiringOrganization?.name || u.hostname,
    location:
      j.jobLocation?.address?.addressLocality || j.jobLocationType || "",
    source: "company",
    apply_url: new URL(j.url || url, url).href,
    description: plain(j.description || ""),
    metadata: j,
  }));
}

// Use downloaded Career Ops providers directly for additional company portals.
async function upstreamCompany(url: string): Promise<IncomingJob[] | null> {
  const u = new URL(url);
  let provider = "";
  const entry: any = { name: u.hostname, careers_url: url, max_pages: 1 };
  if (u.hostname === "www.google.com" && u.pathname.includes("careers")) {
    provider = "google";
    entry.name = "Google";
    entry.google = {
      location: "India",
      queries: ["AI engineer", "Python engineer"],
    };
  } else if (
    u.hostname === "amazon.jobs" ||
    u.hostname.endsWith(".amazon.jobs")
  ) {
    provider = "amazon";
    entry.name = "Amazon";
    entry.amazon = { loc_query: "India", base_query: "software engineer" };
  } else if (u.hostname.endsWith(".eightfold.ai")) provider = "eightfold";
  else if (u.hostname === "jobs.smartrecruiters.com")
    provider = "smartrecruiters";
  else return null;
  const mod = await import(
    pathToFileURL(path.join(OPS, "providers", `${provider}.mjs`)).href
  );
  let calls = 0;
  const fetchText = async (raw: string, opts: any = {}) => {
    if (++calls > 8)
      throw new Error(
        "Company provider request budget reached; scan is partial",
      );
    return safeGet(raw, 0, {
      method: opts.method,
      body: opts.body,
      headers: opts.headers,
    });
  };
  const ctx = {
    transport: "http",
    maxPages: 1,
    fetchText,
    fetchJson: async (raw: string, opts: any = {}) => {
      if (
        provider === "amazon" &&
        Number(new URL(raw).searchParams.get("offset")) > 0
      )
        return { jobs: [] };
      return JSON.parse(await fetchText(raw, opts));
    },
  };
  const rows = await mod.default.fetch(entry, ctx),
    jobs: IncomingJob[] = [];
  for (const j of rows
    .filter(
      (j: any) =>
        /engineer|developer|scientist|artificial|intelligence/i.test(j.title) &&
        /india|pune|bangalore|bengaluru|delhi|gurugram|gurgaon|noida/i.test(
          j.location || "",
        ),
    )
    .slice(0, 12)) {
    if (recency(j) !== "fresh") continue;
    let description = j.description || "";
    if (description.length < 100) {
      try {
        const html = await safeGet(j.url),
          $ = load(html);
        $("script,style,nav,header,footer").remove();
        description = ($('[itemprop="description"]').text() || $("main").text())
          .replace(/\s+/g, " ")
          .trim();
        if (
          !/qualifications|responsibilities|requirements|experience/i.test(
            description,
          )
        )
          description = "";
      } catch {}
    }
    if (description.length >= 100)
      jobs.push({
        title: j.title,
        company: j.company || entry.name,
        location: j.location || "",
        source: "company",
        apply_url: j.url,
        description: description.slice(0, 100000),
        metadata: {
          provider: `career-ops/${provider}`,
          source_url: url,
          coverage: "Bounded first page; not exhaustive",
          ...j,
        },
      });
  }
  if (!jobs.length)
    throw new Error(
      `Career Ops ${provider}: no complete relevant jobs in bounded last-24-hour scan; posting dates, location/title filters or detail extraction may have excluded results`,
    );
  return jobs;
}
