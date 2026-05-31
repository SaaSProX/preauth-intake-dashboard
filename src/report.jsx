/* ============================================================
   SaaSPro — Pre-Auth Investigation Report (PDF)
   Ports the user-supplied design (report.css + report.js) into the
   dashboard. Renders via React.createPortal so it sits at document.body
   level; CSS in App.css keeps it display:none on screen and reveals it
   only in @media print.
   ============================================================ */
import React from 'react';
import { createPortal } from 'react-dom';

/* ---- formatting helpers (independent from the dashboard's) ---- */
function rfmtNGN(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return '₦' + (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2) + 'm';
  if (n >= 1_000)    return '₦' + (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return '₦' + Number(n).toLocaleString();
}
function rfmtNGNfull(n) { return n == null ? '—' : '₦' + Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 }); }
function rfmtSecs(s) { if (s == null) return '—'; const v = Number(s); if (v < 60) return v.toFixed(1) + 's'; return (v / 60).toFixed(1) + 'm'; }
function rPlanClass(p) {
  const s = (p || '').toLowerCase();
  if (s.includes('platinum')) return 'platinum';
  if (s.includes('gold'))     return 'gold';
  if (s.includes('silver'))   return 'silver';
  if (s.includes('bronze'))   return 'bronze';
  return '';
}

const R_STATUS = {
  approve:    { label: 'Approve',    cls: 'approve' },
  deny:       { label: 'Deny',       cls: 'deny' },
  escalate:   { label: 'Escalate',   cls: 'escalate' },
  pending:    { label: 'Pending',    cls: 'pending' },
  processing: { label: 'Processing', cls: 'processing' },
  received:   { label: 'Received',   cls: 'received' },
  error:      { label: 'Error',      cls: 'error' },
};

const STAGE_Q = {
  Eligibility: 'Is the member valid — active, not expired, within age limit?',
  'Plan & Coverage': 'Is the item covered, excluded, or in a waiting period?',
  'Utilization & Limits': 'Does the cost fit under the benefit and annual cap?',
  'Final Decision': 'Aggregate stages 1–3 → APPROVE / DENY / ESCALATE',
};

function asObj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
function asArr(v) { return Array.isArray(v) ? v : []; }

/* ============================================================
   Adapter: convert our patient-history payload into the REPORT
   structure the renderer expects. One run per PA (we don't yet
   track re-evaluations), but the structure leaves room for them.
   ============================================================ */
export function buildReport({ patient, requests, session, orgName, downloadedAt }) {
  const pas = (requests || []).slice().sort((a, b) => {
    const ta = a.received_at ? Date.parse(a.received_at) : 0;
    const tb = b.received_at ? Date.parse(b.received_at) : 0;
    return tb - ta; // newest first
  });

  const headerName = pas.find((p) => p.patient_name)?.patient_name || 'Unnamed enrollee';
  const headerPlan = pas.find((p) => p.plan && p.plan !== '—')?.plan || '—';

  return {
    org: {
      name: orgName || session?.org_name || 'Organization',
      short: (orgName || session?.org_name || '').toUpperCase().slice(0, 12),
      domain: '',
    },
    meta: {
      title: 'Pre-Auth Investigation Report',
      classification: 'Confidential · Internal use only',
      downloaded_by: session?.name || session?.email || 'Operator',
      downloaded_by_handle: (session?.role || 'admin'),
      downloaded_at: (downloadedAt || new Date()).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'long' }),
      report_id: 'PA-RPT-' + (patient?.patient_id || '——'),
      generated_note: 'Generated from the SaaSPro pre-authorization pipeline. Figures reflect the request state at the time of download.',
    },
    patient: {
      name: headerName,
      insurance_no: patient?.patient_id || '—',
      plan: headerPlan,
    },
    pas: pas.map((p) => paToReportPa(p)),
  };
}

