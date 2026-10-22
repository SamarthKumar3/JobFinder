import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { evaluationDate } from "./date";
type Job = {
  id: string;
  title: string;
  company: string;
  location: string;
  source: string;
  apply_url: string;
  score: string | null;
  state: string;
  decision: string;
  error?: string;
  description?: string;
  evaluation?: any;
  metadata?: any;
  tasks?: any[];
  content_hash?: string;
  manual?: boolean;
  evaluated_at?: string | null;
  application_status?: "applied" | "did_not_apply" | null;
};
type Filters = {
  company: { value: string; count: number }[];
  role: { value: string; count: number }[];
  location: { value: string; count: number }[];
};
async function api(url: string, body?: unknown, signal?: AbortSignal) {
  const r = await fetch(
    `/api${url}`,
    body === undefined
      ? { signal }
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-JobFinder-Request": "1",
          },
          body: JSON.stringify(body),
          signal,
        },
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}
const date = (v: string) =>
  new Date(v).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
function ViewIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function ApplicationStatus({
  id,
  value,
  disabled,
  onChange,
}: {
  id?: string | null;
  value?: Job["application_status"];
  disabled: boolean;
  onChange: (id: string, status: "applied" | "did_not_apply") => void;
}) {
  return (
    <div className="application-actions" onClick={(e) => e.stopPropagation()}>
      {(
        [
          ["applied", "Applied"],
          ["did_not_apply", "Did not apply"],
        ] as const
      ).map(([status, label]) => (
        <button
          key={status}
          type="button"
          className={`icon-button ${value === status ? `chosen ${status}` : ""}`}
          aria-label={label}
          title={label}
          aria-pressed={value === status}
          disabled={disabled || !id}
          onClick={() => id && onChange(id, status)}
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            {status === "applied" ? (
              <path d="m5 12 4 4L19 6" />
            ) : (
              <path d="m6 6 12 12M18 6 6 18" />
            )}
          </svg>
        </button>
      ))}
    </div>
  );
}
function JobDetails({
  job,
  busy,
  onAction,
  onRefresh,
}: {
  job: Job;
  busy: string;
  onAction: (key: string, fn: () => Promise<void>) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  return (
    <div className="modalbody">
      <div className="metadata">
        <span>{job.location || "Location not specified"}</span>
        <span>{job.source}</span>
        <time
          dateTime={job.evaluated_at || undefined}
          title="Evaluated at (Asia/Kolkata)"
        >
          {evaluationDate(job.evaluated_at)}
        </time>
        <strong>
          {job.decision === "review"
            ? "Confirmation needed"
            : job.score && job.state === "evaluated"
              ? `${Number(job.score).toFixed(1)} / 5`
              : "Awaiting evaluation"}
        </strong>
        <button onClick={() => void onRefresh()} disabled={!!busy}>
          Refresh result
        </button>
      </div>
      <ApplicationStatus
        id={job.id}
        value={job.application_status}
        disabled={!!busy}
        onChange={(id, status) =>
          void onAction("application-status", async () => {
            await api(`/jobs/${id}/application-status`, { status });
          })
        }
      />
      <a
        className="applylink"
        href={job.apply_url}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open application ↗
      </a>
      {job.error && <p className="alert">{job.error}</p>}
      {job.state === "evaluated" && job.evaluation && (
        <>
          <h3>Career Ops evaluation</h3>
          <p>{job.evaluation.summary}</p>
          <p>Evidence confidence: {job.evaluation.confidence}</p>
          {[
            ["Strengths", job.evaluation.strengths],
            ["Gaps to verify", job.evaluation.gaps],
            ["Blockers", job.evaluation.blockers],
          ].map(
            ([label, items]: any) =>
              items?.length > 0 && (
                <section key={label}>
                  <h4>{label}</h4>
                  <ul>
                    {items.map((s: string, i: number) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ul>
                </section>
              ),
          )}
          <details>
            <summary>Full evaluation report</summary>
            <pre>{job.evaluation.report}</pre>
          </details>
        </>
      )}
      {job.state === "evaluated" && Number(job.score) >= 2 && (
        <section className="artifactbox">
          <h3>Application documents</h3>
          <div className="actions">
            {[
              ["resume", "Tailor resume (PDF)"],
              ["cover", "Create cover letter (Word)"],
            ].map(([kind, label]) => (
              <button
                key={kind}
                className={kind === "resume" ? "primary" : ""}
                disabled={
                  !!busy ||
                  job.tasks?.some(
                    (t) =>
                      t.kind === kind &&
                      ["queued", "running"].includes(t.state),
                  )
                }
                onClick={() =>
                  void onAction(kind, async () => {
                    await api(`/jobs/${job.id}/artifacts`, { kind });
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
          {job.tasks?.map((t) => (
            <div className="task" key={t.id}>
              <strong>
                {t.kind === "resume" ? "Tailored resume" : "Cover letter"}
              </strong>{" "}
              · {t.state}
              {t.error && <p className="alert">{t.error}</p>}
              {t.result && (
                <>
                  <p>
                    <a href={t.result.download_url}>
                      Download{" "}
                      {t.kind === "resume" ? "PDF resume" : "Word cover letter"}
                    </a>
                    {t.result.tailoredEvaluation?.score != null &&
                      ` · New score: ${t.result.tailoredEvaluation.score.toFixed(1)} / 5`}
                  </p>
                  {t.result.remainingGaps?.length > 0 && (
                    <p>Remaining gaps: {t.result.remainingGaps.join("; ")}</p>
                  )}
                  {t.result.contentHash !== job.content_hash && (
                    <p>Job description changed since generation.</p>
                  )}
                </>
              )}
            </div>
          ))}
        </section>
      )}
      {job.decision === "review" && (
        <section>
          <label>
            Answer the confirmation question
            <textarea
              rows={3}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
          <button
            disabled={!!busy || confirmation.trim().length < 3}
            onClick={() =>
              void onAction("confirm", async () => {
                await api(`/jobs/${job.id}/confirm`, { answer: confirmation });
                setConfirmation("");
              })
            }
          >
            Save answer and queue evaluation
          </button>
        </section>
      )}
      {job.state === "error" && (
        <button
          disabled={!!busy}
          onClick={() =>
            void onAction("retry", async () => {
              await api(`/jobs/${job.id}/retry`, {});
            })
          }
        >
          Retry evaluation
        </button>
      )}
      <h3>Job description</h3>
      <pre>{job.description}</pre>
      <details>
        <summary>Source metadata</summary>
        <pre>{JSON.stringify(job.metadata, null, 2)}</pre>
      </details>
    </div>
  );
}
function App() {
  const [tab, setTab] = useState("apply"),
    [q, setQ] = useState(""),
    [company, setCompany] = useState(""),
    [role, setRole] = useState(""),
    [location, setLocation] = useState(""),
    [offset, setOffset] = useState(0);
  const [jobs, setJobs] = useState<Job[]>([]),
    [total, setTotal] = useState(0),
    [filters, setFilters] = useState<Filters>({
      company: [],
      role: [],
      location: [],
    }),
    [status, setStatus] = useState<any>(),
    [selected, setSelected] = useState<Job | null>(null),
    [manualJob, setManualJob] = useState<Job | null>(null),
    [submissions, setSubmissions] = useState<any[]>([]),
    [activeSubmission, setActiveSubmission] = useState<string | null>(null);
  const [runs, setRuns] = useState<any[]>([]),
    [runsTotal, setRunsTotal] = useState(0);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState("");
  const [url, setUrl] = useState(""),
    [pastedTitle, setPastedTitle] = useState(""),
    [pastedCompany, setPastedCompany] = useState(""),
    [pastedLocation, setPastedLocation] = useState(""),
    [pastedDescription, setPastedDescription] = useState("");
  const modal = useRef<HTMLDialogElement>(null);
  const query = new URLSearchParams({
    tab: ["url", "history"].includes(tab) ? "all" : tab,
    q,
    company,
    role,
    location,
    offset: String(offset),
  }).toString();
  function applyRows(data: any) {
    setJobs(data.jobs);
    setTotal(data.total);
    setFilters(data.filters);
  }
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      void (
        tab === "history"
          ? api(`/runs?offset=${offset}`, undefined, abort.signal)
          : tab === "url"
            ? api("/submissions", undefined, abort.signal)
            : api(`/jobs?${query}`, undefined, abort.signal)
      )
        .then((data) => {
          if (tab === "history") {
            setRuns(data.runs);
            setRunsTotal(data.total);
          } else if (tab === "url") setSubmissions(data.submissions);
          else applyRows(data);
        })
        .catch((e) => {
          if (e.name !== "AbortError") setError(String(e));
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 180);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [query, tab, offset]);
  useEffect(() => {
    void Promise.all([api("/status"), api("/submissions")])
      .then(([s, u]) => {
        setStatus(s);
        setSubmissions(u.submissions);
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    if (selected) modal.current?.showModal();
  }, [selected?.id]);
  async function refresh() {
    setBusy("refresh");
    setError("");
    try {
      const [s, j, u] = await Promise.all([
        api("/status"),
        tab === "history"
          ? api(`/runs?offset=${offset}`)
          : tab === "url"
            ? Promise.resolve(null)
            : api(`/jobs?${query}`),
        api("/submissions"),
      ]);
      setStatus(s);
      if (tab === "history") {
        setRuns(j.runs);
        setRunsTotal(j.total);
      } else if (j) applyRows(j);
      setSubmissions(u.submissions);
      const current = u.submissions.find((x: any) => x.id === activeSubmission);
      if (current?.job_id) setManualJob(await api(`/jobs/${current.job_id}`));
      else if (manualJob) setManualJob(await api(`/jobs/${manualJob.id}`));
      if (selected) setSelected(await api(`/jobs/${selected.id}`));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
      setLoading(false);
    }
  }
  async function action(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy("");
    }
  }
  async function open(id: string, inline = false) {
    try {
      const j = await api(`/jobs/${id}`);
      inline ? setManualJob(j) : setSelected(j);
    } catch (e) {
      setError(String(e));
    }
  }
  function setApplication(id: string, value: "applied" | "did_not_apply") {
    void action("application-status", async () => {
      await api(`/jobs/${id}/application-status`, { status: value });
    });
  }
  const run = status?.runs?.[0],
    running = run?.state === "running";
  const currentSubmission = submissions.find((s) => s.id === activeSubmission);
  const filterValue = { company, role, location };
  const setters = { company: setCompany, role: setRole, location: setLocation };
  const tooltip = `Daily at 9:00 AM · Last 24 hours · ${status?.timezone || "Asia/Kolkata"}${status?.nextRun ? `\nNext: ${date(status.nextRun)}` : ""}${run ? `\n${run.phase} · ${run.discovered} collected · ${run.filtered || 0} filtered · ${run.evaluated} evaluated` : ""}`;
  return (
    <main>
      <header>
        <h1>JobFinder</h1>
        <div className="header-actions">
          <button
            className="workflow-status"
            aria-describedby="workflow-tooltip"
          >
            Workflow:{" "}
            {running ? "Running" : run?.state?.replaceAll("_", " ") || "Idle"}{" "}
            <span className="info-icon" aria-hidden="true">
              i
            </span>
            <span
              className="status-tooltip"
              role="tooltip"
              id="workflow-tooltip"
            >
              {tooltip}
            </span>
          </button>
          <button disabled={!!busy} onClick={() => void refresh()}>
            {busy === "refresh" ? "Refreshing…" : "Refresh"}
          </button>
          <button
            className="primary"
            disabled={!!busy || running}
            onClick={() =>
              void action("run", async () => {
                await api("/run", {});
                setNotice("Workflow started. Use Refresh to check progress.");
              })
            }
          >
            Run workflow
          </button>
        </div>
      </header>
      {error && (
        <div className="alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p role="status">
          {notice}{" "}
          <button className="text" onClick={() => setNotice("")}>
            Dismiss
          </button>
        </p>
      )}
      <div className="toolbar">
        <nav aria-label="Job views">
          {[
            ["apply", "Apply"],
            ["rejected", "Rejected"],
            ["pending", "Needs review"],
            ["all", "All jobs"],
            ["url", "Evaluate URL"],
            ["history", "Workflow history & source diagnostics"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={tab === id}
              className={tab === id ? "tab active" : "tab"}
              onClick={() => {
                setTab(id);
                setOffset(0);
              }}
            >
              {label}
              {!["url", "history"].includes(id) && (
                <span>{status?.counts?.[id] ?? "—"}</span>
              )}
            </button>
          ))}
        </nav>
      </div>
      {tab === "history" ? (
        <section
          className="list"
          aria-label="Workflow history and source diagnostics"
        >
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Finished</th>
                  <th>Status</th>
                  <th>Phase</th>
                  <th>Collected</th>
                  <th>Filtered</th>
                  <th>Evaluated</th>
                  <th>Source diagnostics</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="date-cell">
                      {evaluationDate(r.started_at)}
                    </td>
                    <td className="date-cell">
                      {evaluationDate(r.finished_at)}
                    </td>
                    <td className="capitalize">
                      {r.state.replaceAll("_", " ")}
                    </td>
                    <td>{r.phase}</td>
                    <td>{r.discovered}</td>
                    <td>{r.filtered || 0}</td>
                    <td>{r.evaluated}</td>
                    <td>
                      {r.errors?.length ? (
                        <details className="run-diagnostics">
                          <summary>{r.errors.length} messages</summary>
                          <ul>
                            {r.errors.map((message: string, i: number) => (
                              <li key={i}>{message}</li>
                            ))}
                          </ul>
                        </details>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!runs.length && (
            <p className="empty">
              {loading ? "Loading workflow history…" : "No workflow runs yet."}
            </p>
          )}
          <footer>
            <span>{runsTotal} runs</span>
            <div>
              <button
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 50))}
              >
                Previous
              </button>
              <button
                disabled={offset + 50 >= runsTotal}
                onClick={() => setOffset(offset + 50)}
              >
                Next
              </button>
            </div>
          </footer>
        </section>
      ) : tab === "url" ? (
        <>
          <section className="panel url-entry">
            <h2>Evaluate a job URL</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action("submit-url", async () => {
                  const result = await api("/submissions", {
                    url,
                    title: pastedTitle,
                    company: pastedCompany,
                    location: pastedLocation,
                    description: pastedDescription,
                  });
                  setActiveSubmission(result.id);
                  setManualJob(null);
                  setNotice(
                    "URL submitted. Use Refresh to retrieve the evaluation.",
                  );
                });
              }}
            >
              <label>
                Job URL
                <input
                  type="url"
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://…"
                />
              </label>
              <details>
                <summary>
                  Paste description if the site blocks extraction
                </summary>
                <div className="fallback-fields">
                  <label>
                    Job title
                    <input
                      value={pastedTitle}
                      onChange={(e) => setPastedTitle(e.target.value)}
                    />
                  </label>
                  <label>
                    Company
                    <input
                      value={pastedCompany}
                      onChange={(e) => setPastedCompany(e.target.value)}
                    />
                  </label>
                  <label>
                    Location
                    <input
                      value={pastedLocation}
                      onChange={(e) => setPastedLocation(e.target.value)}
                    />
                  </label>
                </div>
                <label>
                  Job description
                  <textarea
                    rows={7}
                    value={pastedDescription}
                    onChange={(e) => setPastedDescription(e.target.value)}
                  />
                </label>
              </details>
              <button type="submit" className="primary" disabled={!!busy}>
                {busy === "submit-url"
                  ? "Submitting…"
                  : "Evaluate with Career Ops"}
              </button>
            </form>
          </section>
          {currentSubmission && (
            <p role="status">
              Evaluation: {currentSubmission.state}
              {currentSubmission.error && (
                <span className="alert">{currentSubmission.error}</span>
              )}
            </p>
          )}
          {manualJob && (
            <section className="panel manual-result">
              <h2>{manualJob.title}</h2>
              <p>{manualJob.company}</p>
              <JobDetails
                key={manualJob.id}
                job={manualJob}
                busy={busy}
                onAction={action}
                onRefresh={refresh}
              />
            </section>
          )}
          <section className="panel">
            <h2>Submitted URLs</h2>
            {!submissions.length && <p>No URLs submitted yet.</p>}
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Role / Company</th>
                    <th>Status</th>
                    <th>Date</th>
                    <th>Application status</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {submissions.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {s.title || s.url}
                        </a>
                        <p>{s.company}</p>
                      </td>
                      <td>
                        {s.state}
                        {s.error && <p className="alert">{s.error}</p>}
                      </td>
                      <td className="date-cell">
                        <time dateTime={s.evaluated_at || undefined}>
                          {evaluationDate(s.evaluated_at)}
                        </time>
                      </td>
                      <td>
                        <ApplicationStatus
                          id={s.job_id}
                          value={s.application_status}
                          disabled={!!busy}
                          onChange={setApplication}
                        />
                      </td>
                      <td>
                        {s.job_id && (
                          <button
                            className="icon-button"
                            aria-label="View job"
                            title="View job"
                            onClick={() => {
                              setActiveSubmission(s.id);
                              void open(s.job_id, true);
                            }}
                          >
                            <ViewIcon />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <>
          <div className="table-filters">
            {(["company", "role", "location"] as const).map((key) => (
              <label key={key}>
                {key === "company"
                  ? "Company"
                  : key === "role"
                    ? "Role"
                    : "Location"}
                <select
                  aria-label={`Filter by ${key}`}
                  value={filterValue[key]}
                  onChange={(e) => {
                    setters[key](e.target.value);
                    setOffset(0);
                  }}
                >
                  <option value="">
                    All{" "}
                    {key === "company"
                      ? "companies"
                      : key === "role"
                        ? "roles"
                        : "locations"}
                  </option>
                  {filters[key].map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.value} ({f.count})
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label>
              Search
              <input
                value={q}
                placeholder="Role, company or location"
                onChange={(e) => {
                  setQ(e.target.value);
                  setOffset(0);
                }}
              />
            </label>
            <button
              onClick={() => {
                setCompany("");
                setRole("");
                setLocation("");
                setQ("");
                setOffset(0);
              }}
            >
              Clear filters
            </button>
          </div>
          <section className="list" aria-label="Jobs">
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Role / Company</th>
                    <th>Location</th>
                    <th>Source</th>
                    <th>Score</th>
                    <th>Evaluation</th>
                    <th>Date</th>
                    <th>Application status</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr
                      key={j.id}
                      className="jobrow"
                      onClick={() => void open(j.id)}
                    >
                      <td>
                        <strong>{j.title}</strong>
                        <span className="company">{j.company}</span>
                      </td>
                      <td>{j.location || "Not specified"}</td>
                      <td className="capitalize">{j.source}</td>
                      <td>
                        <span
                          className={
                            Number(j.score) > 4 ? "score good" : "score"
                          }
                        >
                          {j.state === "evaluated" &&
                          j.score &&
                          j.decision !== "review"
                            ? `${Number(j.score).toFixed(1)} / 5`
                            : "—"}
                        </span>
                      </td>
                      <td>
                        {j.state === "skipped"
                          ? "Outside scan window"
                          : j.state === "error"
                            ? "Evaluation error"
                            : j.decision === "review"
                              ? "Confirmation needed"
                              : j.state === "pending"
                                ? "Awaiting score"
                                : j.decision === "apply"
                                  ? "Apply"
                                  : "Rejected"}
                      </td>
                      <td className="date-cell">
                        <time
                          dateTime={j.evaluated_at || undefined}
                          title="Evaluated at (Asia/Kolkata)"
                        >
                          {evaluationDate(j.evaluated_at)}
                        </time>
                      </td>
                      <td>
                        <ApplicationStatus
                          id={j.id}
                          value={j.application_status}
                          disabled={!!busy}
                          onChange={setApplication}
                        />
                      </td>
                      <td>
                        <button
                          className="icon-button"
                          aria-label="View job"
                          title="View job"
                          onClick={(e) => {
                            e.stopPropagation();
                            void open(j.id);
                          }}
                        >
                          <ViewIcon />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!jobs.length && (
              <div className="empty">
                <h2>{loading ? "Loading jobs…" : "No jobs match this view"}</h2>
              </div>
            )}
            <footer>
              <span>
                {total} jobs
                {total
                  ? ` · ${offset + 1}–${Math.min(offset + 50, total)}`
                  : ""}
              </span>
              <div>
                <button
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  Previous
                </button>
                <button
                  disabled={offset + 50 >= total}
                  onClick={() => setOffset(offset + 50)}
                >
                  Next
                </button>
              </div>
            </footer>
          </section>
        </>
      )}
      <dialog
        ref={modal}
        aria-labelledby="job-title"
        onCancel={() => setSelected(null)}
        onClose={() => setSelected(null)}
        onClick={(e) => {
          if (e.target === modal.current) {
            modal.current.close();
            setSelected(null);
          }
        }}
      >
        {selected && (
          <>
            <div className="modalhead">
              <div>
                <span className="eyebrow">{selected.company}</span>
                <h2 id="job-title">{selected.title}</h2>
              </div>
              <button
                aria-label="Close job details"
                onClick={() => {
                  modal.current?.close();
                  setSelected(null);
                }}
              >
                Close
              </button>
            </div>
            <JobDetails
              key={selected.id}
              job={selected}
              busy={busy}
              onAction={action}
              onRefresh={refresh}
            />
          </>
        )}
      </dialog>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
