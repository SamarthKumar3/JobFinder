# JobFinder

Personal React + TypeScript job dashboard backed by PostgreSQL. Only PostgreSQL runs in Docker, reusing `postgres:17-alpine` with `pull_policy: never`. No application image is built. The server and workers run on the Windows host so they can use the existing Codex login.

## Quick start

Requirements: Node 22.13+ (24 recommended), Python 3.11+, Git, Docker Desktop, and an authenticated Codex CLI (`codex login`).

```powershell
npm run setup
npm start
```

Open http://127.0.0.1:4100. Setup generates a local database password, clones pinned Career Ops, installs JobSpy in `.venv`, starts Postgres, builds the dashboard and registers Windows tasks. To omit task registration, run `powershell -File scripts/setup.ps1 -SkipSchedule`.

On another machine, copy your resume to `Samarth_Kumar_Bhardwaj_Resume.pdf`; it is intentionally excluded from Git, along with `.env`, companies.xlsx, generated documents, source job data and the database. Run `npm run dev` for frontend development at http://127.0.0.1:5173.

## Search and sources

`config/search.json` targets full-time AI/LLM, Python backend and full-stack AI jobs in Pune, Bengaluru and Delhi NCR, with 1.5 years experience and a minimum of INR 20 LPA. No internships, contracts or fresher-only jobs. Searches and automatic evaluations use a strict rolling **last 24 hours** window; older or undated postings are skipped. JobSpy is pinned and source timestamp hooks preserve Indeed/Naukri epoch times and LinkedIn precise/relative labels before calendar-date truncation. Rounded LinkedIn labels use a conservative lower bound; date-only or unavailable timestamps are skipped. Age is checked again before every queued evaluation. Existing reports are retained as history, never re-evaluated automatically after aging out. Missing salary is a verification gap rather than invented compensation.

Place `companies.xlsx` in the root directory. All worksheets are scanned for plain HTTP(S) URLs and hyperlink targets; LinkedIn company pages are kept out of direct careers scraping. no fixed column layout is required. Prefer company **careers board URLs**, not corporate home pages. Workbook contents remain local. Manual company URLs can also be added to `companyUrls` in the JSON config.

JobSpy collects public listings from LinkedIn, Indeed and Naukri without usernames/passwords/cookies. No login credentials are required. Providers can block automated access or omit descriptions. Partial/failed sources are recorded in run diagnostics, never presented as successful zero-job scans. No CAPTCHA bypass, authenticated scraping or proxy rotation is included. LinkedIn restricts scraping; use imported descriptions if access is blocked.

Company adapters support Greenhouse, Lever, Ashby and JobPosting JSON-LD (including ItemList/@graph), plus downloaded Career Ops providers for Google, Amazon, Workday, Eightfold and SmartRecruiters where detected. Public careers links are explored within a bounded budget. Direct company results also require a reliable posting timestamp; sources without one are skipped. Coverage is bounded, never an exhaustive crawl of every company portal. Other dynamic careers sites need a dedicated adapter or pasted/imported JD. Every source error appears in the dashboard. Imported jobs use the same scoring and persistence pipeline.

A ChatGPT Indeed plugin is a chat integration; it is not automatically an API credential for an unattended Windows process. Its results can be imported via the dashboard or `POST /api/jobs/import`. Direct JobSpy collection is the independent scheduled path. A connector-specific bridge can be added once that plugin's available tools and authentication are known.

## Career Ops and documents

Career Ops source: https://github.com/career-ops-hq/career-ops, MIT licensed. Pinned commit: `8db98e3da9ba4accf89ee3984500d68564e58db5`. Source is downloaded under ignored `.local/career-ops`; upstream code is not modified. Its `_shared.md`, `oferta.md`, `_writing.md`, `pdf.md` and `cover.md` supply scoring and document instructions to a structured-output adapter. This dashboard uses its own PostgreSQL tracker and PDF/Word renderer, rather than upstream Markdown tracker and interactive PDF pipeline.

The adapter defaults to the authenticated `codex exec` CLI in read-only mode, using the configured default model. It passes the original resume, full job description, targeting and upstream instructions. CLI output must satisfy a JSON schema and is validated before persistence. Invalid output is an evaluation error, never a fabricated fallback score. Usage counts against the connected AI provider/account limits.

Alternatively set `AI_PROVIDER=openai`, `OPENAI_API_KEY`, `OPENAI_MODEL` and optionally `OPENAI_BASE_URL` in `.env` for a compatible endpoint. Resume and job text are sent to the selected AI provider; no resume or keys are committed to Git.

All discovered complete jobs are stored **before** evaluation. Automatic results pass a deterministic pre-screen before entering the Career Ops queue: target engineering titles and relevant technology, no senior/lead/architect/management positions, explicit minimum experience at most 2 years, no fresher-only / 0–1-year bands, no internships/contracts and no disclosed INR salary ceiling below 20 LPA. The experience margin is configurable with `maxRequiredExperienceYears`. Rejected pre-screen records are retained with reasons as `state=filtered` and excluded from job views; existing evaluations are preserved. The pre-screen is also applied to existing records at startup and rechecked immediately before automatic evaluation. URL normalization deduplicates repeated scans, content changes queue rescoring, and every successful evaluation is retained in `evaluations`. Errors retry up to three daily runs, with a manual retry control, only while the posting remains within the 24-hour window. The cap is 30 evaluations per run by default; backlog remains in Needs review until evaluated or skipped after aging out.

