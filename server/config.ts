import "dotenv/config";
import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
export const ROOT = process.cwd();
export const DATA = path.join(ROOT, "data");
export const OPS = path.resolve(
  process.env.CAREER_OPS_PATH || ".local/career-ops",
);
export const searchSchema = z.object({
  locations: z.array(z.string()).optional(),
  terms: z.array(z.string().min(1)).min(1).max(20),
  location: z.string(),
  country: z.string(),
  sites: z.array(z.enum(["linkedin", "indeed", "naukri"])),
  resultsPerSearch: z.number().int().min(1).max(50),
  hoursOld: z.literal(24),
  maxRequiredExperienceYears: z.number().min(0).max(5).default(2),
  companyUrls: z.array(z.url()).max(50),
  targeting: z.string().max(5000),
});
export async function searchConfig() {
  return searchSchema.parse(
    JSON.parse(
      await fs.readFile(path.join(ROOT, "config/search.json"), "utf8"),
    ),
  );
}
export async function prepareDirectories() {
  await fs.mkdir(DATA, { recursive: true });
}
