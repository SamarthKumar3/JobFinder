import { load } from "cheerio";
import { recency, type IncomingJob } from "./domain";

export function workdayBoard(raw: string) {
  const u = new URL(raw),
    parts = u.pathname.split("/").filter(Boolean);
  let tenant: string, site: string, base: string;
  if (u.hostname.endsWith(".myworkdayjobs.com")) {
    tenant = u.hostname.split(".")[0];
    if (parts[0] === "wday" && parts[1] === "cxs") {
      tenant = parts[2];
      site = parts[3];
    } else site = parts[/^[a-z]{2}[-_][A-Z]{2}$/.test(parts[0] || "") ? 1 : 0];
    base = `${u.origin}/${encodeURIComponent(site || "")}`;
  } else if (
    u.hostname.endsWith(".myworkdaysite.com") &&
    parts[0] === "recruiting"
  ) {
    tenant = parts[1];
    site = parts[2];
    base = `${u.origin}/recruiting/${encodeURIComponent(tenant || "")}/${encodeURIComponent(site || "")}`;
  } else return null;
  if (!tenant || !site) return null;
  const api = `${u.origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  return { key: api, api, base, origin: u.origin };
}
type Transport = (
  url: string,
  options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<string>;
export const WORKDAY_MAX_PAGES = 50;
const oldLabel = (label: string) => {
  const match = /(?:posted\s+)?(\d+)\+?\s+days?\s+ago/i.exec(label);
  return !!match && Number(match[1]) >= 2;
};
function postingTimestamp(info: any) {
  // Workday list labels and date-only startDate do not prove a rolling 24h age.
  return [info.postedAt, info.datePosted, info.postedDate, info.startDate].find(
    (value) =>
      typeof value === "string" &&
      /T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value),
  );
}
export async function collectWorkday(
  raw: string,
  get: Transport,
  now = Date.now(),
  canContinue = () => true,
) {
  const board = workdayBoard(raw);
  if (!board) throw new Error("Unsupported Workday board URL");
  const jobs: IncomingJob[] = [],
    diagnostics: string[] = [];
  const seenJobs = new Set<string>(),
    seenPages = new Set<string>();
  let facets: Record<string, string[]> = {},
    filtered = false,
    offset = 0,
    pages = 0,
    oldPages = 0,
    unknownDates = 0,
    exhausted = false;
  scan: while (pages < WORKDAY_MAX_PAGES) {
    if (!canContinue()) {
      diagnostics.push("Workday partial coverage: source time budget reached");
      break;
    }
    let data: any;
    try {
      data = JSON.parse(
        await get(`${board.api}/jobs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            limit: 20,
            offset,
            searchText: "",
            appliedFacets: facets,
          }),
        }),
      );
    } catch (error) {
      if (!pages) throw error;
      diagnostics.push(
        `Workday partial coverage: listing failed at offset ${offset}: ${String(error)}`,
      );
      break;
    }
    pages++;
    if (!filtered) {
      filtered = true;
      const country = data.facets?.find((f: any) =>
        /country/i.test(f.facetParameter || ""),
      );
      const india = country?.values?.find((v: any) =>
        /^india$/i.test(v.descriptor || ""),
      );
      if (india?.id) {
        facets = { [country.facetParameter]: [india.id] };
        continue;
      }
    }
    const rows = Array.isArray(data.jobPostings) ? data.jobPostings : [];
    if (!rows.length) {
      exhausted = true;
      break;
    }
    const fingerprint = rows.map((j: any) => j.externalPath).join("|");
    if (seenPages.has(fingerprint)) {
      diagnostics.push(
        `Workday partial coverage: repeated page at offset ${offset}; pagination stopped`,
      );
      break;
    }
    seenPages.add(fingerprint);
    oldPages = rows.every((r: any) => oldLabel(r.postedOn || ""))
      ? oldPages + 1
      : 0;
    for (const row of rows) {
      if (!canContinue()) {
        diagnostics.push(
          "Workday partial coverage: source time budget reached",
        );
        break scan;
      }
      if (
        !row.externalPath ||
        seenJobs.has(row.externalPath) ||
        oldLabel(row.postedOn || "")
      )
        continue;
      seenJobs.add(row.externalPath);
      if (!/engineer|developer|scientist/i.test(row.title || "")) continue;
      const relative = String(row.externalPath);
      if (
        !relative.startsWith("/job/") ||
        relative.includes("..") ||
        relative.includes("?")
      )
        continue;
      let detail: any;
      try {
        detail = JSON.parse(
          await get(board.api + relative, {
            headers: { Accept: "application/json" },
          }),
        );
      } catch (error) {
        diagnostics.push(
          `Workday detail unavailable: ${row.title}: ${String(error)}`,
        );
        continue;
      }
      const info = detail.jobPostingInfo || {},
        stamp = postingTimestamp(info);
      if (recency({ posted_at: stamp }, now) !== "fresh") {
        if (!stamp) unknownDates++;
        continue;
      }
      const location = [
        info.location?.descriptor || info.location || row.locationsText,
        ...(Array.isArray(info.additionalLocations)
          ? info.additionalLocations
          : []
        ).map((l: any) =>
          typeof l === "string" ? l : l.descriptor || l.name || "",
        ),
      ]
        .filter(Boolean)
        .join("; ");
      if (
        !/india|pune|bangalore|bengaluru|delhi|gurugram|gurgaon|noida/i.test(
          location,
        )
      )
        continue;
      const description = load(info.jobDescription || "")
        .text()
        .trim();
      if (description.length < 100) continue;
      jobs.push({
        title: info.title || row.title,
        company:
          info.companyName ||
          detail.hiringOrganization?.name ||
          board.origin.split("//")[1].split(".")[0],
        location,
        description: description.slice(0, 100000),
        source: "company",
        apply_url: board.base + relative,
        metadata: {
          provider: "workday",
          source_url: raw,
          posted_at: stamp,
          coverage:
            "Recent-posting pagination with strict timestamp verification",
        },
      });
    }
    offset += rows.length;
    if (
      oldPages >= 2 ||
      (typeof data.total === "number" && offset >= data.total) ||
      rows.length < 20
    ) {
      exhausted = true;
      break;
    }
  }
  if (!exhausted && pages >= WORKDAY_MAX_PAGES)
    diagnostics.push(
      `Workday partial coverage: ${WORKDAY_MAX_PAGES}-page safety limit reached`,
    );
  if (unknownDates)
    diagnostics.push(
      `Workday: skipped ${unknownDates} relevant postings without a verifiable timestamp (strict last 24 hours)`,
    );
  return Object.assign(jobs, { diagnostics });
}