function paToReportPa(p) {
  // Items: shape to { name, qty, line, covered }
  const items = asArr(p.items).map((it) => ({
    name: it.name || 'Item',
    qty: Number(it.qty) || 1,
    line: (Number(it.unit) || 0) * (Number(it.qty) || 1),
    // Per-item coverage decision from Agent 2 (covered/denied). When we don't
    // know per-item, fall back to the overall PA status.
    covered: it.coverage_verdict ? it.coverage_verdict !== 'denied' : (p.status !== 'deny'),
  }));

  // Single agent run from the stages array.
  const stages = asArr(p.stages);
  const runOutcome = p.status || 'pending';
  const runOutcomeLabel = (R_STATUS[runOutcome] || R_STATUS.pending).label;

  const reportStages = stages.map((s) => {
    const ag2 = s.name === 'Plan & Coverage';
    const ag3 = s.name === 'Utilization & Limits';
    const ag4 = s.name === 'Final Decision';
    const ag1 = s.name === 'Eligibility';
    const result = asObj(s.result);
    const stage = {
      n: s.n,
      name: s.name,
      status: s.status === 'processing' ? 'skip' : (s.status || 'pass'),
      time: s.time || '',
      q: STAGE_Q[s.name] || '',
      summary: result.reason || result.reasoning || result.denial_reason || result.escalation_reason || '',
      result,
    };
    if (ag1 && result.checks) {
      const c = asObj(result.checks);
      stage.checks = [
        c.status_active ? 'Active' : null,
        c.not_expired ? 'Not expired' : null,
        c.age_ok ? 'Age OK' : null,
        c.enrollment_valid ? 'Enrollment valid' : null,
      ].filter(Boolean);
    }
    if (ag2) {
      const covered = asArr(result.covered_items).length;
      const denied = asArr(result.denied_items).length;
      stage.coverage = { category: result.benefit_category || 'Outpatient', covered, denied };
      if (result.exclusion_triggered && result.exclusion_detail) stage.exclusion = result.exclusion_detail;
    }
    if (ag3) {
      const limits = [];
      if (result.bucket && result.bucket_limit != null) limits.push({ label: result.bucket || 'Bucket', used: Number(result.bucket_used) || 0, of: Number(result.bucket_limit) || 0 });
      if (result.annual_cap_limit != null) limits.push({ label: 'Annual cap', used: Number(result.annual_cap_used) || 0, of: Number(result.annual_cap_limit) || 0 });
      if (limits.length) stage.limits = limits;
      if (result.estimated_cost != null) stage.this_request = Number(result.estimated_cost);
    }
    if (ag4) {
      stage.decision = result.decision || (p.decision || '').toUpperCase();
      stage.confidence = result.confidence || p.confidence || null;
      if (result.amount_approved != null) stage.approved = Number(result.amount_approved);
    }
    return stage;
  });

  return {
    short_ref: (p.display_request_id || p.request_id || '').split('/').slice(-1)[0],
    display_request_id: p.display_request_id || p.request_id,
    status: p.status, decision: p.decision, confidence: p.confidence,
    plan: p.plan,
    diagnosis: p.diagnosis,
    checkin_type: p.checkin_type,
    facility: p.facility,
    requesting_provider: p.requesting_provider,
    received_label: p.received_label,
    received_at: p.received_label || (p.received_at ? new Date(p.received_at).toLocaleString() : ''),
    processing_seconds: p.processing_seconds,
    requested_amount: p.requested_amount,
    amount_approved: p.amount_approved,
    line_item_count: p.line_item_count || items.length,
    reason: p.reason || '',
    flags: asArr(p.flags),
    items,
    runs: [{
      label: 'Agent run', time: '', outcome: runOutcome,
      outcome_label: runOutcomeLabel,
      note: '',
      stages: reportStages,
    }],
  };
}

/* ============================================================
   React renderers — JSX equivalents of the user's renderReport()
   ============================================================ */
function RPill({ status }) {
  const m = R_STATUS[status] || R_STATUS.pending;
  return <span className={`pill ${m.cls}`}><span className="dot" />{m.label}</span>;
}
function RConf({ level }) {
  if (!level) return null;
  return (
    <span className={`conf ${String(level).toLowerCase()}`}>
      <span className="bars"><i /><i /><i /></span><b>{level}</b> confidence
    </span>
  );
}
function RPlanTag({ plan }) { return <span className={`plan-tag ${rPlanClass(plan)}`}>{plan}</span>; }

function RPayload({ obj }) {
  return (
    <div className="payload">
      {Object.entries(obj || {}).map(([k, v]) => {
        let cls = 'pv-str', display;
        if (v === true) { cls = 'pv-bool true'; display = 'true'; }
        else if (v === false) { cls = 'pv-bool false'; display = 'false'; }
        else if (typeof v === 'number') { cls = 'pv-num'; display = v.toLocaleString(); }
        else if (v == null) { cls = 'pv-null'; display = 'null'; }
        else if (typeof v === 'object') { cls = 'pv-str'; display = JSON.stringify(v); }
        else display = String(v);
        return (
          <div className="pv-row" key={k}>
            <span className="pv-k">{k}</span>
            <span className={cls}>{display}</span>
          </div>
        );
      })}
    </div>
  );
}

