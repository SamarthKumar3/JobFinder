import { runProcess } from "./process";
import { ROOT } from "./config";
import { load } from "cheerio";
import { jobSchema, type IncomingJob } from "./domain";
import { safeGet, withSourceBudget } from "./company";
const plain = (html: string) => load(html).text().replace(/\s+/g, " ").trim();
export function extractJobPage(url: string, html: string): IncomingJob {
  const u = new URL(url),
    $ = load(html);
  const postings: any[] = [];
  function visit(n: any) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (
      n["@type"] === "JobPosting" ||
      (Array.isArray(n["@type"]) && n["@type"].includes("JobPosting"))
    )
      postings.push(n);
    if (n["@graph"]) visit(n["@graph"]);
    if (n.itemListElement) visit(n.itemListElement);
    if (n.item) visit(n.item);
  }
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      visit(JSON.parse($(el).text()));
    } catch {}
  });
  if (postings.length > 1)
    throw new Error(
      "This URL contains multiple jobs. Paste an individual posting URL.",
    );
  const structured = postings[0];
  const source: IncomingJob["source"] = /(^|\.)linkedin\.com$/.test(u.hostname)
    ? "linkedin"
    : /(^|\.)indeed\.[a-z.]+$/.test(u.hostname)
      ? "indeed"
      : /(^|\.)naukri\.com$/.test(u.hostname)
        ? "naukri"
        : "company";
  const title =
    structured?.title ||
    $("h1").first().text().trim() ||
    $(".posting-headline h2").first().text().trim();
  const company =
    structured?.hiringOrganization?.name ||
    $(".topcard__org-name-link").first().text().trim() ||
    $("[data-company-name]").attr("data-company-name") ||
    ([
      "jobs.lever.co",
      "jobs.ashbyhq.com",
      "boards.greenhouse.io",
      "job-boards.greenhouse.io",
    ].includes(u.hostname)
      ? u.pathname.split("/").filter(Boolean)[0]
      : "");
  const locationData = structured?.jobLocation;
  const locations = (
    Array.isArray(locationData)
      ? locationData
      : locationData
        ? [locationData]
        : []
  )
    .map(
      (v: any) => v.address?.addressLocality || v.address?.addressRegion || "",
    )
    .filter(Boolean);
  const location =
    locations.join(", ") ||
    $(".topcard__flavor--bullet").first().text().trim() ||
    structured?.jobLocationType ||
    "";
  const description = structured?.description
    ? plain(structured.description)
    : plain(
        $(".show-more-less-html__markup").html() ||
          $(".posting-page .section-wrapper").html() ||
          $('[itemprop="description"]').html() ||
          "",
      );
  if (!title || !company || description.length < 50)
    throw new Error(
      "This site did not expose a complete job description. Paste the job title, company and description below, then submit again.",
    );
  if (
    structured?.validThrough &&
    Date.parse(structured.validThrough) < Date.now()
  )
    throw new Error("This posting is marked expired.");
  const result = jobSchema.parse({
    title,
    company,
    location,
    description,
    source,
    apply_url: url,
    metadata: { ...structured, manual_url: true, extracted_from: url },
  });
  return result;
}
export async function fetchJobUrl(url: string) {
  if (
    ["www.naukri.com", "naukri.com", "m.naukri.com"].includes(
      new URL(url).hostname,
    )
  ) {
    const data = JSON.parse(
      await runProcess(
        process.env.PYTHON_BIN || "python",
        ["scripts/extract-url.py"],
        { cwd: ROOT, input: JSON.stringify({ url }), timeout: 25000 },
      ),
    );
    return jobSchema.parse(data);
  }
  // Only the submitted individual page is fetched; company-board discovery is not used.
  return withSourceBudget(
    async () => extractJobPage(url, await safeGet(url)),
    25000,
  );
}
