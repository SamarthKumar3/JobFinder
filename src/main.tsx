import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
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
    tab: tab === "url" ? "all" : tab,
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
      void api(`/jobs?${query}`, undefined, abort.signal)
        .then(applyRows)
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
  }, [query]);
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
        api(`/jobs?${query}`),
        api("/submissions"),
      ]);
      setStatus(s);
      applyRows(j);
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
            Workflow: {running ? "Running" : run?.state || "Idle"}{" "}
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
              {id !== "url" && <span>{status?.counts?.[id] ?? "—"}</span>}
            </button>
          ))}
        </nav>
      </div>
      {tab === "url" ? (
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
            {submissions.map((s) => (
              <article className="submission" key={s.id}>
                <div>
                  <a href={s.url} target="_blank" rel="noopener noreferrer">
                    {s.title || s.url}
                  </a>
                  <p>
                    {s.company} · {s.state} · {date(s.created_at)}
                  </p>
                  {s.error && <p className="alert">{s.error}</p>}
                </div>
                {s.job_id && (
                  <button
                    onClick={() => {
                      setActiveSubmission(s.id);
                      void open(s.job_id, true);
                    }}
                  >
                    View result
                  </button>
                )}
              </article>
            ))}
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
                    <th>Status</th>
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
                      <td>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void open(j.id);
                          }}
                        >
                          View job
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
      <details className="panel">
        <summary>Workflow history & source diagnostics</summary>
        {!status?.runs?.length && <p>No workflow runs yet.</p>}
        {status?.runs?.map((r: any) => (
          <article key={r.id}>
            <strong>
              {date(r.started_at)} · {r.state}
            </strong>
            <p>
              {r.phase} · {r.discovered} collected · {r.filtered || 0} filtered
              · {r.evaluated} evaluated
              {r.finished_at ? ` · Finished ${date(r.finished_at)}` : ""}
            </p>
            {r.errors?.length > 0 && (
              <details>
                <summary>{r.errors.length} messages</summary>
                <ul>
                  {r.errors.map((e: string, i: number) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </details>
            )}
          </article>
        ))}
      </details>
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