function RMasthead({ R }) {
  return (
    <header className="rpt-mast">
      <div className="rpt-brand">
        <span className="rpt-mark" />
        <span className="rpt-word">SaaSPro</span>
      </div>
      <div className="rpt-mast-r">
        <div className="rpt-doc">{R.meta.title}</div>
        <div className="rpt-class">{R.meta.classification}</div>
      </div>
    </header>
  );
}

function RTitle({ R }) {
  const cells = [
    ['Organization', `${R.org.name}${R.org.short ? ` · ${R.org.short}` : ''}`, false],
    ['Downloaded by', R.meta.downloaded_by, true],
    ['Downloaded at', R.meta.downloaded_at, false],
    ['Report ID', R.meta.report_id, false],
  ];
  return (
    <section className="rpt-title">
      <div className="rt-eyebrow">Enrollee record</div>
      <h1 className="rt-name">{R.patient.name}</h1>
      <div className="rt-sub">
        <span className="rt-id">{R.patient.insurance_no}</span>
        <RPlanTag plan={R.patient.plan} />
      </div>
      <div className="rt-meta">
        {cells.map(([l, v, withTag]) => (
          <div className="rt-cell" key={l}>
            <span className="rt-l">{l}</span>
            <span className="rt-v">
              {v}
              {withTag ? <span className="mtag">{R.meta.downloaded_by_handle}</span> : null}
            </span>
          </div>
        ))}
      </div>
      <p className="rt-note">{R.meta.generated_note}</p>
    </section>
  );
}

function RSummary({ R }) {
  const totalReq = R.pas.reduce((s, p) => s + (Number(p.requested_amount) || 0), 0);
  const totalApp = R.pas.reduce((s, p) => s + (p.status === 'approve' ? Number(p.amount_approved || 0) : 0), 0);
  const counts = {};
  R.pas.forEach((p) => { counts[p.status] = (counts[p.status] || 0) + 1; });
  return (
    <section className="rpt-summary">
      <div className="rs-stat"><span className="rs-l">Pre-auths</span><b className="rs-v">{R.pas.length}</b></div>
      <div className="rs-div" />
      <div className="rs-stat"><span className="rs-l">Requested · total</span><b className="rs-v">{rfmtNGN(totalReq)}</b></div>
      <div className="rs-div" />
      <div className="rs-stat"><span className="rs-l">Approved · total</span><b className="rs-v rs-ok">{rfmtNGN(totalApp)}</b></div>
      <div className="rs-div" />
      <div className="rs-stat rs-grow">
        <span className="rs-l">Outcomes</span>
        <div className="rs-mix">
          {Object.entries(counts).map(([k, n]) => {
            const m = R_STATUS[k] || R_STATUS.pending;
            return <span key={k} className={`mix-pill ${m.cls}`}><span className="dot" />{n} {m.label.toLowerCase()}</span>;
          })}
        </div>
      </div>
    </section>
  );
}

function RDecision({ p }) {
  const cls = (R_STATUS[p.status] || R_STATUS.pending).cls;
  const verdict = (p.decision || (R_STATUS[p.status] || R_STATUS.pending).label || '').toUpperCase();
  const showAmts = p.status === 'approve' || p.amount_approved != null;
  return (
    <div className={`decision ${cls}`}>
      <div className="verdict-row">
        <span className="verdict">{verdict}</span>
        <RPill status={p.status} />
        <RConf level={p.confidence} />
      </div>
      {p.reason ? <p className="reason">{p.reason}</p> : null}
      {showAmts ? (
        <div className="amt-line">
          <div><span className="lab">Requested</span><span className="av">{rfmtNGNfull(p.requested_amount)}</span></div>
          <div><span className="lab">Approved</span><span className="av strong">{rfmtNGNfull(p.amount_approved)}</span></div>
        </div>
      ) : null}
      {asArr(p.flags).length ? (
        <div className="flags">{p.flags.map((f, i) => <span key={i} className="flag">{f}</span>)}</div>
      ) : null}
    </div>
  );
}

