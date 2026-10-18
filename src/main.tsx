import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Job = {
  content_hash?: string;
  id: string;
  title: string;
  company: string;
  location: string;
  source: string;
  apply_url: string;
  score: string | null;
  decision: string;
  state: string;
  error?: string;
  description?: string;
  evaluation?: any;
  metadata?: any;
  tasks?: any[];
};
async function api(url: string, body?: unknown) {
  const r = await fetch(
    `/api${url}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-JobFinder-Request": "1",
          },
          body: JSON.stringify(body),
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
function App() {
  const [tab, setTab] = useState("apply"),
    [q, setQ] = useState(""),
    [offset, setOffset] = useState(0),
    [jobs, setJobs] = useState<Job[]>([]),
    [total, setTotal] = useState(0),
    [status, setStatus] = useState<any>(),
    [selected, setSelected] = useState<Job | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(""),
    [importing, setImporting] = useState(false),
    [importText, setImportText] = useState(""),
    [notice, setNotice] = useState(""),
    [confirmation, setConfirmation] = useState("");
  const modal = useRef<HTMLDialogElement>(null),
    selectedId = useRef<string | null>(null);
  selectedId.current = selected?.id || null;
  async function refresh() {
    try {
      const [s, j] = await Promise.all([
        api("/status"),
        api(`/jobs?tab=${tab}&q=${encodeURIComponent(q)}&offset=${offset}`),
      ]);
      setStatus(s);
      setJobs(j.jobs);
      setTotal(j.total);
      setError("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (!cancelled) void refresh();
    }, 200);
    const polling = setInterval(() => {
      if (!cancelled) void refresh();
    }, 6000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(polling);
    };
  }, [tab, q, offset]);
  useEffect(() => {
    const id = selected?.id;
    if (!id) return;
    modal.current?.showModal();
    const timer = setInterval(() => {
      void api(`/jobs/${id}`)
        .then((j) => {
          if (selectedId.current === id) setSelected(j);
        })
        .catch((e) => setError(String(e)));
    }, 3000);
    return () => clearInterval(timer);
  }, [selected?.id]);
  async function open(j: Job) {
    try {
      setSelected(await api(`/jobs/${j.id}`));
    } catch (e) {
      setError(String(e));
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
  const run = status?.runs?.[0],
    running = run?.state === "running";
  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">PERSONAL JOB WORKSPACE</span>
          <h1>JobFinder</h1>
          <p>Find the fit. Prepare your application.</p>
        </div>
        <button
          className="primary"
          disabled={busy === "run" || running}
          onClick={() =>
            void action("run", async () => {
              await api("/run", {});
              setNotice("Workflow requested. Progress appears below.");
            })
          }
        >
          {running ? "Workflow running…" : "Run workflow"}
        </button>
      </header>
      <section className="schedule">
        <span>
          <strong>Daily at 9:00 AM · Last 24 hours</strong> · Asia/Kolkata
        </span>
        <span>
          {status
            ? `Next: ${date(status.nextRun)}`
            : "Connecting to your workspace…"}
        </span>
      </section>
      <section className="preferences">
        <strong>Your search</strong>
        <span>Pune · Delhi NCR · Bangalore</span>
        <span>Full time · 1.5 years experience · ₹20 LPA minimum</span>
        <small>
          Undisclosed salary is flagged for verification. Apply requires a score
          above 4/5 and no blockers.
        </small>
      </section>
      {error && (
        <div className="alert" role="alert">
          {error} <button onClick={() => void refresh()}>Retry</button>
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
        <nav aria-label="Job filters">
          {[
            ["apply", "Apply"],
            ["rejected", "Rejected"],
            ["pending", "Needs review"],
            ["all", "All jobs"],
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
              {label} <span>{status?.counts?.[id] ?? "—"}</span>
            </button>
          ))}
        </nav>
        <label className="search">
          Search jobs
          <input
            value={q}
            placeholder="Role, company or location"
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
          />
        </label>
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
                <tr key={j.id} onClick={() => void open(j)} className="jobrow">
                  <td>
                    <strong>{j.title}</strong>
                    <span className="company">{j.company}</span>
                  </td>
                  <td>{j.location || "Not specified"}</td>
                  <td className="capitalize">{j.source}</td>
                  <td>
                    <span
                      className={Number(j.score) > 4 ? "score good" : "score"}
                    >
                      {j.score ? `${Number(j.score).toFixed(1)} / 5` : "—"}
                    </span>
                  </td>
                  <td>
                    {j.state === "skipped"
                      ? "Skipped: posting date"
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
                        void open(j);
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
            <h2>{loading ? "Loading jobs…" : "No jobs in this view yet"}</h2>
            <p>
              {loading
                ? "Connecting to PostgreSQL."
                : "Run the workflow to collect and score jobs, or import descriptions from a connected source."}
            </p>
          </div>
        )}
        <footer>
          <span>
            {total} jobs
            {total > 0
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
      <details className="panel">
        <summary>Workflow history & source diagnostics</summary>
        {!status?.runs?.length && <p>No workflow runs yet.</p>}
        {status?.runs?.map((r: any) => (
          <article key={r.id}>
            <strong>
              {date(r.started_at)} · {r.state}
            </strong>
            <p>
              {r.discovered} collected · {r.evaluated} evaluated
              {r.finished_at ? ` · Finished ${date(r.finished_at)}` : ""}
            </p>
            {r.errors?.length > 0 && (
              <details>
                <summary>
                  {r.errors.length} source or evaluation messages
                </summary>
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
      <details className="panel">
        <summary>Company sources & search configuration</summary>
        <p>
          Place <code>companies.xlsx</code> in the project folder. URLs in cells
          and hyperlinks are loaded at each run. Use career board URLs for
          Greenhouse, Lever, Ashby, or individual job pages with structured
          data.
        </p>
        <p>{status?.companyUrls?.length || 0} company URLs configured.</p>
        <pre>{JSON.stringify(status?.search, null, 2)}</pre>
        <p>
          Edit <code>config/search.json</code> to change your search.
        </p>
      </details>
      <section className="panel">
        <button onClick={() => setImporting(!importing)}>
          Import job descriptions
        </button>
        {importing && (
          <div>
            <p>
              Paste a JSON array with title, company, location, source (linkedin
              / indeed / naukri / company / import), apply_url and description.
              Jobs are stored immediately and evaluated on the next workflow
              run.
            </p>
            <label>
              Job data
              <textarea
                rows={8}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
            </label>
            <button
              disabled={busy === "import"}
              onClick={() =>
                void action("import", async () => {
                  const r = await api("/jobs/import", JSON.parse(importText));
                  setNotice(`${r.ids.length} jobs saved.`);
                  setImportText("");
                  setImporting(false);
                })
              }
            >
              Save jobs
            </button>
          </div>
        )}
      </section>
      <dialog
        ref={modal}
        onCancel={() => setSelected(null)}
        onClose={() => setSelected(null)}
        onClick={(e) => {
          if (e.target === modal.current) {
            modal.current?.close();
            setSelected(null);
          }
        }}
        aria-labelledby="job-title"
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
            <div className="modalbody">
              <div className="metadata">
                <span>{selected.location || "Location not specified"}</span>
                <span>{selected.source}</span>
                <strong>
                  {selected.decision === "review"
                    ? "Confirmation needed"
                    : selected.score
                      ? `${Number(selected.score).toFixed(1)} / 5`
                      : "Awaiting evaluation"}
                </strong>
              </div>
              <a
                className="applylink"
                href={selected.apply_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open application ↗
              </a>
              {selected.error && <p className="alert">{selected.error}</p>}
              {selected.evaluation && (
                <>
                  <h3>Career Ops evaluation</h3>
                  <p>{selected.evaluation.summary}</p>
                  <p>Evidence confidence: {selected.evaluation.confidence}</p>
                  {[
                    ["Strengths", selected.evaluation.strengths],
                    ["Gaps to verify", selected.evaluation.gaps],
                    ["Blockers", selected.evaluation.blockers],
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
                    <pre>{selected.evaluation.report}</pre>
                  </details>
                </>
              )}
              {selected.state === "evaluated" && Number(selected.score) >= 2 ? (
                <section className="artifactbox">
                  <h3>Prepare application documents</h3>
                  <p>
                    Tailoring targets the best honest fit. The resume is scored
                    again; 5.0 is not guaranteed. Review documents before
                    applying.
                  </p>
                  <div className="actions">
                    {[
                      ["resume", "Tailor resume (PDF)"],
                      ["cover", "Create cover letter (Word)"],
                    ].map(([kind, label]) => (
                      <button
                        className={kind === "resume" ? "primary" : ""}
                        key={kind}
                        disabled={
                          !!busy ||
                          selected.tasks?.some(
                            (t) =>
                              t.kind === kind &&
                              ["queued", "running"].includes(t.state),
                          )
                        }
                        onClick={() =>
                          void action(kind, async () => {
                            await api(`/jobs/${selected.id}/artifacts`, {
                              kind,
                            });
                            setSelected(await api(`/jobs/${selected.id}`));
                          })
                        }
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {selected.tasks?.map((t) => (
                    <div className="task" key={t.id}>
                      <strong>
                        {t.kind === "resume"
                          ? "Tailored resume"
                          : "Cover letter"}
                      </strong>{" "}
                      · {t.state}
                      {t.error && <p className="alert">{t.error}</p>}
                      {t.result && (
                        <>
                          <p>
                            <a href={t.result.download_url}>
                              Download{" "}
                              {t.kind === "resume"
                                ? "PDF resume"
                                : "Word cover letter"}
                            </a>
                            {t.result.tailoredEvaluation?.score != null &&
                              ` · New score: ${t.result.tailoredEvaluation.score.toFixed(1)} / 5`}
                          </p>
                          {t.result.remainingGaps?.length > 0 && (
                            <p>
                              Remaining gaps:{" "}
                              {t.result.remainingGaps.join("; ")}
                            </p>
                          )}
                          <small>
                            Generated draft · Review required
                            {t.result.contentHash !== selected.content_hash
                              ? " · Job description has changed since generation"
                              : ""}
                          </small>
                        </>
                      )}
                    </div>
                  ))}
                </section>
              ) : (
                <p>
                  Document generation is available for jobs with a completed
                  score of 2–5.
                </p>
              )}
              {selected.decision === "review" && (
                <section>
                  <label>
                    Answer the confirmation question above
                    <textarea
                      value={confirmation}
                      onChange={(e) => setConfirmation(e.target.value)}
                      rows={3}
                    />
                  </label>
                  <button
                    disabled={!!busy || confirmation.trim().length < 3}
                    onClick={() =>
                      void action("confirm", async () => {
                        await api(`/jobs/${selected.id}/confirm`, {
                          answer: confirmation,
                        });
                        setConfirmation("");
                        setSelected(await api(`/jobs/${selected.id}`));
                      })
                    }
                  >
                    Save answer and queue evaluation
                  </button>
                </section>
              )}
              {selected.state === "error" && (
                <button
                  disabled={!!busy}
                  onClick={() =>
                    void action("retry", async () => {
                      await api(`/jobs/${selected.id}/retry`, {});
                      setSelected(await api(`/jobs/${selected.id}`));
                    })
                  }
                >
                  Queue evaluation retry
                </button>
              )}
              <h3>Job description</h3>
              <pre>{selected.description}</pre>
              <details>
                <summary>All source metadata</summary>
                <pre>{JSON.stringify(selected.metadata, null, 2)}</pre>
              </details>
            </div>
          </>
        )}
      </dialog>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