- `Apply`: completed evaluation, score **strictly greater than 4**, Career Ops recommends apply and no blockers.
- `Rejected`: other completed non-confirmation decisions, including exactly 4.0.
- `Needs review`: pending/error jobs and upstream confirmation gates. Read the reported question, save your answer in the modal, then run the workflow. Confirmation gates do not receive a score.
- `All jobs`: every persisted job.

Scores 2–5 expose background actions for a tailored PDF resume and a Word `.docx` cover letter. Generated factual paragraphs include source evidence, checked against the original resume before rendering. This is a provenance check, not a complete semantic fact guarantee: review every draft. The tailored resume is independently rescored and the result shown next to its download. Original fit score remains unchanged. 5.0 is a target, never guaranteed; genuine experience, location or pay gaps cannot be rewritten away. Downloads plus the application URL are available in the modal. Nothing submits applications or contacts employers.

## Schedule and operation

The server cron runs at **09:00 Asia/Kolkata**. `scripts/register-schedule.ps1` also registers:

- `JobFinder Daily 9AM`: Windows daily task invoking `run-workflow.ps1`, starts PostgreSQL if necessary, catches missed starts when Windows resumes and requests wake.
- `JobFinder Dashboard`: starts the dashboard at user logon, with restart on failure.

The workflow uses a PostgreSQL advisory lock to prevent concurrent runs. Scheduled invocations are limited to one per India calendar day, so the Windows task and embedded cron do not double-run. Manual runs can be requested at any time. Artifact requests are durable PostgreSQL tasks with a separate worker lock and restart recovery.

The user must be logged in for the Windows tasks (interactive user token, no stored Windows password). Docker Desktop must be available and the computer must be powered on; wake is subject to system policy. For execution while logged out, install under a dedicated service account with its own AI authentication. A powered-off PC cannot run at 09:00. Logs are in `data/logs`; detailed workflow history is in PostgreSQL and the dashboard. The scheduler is in the app/Windows, not a Codex chat heartbeat.

Dashboard binds only to 127.0.0.1 and has local host/origin checks. Keep it local; remote deployment requires authentication and TLS. Do not expose PostgreSQL or the dashboard publicly.

## API and checks

The dashboard has no interval polling. Initial loads, user changes to views/filters, and the **Refresh** buttons fetch data. Artifact and URL workers wake on requests/startup rather than polling an idle queue. The schedule and last-run phase are available in the workflow-status info tooltip.

`GET /api/jobs` accepts exact `company`, `role` and normalized `location` filters in addition to `tab`, `q` and `offset`. Its `filters` field contains backend-computed values/counts across **all matching records before pagination**. Each facet omits its own active selection when aggregating options. Multi-location postings match each city and Delhi NCR group membership. No frontend page-based aggregation is used.

**Evaluate URL** submits an individual posting through `POST /api/submissions` with `{url}`. Public Naukri links use JobSpy's individual-job transport; structured job pages and public LinkedIn pages have HTML extractors. If a site blocks extraction, the form accepts user-pasted title, company, location and description. User-selected URL jobs deliberately bypass automatic search screening/recency and use the same Career Ops evaluation, job-detail component, PDF resume and Word cover-letter actions. Confirmation gates still require a user answer. `GET /api/submissions` exposes recent submission states; Refresh retrieves completed results. Descriptions and resume text are only sent to the configured, user-approved AI provider.

Workflow rows carry phases and counts. Startup and manual status refresh reconcile a stale `running` record when no worker holds the workflow advisory lock. Scans have a 30-minute deadline, each board worker a 3-minute deadline, and company discovery a 5-minute total budget / 20-second source budget. Slow portals are reported as partial coverage; scans do not wait indefinitely. Owned subprocesses are terminated on cancellation/timeouts.

One filtered endpoint: `GET /api/jobs?tab=apply|rejected|pending|all&q=...&offset=0` (50 rows per page). Job details: `GET /api/jobs/:id`. Workflow: `POST /api/run`. Artifact queue: `POST /api/jobs/:id/artifacts` with `{"kind":"resume"}` or `{"kind":"cover"}`. Import: `POST /api/jobs/import` with an array of `{title,company,location,source,apply_url,description,metadata}`. All POSTs require `Content-Type: application/json` and `X-JobFinder-Request: 1`.

```powershell
npm test
npm run build
npx tsx tests/integration.ts
npm run workflow
```

Postgres data is in the `jobfinder_jobfinder_pg` named volume. Back it up with `pg_dump` before destructive database changes. `docker compose down` preserves data; do not add `-v` unless deleting your job history is intentional.

## Verification on the development machine

- TypeScript production build and eighteen behavior tests passed, including the strict 24-hour cutoff.
- PostgreSQL integration verified duplicate URLs, unchanged-job score retention, changed-description invalidation, 65-row pagination/facets, exact filters, multi-city matches, pre-screen exclusions and stale-run reconciliation.
- Public LinkedIn, Indeed and Naukri collectors were exercised. The final strict-window smoke search returned fresh LinkedIn/Naukri jobs and no fresh Indeed jobs for that query.
- Authenticated Codex evaluation was exercised on real postings after explicit user approval for sending the resume to Codex.
- React filters and job metadata modal were checked in the browser. PDF output was rendered and visually inspected. Word OOXML/file structure was checked; full Word visual rendering was unavailable because LibreOffice is not installed.
- Windows tasks were registered and the dashboard task was started successfully. Company coverage varies; unsupported or undated sources remain visible in diagnostics.