function RDetails({ p, R }) {
  const cells = [
    ['Enrollee', R.patient.name, false],
    ['Insurance no.', R.patient.insurance_no, true],
    ['Plan', p.plan || R.patient.plan, false],
    ['Diagnosis', p.diagnosis || '—', true],
    ['Encounter', p.checkin_type || '—', false],
    ['Line items', String(p.line_item_count || (p.items ? p.items.length : 0)), true],
    ['Facility', p.facility || '—', false],
    ['Provider', p.requesting_provider || '—', false],
    ['Requested value', rfmtNGNfull(p.requested_amount), true],
    ['Approved value', rfmtNGNfull(p.amount_approved), true],
    ['Received', p.received_at || p.received_label || '—', true],
    ['Decision latency', rfmtSecs(p.processing_seconds), true],
  ];
  return (
    <div className="dgrid">
      {cells.map(([l, v, mono]) => (
        <div className="cell" key={l}>
          <div className="lab">{l}</div>
          <div className={`val ${mono ? 'mono' : ''}`}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function RItems({ p }) {
  if (!p.items || !p.items.length) return null;
  return (
    <div className="rpt-block">
      <div className="sec-h">Requested items <span className="n">{p.items.length}</span></div>
      <table className="items">
        <thead>
          <tr>
            <th>Item</th>
            <th className="qty">Qty</th>
            <th className="amt">Line value</th>
            <th className="cov">Coverage</th>
          </tr>
        </thead>
        <tbody>
          {p.items.map((it, i) => (
            <tr key={i}>
              <td className="it-name">{it.name}</td>
              <td className="qty">×{it.qty}</td>
              <td className="amt">{rfmtNGNfull(it.line)}</td>
              <td className="cov">
                <span className={`cov-tag ${it.covered ? 'ok' : 'no'}`}>{it.covered ? 'Covered' : 'Denied'}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RStage({ s }) {
  const cls = s.status === 'processing' ? 'skip' : (s.status || 'skip');
  const node = s.status === 'pass' ? '✓' : s.status === 'fail' ? '✕' : String(s.n);
  const statTxt = s.status === 'processing' ? 'running' : s.status;
  return (
    <div className={`stage ${cls}`}>
      <div className="node">{node}</div>
      <div className="s-top">
        <span className="s-name">{s.n}. {s.name}</span>
        <span className="s-stat">{statTxt}</span>
        {s.time ? <span className="s-time">{s.time}</span> : null}
      </div>
      {s.q ? <p className="s-q">{s.q}</p> : null}
      {s.summary ? <p className="s-sum">{s.summary}</p> : null}
      {s.checks && s.checks.length ? (
        <div className="s-checks">{s.checks.map((c) => <span key={c} className="s-chk">✓ {c}</span>)}</div>
      ) : null}
      {s.coverage ? (
        <div className="s-checks">
          <span className="s-chk neutral">{s.coverage.category}</span>
          {s.coverage.covered ? <span className="s-chk">✓ {s.coverage.covered} covered</span> : null}
          {s.coverage.denied ? <span className="s-chk bad">✕ {s.coverage.denied} denied</span> : null}
        </div>
      ) : null}
      {s.exclusion ? (
        <div className="s-excl"><span className="s-excl-l">Exclusion</span>{s.exclusion}</div>
      ) : null}
      {s.limits ? (
        <div className="s-limits">
          {s.limits.map((l, i) => {
            const pct = l.of > 0 ? Math.min(100, (Number(l.used) || 0) / l.of * 100) : 0;
            return (
              <div className="s-meter" key={i}>
                <div className="sm-top">
                  <span>{l.label}</span>
                  <span className="sm-fig">{rfmtNGN(l.used)} <em>of {rfmtNGN(l.of)}</em></span>
                </div>
                <div className="sm-bar"><i style={{ width: pct.toFixed(1) + '%' }} /></div>
              </div>
            );
          })}
        </div>
      ) : null}
      {s.this_request != null ? (
        <div className="s-thisreq">This request · <b>{rfmtNGN(s.this_request)}</b></div>
      ) : null}
      {s.decision ? (
        <div className={`s-verdict ${cls}`}>
          <span className="sv-d">{s.decision}</span>
          {s.confidence ? <span className="sv-c">Confidence {s.confidence}</span> : null}
          {s.approved != null ? <span className="sv-a">Approved {rfmtNGNfull(s.approved)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function RRuns({ p }) {
  const totalStages = (p.runs || []).reduce((n, r) => n + (r.stages || []).length, 0);
  return (
    <div className="rpt-block timeline-block">
      <div className="sec-h">Agent reasoning timeline <span className="n">{totalStages} stages · {(p.runs || []).length} run(s)</span></div>
      <div className="runs">
        {(p.runs || []).map((run, i) => {
          const ocCls = R_STATUS[run.outcome] ? R_STATUS[run.outcome].cls : (run.outcome === 'halted' ? 'deny' : 'pending');
          return (
            <div className="run" key={i}>
              <div className="run-head">
                <div className="run-id">
                  <span className="run-num">{i + 1}</span>
                  <span className="run-label">{run.label}</span>
                </div>
                <div className="run-meta">
                  {run.time ? <span className="run-time">{run.time}</span> : null}
                  <span className={`run-oc ${ocCls}`}>{run.outcome_label || run.outcome}</span>
                </div>
              </div>
              {run.note ? <p className="run-note">{run.note}</p> : null}
              <div className="timeline">
                {(run.stages || []).map((s, j) => <RStage key={j} s={s} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RPA({ p, R, idx, total }) {
  return (
    <section className="rpt-pa" data-screen-label={`Pre-Auth ${p.short_ref}`}>
      <div className="pa-bar">
        <div className="pa-bar-l">
          <span className="pa-seq">PA {idx + 1} / {total}</span>
          <span className="pa-ref">{p.display_request_id}</span>
        </div>
        <div className="pa-bar-r">
          <RPill status={p.status} />
          <span className="pa-amt">{rfmtNGN(p.requested_amount)}</span>
          <span className="pa-when">{p.received_label}</span>
        </div>
      </div>
      <RDecision p={p} />
      <div className="rpt-block">
        <div className="sec-h">Request details</div>
        <RDetails p={p} R={R} />
      </div>
      <RItems p={p} />
      <RRuns p={p} />
    </section>
  );
}

function RAppendix({ R }) {
  const blocks = R.pas.map((p) => {
    const items = (p.runs || []).flatMap((run) =>
      (run.stages || []).filter((s) => s.result && Object.keys(s.result).length).map((s) => ({ run: run.label, s }))
    );
    if (!items.length) return null;
    return (
      <div className="apx-pa" key={p.display_request_id}>
        <div className="apx-ref">{p.display_request_id}</div>
        {items.map(({ run, s }, i) => (
          <div className="apx-stage" key={i}>
            <div className="apx-stage-h">
              <span className="apx-run">{run}</span> · <span>{s.n}. {s.name}</span>
            </div>
            <RPayload obj={s.result} />
          </div>
        ))}
      </div>
    );
  }).filter(Boolean);
  if (!blocks.length) return null;
  return (
    <section className="rpt-appendix">
      <div className="sec-h">Appendix · raw stage payloads</div>
      <p className="apx-note">Machine output from each agent stage, retained for audit. Human-readable summaries appear in the timeline above.</p>
      {blocks}
    </section>
  );
}

/* ============================================================
   The portal-mounted sheet. Hidden on screen; @media print
   reveals it and hides everything else.
   ============================================================ */
export function PatientReportSheet({ patient, requests, session, orgName, downloadedAt }) {
  if (typeof document === 'undefined' || !patient || !patient.patient_id) return null;
  const R = buildReport({ patient, requests, session, orgName, downloadedAt });
  return createPortal(
    <div className="report-sheet-portal">
      <div className="paper-stage">
        <div className="sheet">
          <RMasthead R={R} />
          <RTitle R={R} />
          <RSummary R={R} />
          {(R.pas || []).map((p, i) => <RPA key={p.display_request_id || i} p={p} R={R} idx={i} total={R.pas.length} />)}
          <RAppendix R={R} />
          <footer className="rpt-end">
            <span className="re-brand"><span className="rpt-mark sm" /> SaaSPro · Pre-Auth Operations</span>
            <span className="re-id">{R.meta.report_id} · {R.meta.downloaded_at}</span>
          </footer>
        </div>
      </div>
      <div className="print-foot">
        <span>{R.meta.report_id}</span>
        <span className="pf-c">{R.meta.classification}</span>
        <span>{R.meta.downloaded_by} · {R.meta.downloaded_at}</span>
      </div>
    </div>,
    document.body,
  );
}
