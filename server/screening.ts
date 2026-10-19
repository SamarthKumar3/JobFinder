import type { IncomingJob } from "./domain";
export type Screening = {
  eligible: boolean;
  reasons: string[];
  minimumExperience: number | null;
};
const targetRole =
  /\b(?:ai|ml|llm|gen\s?ai|generative\s+ai|artificial\s+intelligence|machine\s+learning|agentic|nlp|python|back[ -]?end|full[ -]?stack|software|application|platform)\b/i;
const engineeringRole = /\b(?:engineer|developer|scientist|sde)\b/i;
const unrelated =
  /\b(?:legal|counsel|lawyer|paralegal|sales|recruiter|recruitment|accountant|finance|production|mechanical|civil|electrical|hardware|qa|quality\s+assurance|test\s+engineer|product\s+(?:owner|manager)|business\s+analyst|customer\s+support)\b/i;
const senior =
  /\b(?:senior|sr\.?|staff|principal|lead|manager|director|head|architect|vp|vice\s+president|chief)\b/i;
export function normalizedLocations(raw: string) {
  const found: string[] = [];
  for (const [name, re] of [
    ["Pune", /\bpune\b/i],
    ["Bangalore", /\bbangal(?:ore|uru)\b|\bbengaluru\b/i],
    ["Gurugram", /\bgur(?:gaon|ugram)\b/i],
    ["Noida", /\bnoida\b/i],
    ["Delhi", /\bdelhi\b/i],
    ["Faridabad", /\bfaridabad\b/i],
    ["Ghaziabad", /\bghaziabad\b/i],
  ] as [string, RegExp][])
    if (re.test(raw)) found.push(name);
  if (
    /\bncr\b/i.test(raw) ||
    found.some((c) =>
      ["Gurugram", "Noida", "Delhi", "Faridabad", "Ghaziabad"].includes(c),
    )
  )
    found.push("Delhi NCR");
  return found.length ? [...new Set(found)] : raw.trim() ? [raw.trim()] : [];
}
export function requiredExperience(
  description: string,
  metadata: Record<string, any> = {},
) {
  const required: number[] = [];
  const structured =
    metadata.experience_range ??
    metadata.experienceRange ??
    metadata.requiredExperience;
  if (typeof structured === "number" && Number.isFinite(structured))
    required.push(structured);
  if (typeof structured === "string") {
    const m = structured.match(
      /(?:^|\b)(\d+(?:\.\d+)?)\s*(?:[-–—]|to|\+|years?|yrs?)/i,
    );
    if (m) required.push(Number(m[1]));
  }
  const numbers: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    fifteen: 15,
    twenty: 20,
  };
  const text = description.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty)(?=\s*(?:\+?\s*(?:years?|yrs?)|to\s))/gi,
    (w) => String(numbers[w.toLowerCase()]),
  );
  const patterns = [
    /\b(\d+(?:\.\d+)?)\s*(?:[-–—]|to)\s*\d+(?:\.\d+)?\s*(?:years?|yrs?)\b/gi,
    /\b(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)(?:['’])?\s+(?:of\s+)?(?:(?:relevant|professional|industry|total|commercial|hands[- ]on|software\s+engineering|development|work)\s+){0,3}experience\b/gi,
    /\b(?:minimum(?:\s+of)?|at\s+least|experience\s*[:–-]|requires?|required)\s*(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\b/gi,
    /\bexperience\s*[:(]?\s*(?:of\s+)?\(?\s*(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)\b/gi,
    /\b(\d+(?:\.\d+)?)\s*\+\s*(?:years?|yrs?)\b/gi,
  ];
  const ranges: [number, number][] = [];
  for (const [patternIndex, pattern] of patterns.entries())
    for (const m of text.matchAll(pattern)) {
      if (patternIndex === 0) ranges.push([m.index!, m.index! + m[0].length]);
      else if (
        ranges.some(([start, end]) => m.index! >= start && m.index! < end)
      )
        continue;
      const before = text.slice(Math.max(0, m.index! - 65), m.index!),
        after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 50);
      if (
        /(?:up\s+to|less\s+than|under)\s*$/i.test(before) ||
        /\b(?:preferred|nice[- ]to[- ]have|optional|desirable)\b/i.test(
          before.split(/[.;\n]/).at(-1) || "",
        ) ||
        /^\s*(?:is\s+|are\s+)?(?:preferred|desirable|optional)\b/i.test(after)
      )
        continue;
      required.push(Number(m[1]));
    }
  return required.length ? Math.max(...required) : null;
}
export function screenJob(
  job: Pick<IncomingJob, "title" | "description" | "location" | "metadata">,
  maxYears = 2,
): Screening {
  const reasons: string[] = [];
  const { title, description, metadata } = job;
  if (
    !targetRole.test(title) ||
    !engineeringRole.test(title) ||
    unrelated.test(title)
  )
    reasons.push(
      "Role is outside AI/LLM, Python backend and full-stack software engineering",
    );
  if (senior.test(title))
    reasons.push("Seniority exceeds the early-career engineering target");
  const exp = requiredExperience(description, metadata);
  if (exp !== null && exp > maxYears)
    reasons.push(
      `Requires at least ${exp} years; automatic search allows a minimum requirement up to ${maxYears} years`,
    );
  const band = String(metadata.experience_range ?? "");
  if (/^\s*0\s*(?:[-–—]|to)\s*[01]\b/i.test(band))
    reasons.push(
      "Opening is restricted to a fresher / 0–1 year experience band",
    );
  const salary = (
    metadata.salary && typeof metadata.salary === "object"
      ? metadata.salary
      : {}
  ) as Record<string, unknown>;
  const currency = String(
    metadata.currency ?? salary.currency ?? "",
  ).toUpperCase();
  const upper = Number(metadata.max_amount ?? salary.max);
  const interval = String(
    metadata.interval ?? (salary.max !== undefined ? "yearly" : ""),
  ).toLowerCase();
  const annual =
    interval === "yearly" ? upper : interval === "monthly" ? upper * 12 : NaN;
  if (currency === "INR" && annual > 0 && annual < 2000000)
    reasons.push("Disclosed maximum annual salary is below INR 20 LPA");
  const employment = String(metadata.job_type ?? metadata.employmentType ?? "");
  if (
    /intern|contract|freelance|temporary|part[- ]?time|fixed[- ]?term/i.test(
      title + " " + employment,
    ) ||
    /\b(?:employment|job)\s+type\s*[:–-]\s*(?:contract|internship|part[- ]time|temporary)/i.test(
      description,
    )
  )
    reasons.push("Employment is not full time");
  if (
    /\bfreshers?\b/i.test(title) ||
    /\bfreshers?\s+only\b|\bonly\s+freshers?\b/i.test(description)
  )
    reasons.push("Fresher-only opening");
  if (
    !/\bpython\b|\bfastapi\b|\blanggraph\b|\brag\b|\bllms?\b|\blarge language models?\b|\bgenerative ai\b|\bagentic\b|\bai agents?\b/i.test(
      description,
    ) &&
    !(/\breact\b/i.test(description) && /\btypescript\b/i.test(description))
  )
    reasons.push(
      "Description does not establish relevant Python, AI/LLM or React/TypeScript work",
    );
  const locations = normalizedLocations(job.location);
  if (
    locations.length &&
    !locations.some((c) => ["Pune", "Bangalore", "Delhi NCR"].includes(c)) &&
    /\b(?:mumbai|hyderabad|chennai|kolkata|ahmedabad|kochi|indore|jaipur)\b/i.test(
      job.location,
    )
  )
    reasons.push("Location is outside Pune, Bangalore and Delhi NCR");
  return { eligible: !reasons.length, reasons, minimumExperience: exp };
}
