import React, { useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'saaspro-preauth-dashboard-session';
const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000');

function normalizeApiBaseUrl(value) {
  const t = String(value || '').trim();
  if (!t) return 'http://localhost:8000';
  const w = /^https?:\/\//i.test(t) ? t : `http://${t}`;
  return w.replace(/\/+$/, '');
}

/* ============================================================
   Formatting
   ============================================================ */
function fmtNGN(n) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '—';
  n = Number(n);
  if (n >= 1_000_000) return '₦' + (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2) + 'm';
  if (n >= 1_000) return '₦' + (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return '₦' + n.toLocaleString();
}
function fmtNGNfull(n) {
  return (n == null || n === '' || Number.isNaN(Number(n))) ? '—' : '₦' + Number(n).toLocaleString('en-NG');
}
function fmtSecs(s) {
  if (s == null || s === '') return '—';
  s = Number(s);
  if (s < 60) return s.toFixed(1) + 's';
  return (s / 60).toFixed(1) + 'm';
}
function parseApiDate(value) {
  if (!value) return null;
  const text = String(value);
  return /(?:z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
}
function timeAgo(value) {
  if (!value) return '—';
  const d = new Date(parseApiDate(value));
  if (Number.isNaN(d.getTime())) return '—';
  const min = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  if (min < 1) return 'just now';
  if (min < 60) return min + 'm ago';
  const h = Math.floor(min / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
function fmtClock(value) {
  if (!value) return '';
  const d = new Date(parseApiDate(value));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

const STATUS_META = {
  approve: { label: 'Approve', cls: 'approve' },
  deny: { label: 'Deny', cls: 'deny' },
  escalate: { label: 'Escalate', cls: 'escalate' },
  pending: { label: 'Pending', cls: 'pending' },
  processing: { label: 'Processing', cls: 'processing' },
  received: { label: 'Received', cls: 'received' },
  error: { label: 'Error', cls: 'error' },
};
function normalizeStatus(v) {
  const s = String(v || 'pending').toLowerCase();
  if (s === 'approved') return 'approve';
  if (['denied', 'reject', 'rejected'].includes(s)) return 'deny';
  if (s === 'escalated') return 'escalate';
  return STATUS_META[s] ? s : 'pending';
}
function planClass(p) {
  const s = (p || '').toLowerCase();
  if (s.includes('platinum')) return 'platinum';
  if (s.includes('gold')) return 'gold';
  if (s.includes('silver')) return 'silver';
  if (s.includes('bronze')) return 'bronze';
  return '';
}

/* ============================================================
   Map the real /auth/preauth-dashboard request -> view model
   ============================================================ */
function asObj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
function asArr(v) { return Array.isArray(v) ? v : []; }

function providerLabel(v) {
  if (!v) return '';
  if (typeof v === 'object') return v.name || v.role || v.email || '';
  return String(v);
}
function itemsFromPayload(raw) {
  const p = asObj(raw);
  const list = asArr(p.pa_items).length ? p.pa_items
    : asArr(p.submission?.items_added).length ? p.submission.items_added
    : asArr(p.requested_items).length ? p.requested_items
    : asArr(p.items).length ? p.items
    : asArr(p.line_items);
  return asArr(list).map((it) => ({
    name: it.item_name || it.description || it.name || 'Item',
    qty: Number(it.quantity) || 1,
    unit: Number(it.unit_cost ?? it.requested_cost ?? it.cost ?? 0) || 0,
  }));
}
function itemReqCost(it) {
  const direct = Number(it.requested_cost ?? it.estimated_cost ?? it.cost ?? it.amount);
  if (Number.isFinite(direct) && direct) return direct;
  const unit = Number(it.unit_cost);
  const qty = Number(it.quantity) || 1;
  return Number.isFinite(unit) ? unit * qty : 0;
}
function requestedAmount(r, raw) {
  const p = asObj(raw);
  const items = asArr(p.pa_items).length ? p.pa_items : asArr(p.items);
  const total = items.reduce((s, it) => s + itemReqCost(it), 0);
  return total || Number(p.total_requested_cost) || Number(r.estimated_cost) || 0;
}

const STAGE_NAMES = { 1: 'Eligibility', 2: 'Plan & Coverage', 3: 'Utilization & Limits', 4: 'Final Decision' };
const STAGE_Q = {
  Eligibility: 'Is the member valid — active, not expired, within age limit?',
  'Plan & Coverage': 'Is the item covered, excluded, or in a waiting period?',
  'Utilization & Limits': 'Does the cost fit under the benefit and annual cap?',
  'Final Decision': 'Aggregate stages 1–3 → APPROVE / DENY / ESCALATE',
};
function deriveStages(r) {
  const logs = asArr(r.agent_logs);
  if (logs.length) {
    return logs.map((l) => ({
      n: l.agent_num,
      name: l.agent_name || STAGE_NAMES[l.agent_num] || '',
      status: l.status === 'pass' || l.status === 'fail' ? l.status : (l.status || 'pass'),
      time: fmtClock(l.logged_at),
      result: l.result,
    }));
  }
  const ar = asObj(r.agent_result);
  const out = [];
  for (let i = 1; i <= 4; i++) {
    const o = ar['agent' + i];
    if (o && typeof o === 'object') {
      let status = 'pass';
      if (i !== 4) {
        if (o.pass === false) status = 'fail';
        else if (o.pass === true) status = 'pass';
      }
      out.push({ n: i, name: STAGE_NAMES[i], status, time: '', result: o });
    }
  }
  return out;
}

function mapRequest(r) {
  const raw = asObj(r.raw_payload);
  const enc = asObj(raw.encounter);
  const ar = asObj(r.agent_result);
  const isLive = raw.event_type === 'pa.submitted';
  let status = normalizeStatus(r.status);
  if (isLive && !r.decision) status = 'received';
  const items = itemsFromPayload(raw);
  const diagnosis = asArr(enc.diagnosis).join(', ') || (typeof enc.diagnosis === 'string' ? enc.diagnosis : '—');
  return {
    request_id: r.request_id,
    display_request_id: r.display_request_id || r.request_id,
    patient_id: r.patient_id || '—',
    patient_name: r.patient_name || '',
    status,
    decision: r.decision,
    confidence: r.confidence || ar.confidence,
    agent_step: r.agent_step,
    plan: r.plan || '—',
    item_type: r.item_type || '',
    item_description: r.item_description || '—',
    line_item_count: r.line_item_count || items.length,
    requested_amount: requestedAmount(r, raw),
    amount_approved: r.amount_approved ?? ar.amount_approved ?? null,
    facility: r.facility || '—',
    requesting_provider: providerLabel(r.requesting_provider) || '—',
    processing_seconds: r.processing_seconds,
    received_at: r.received_at,
    received_label: timeAgo(r.received_at),
    diagnosis,
    checkin_type: enc.checkin_type || '—',
    reason: r.reason || ar.reasoning || ar.denial_reason || ar.escalation_reason || '',
    error_message: r.error_message,
    flags: asArr(ar.flags),
    items,
    note: isLive ? 'Live HMO payload received. Automated decisioning is paused pending mapping validation for this corporation.' : '',
    stages: deriveStages(r),
    raw_payload: r.raw_payload,
    extracted_fields: r.extracted_fields,
  };
}

function jsonPretty(obj) {
  if (obj == null) return '<span style="color:#6b7385">null</span>';
  let json;
  try { json = JSON.stringify(obj, null, 2); } catch { return String(obj); }
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"([^"]+)":/g, '<span class="k">"$1"</span>:')
    .replace(/: "([^"]*)"/g, ': <span class="s">"$1"</span>')
    .replace(/: (true|false)/g, ': <span class="b">$1</span>')
    .replace(/: (-?\d[\d_]*\.?\d*)/g, ': <span class="n">$1</span>');
}

/* ============================================================
   Small presentational pieces
   ============================================================ */
function Pill({ status }) {
  const m = STATUS_META[status] || STATUS_META.pending;
  return <span className={`pill ${m.cls}`}><span className="dot" />{m.label}</span>;
}
function Conf({ level }) {
  if (!level) return null;
  return (
    <span className={`conf ${String(level).toLowerCase()}`}>
      <span className="bars"><i /><i /><i /></span><b>{level}</b> confidence
    </span>
  );
}
function PlanTag({ plan }) {
  return <span className={`plan-tag ${planClass(plan)}`}>{plan}</span>;
}
function CodeBlock({ data, style }) {
  return <div className="codeblock" style={style} dangerouslySetInnerHTML={{ __html: jsonPretty(data) }} />;
}

/* ============================================================
   Queue list item (split layout)
   ============================================================ */
function QueueItem({ r, selected, onSelect }) {
  const ref = (r.display_request_id || '').split('/').slice(-1)[0] || r.request_id;
  return (
    <div className={`qitem ${selected ? 'sel' : ''}`} onClick={() => onSelect(r.request_id)}>
      <div className="qi-top"><span className="qi-ref">{ref}</span><Pill status={r.status} /></div>
      <div className="qi-name">
        {r.patient_name || <span className="muted">Unnamed enrollee</span>}
        <small>{r.patient_id}</small>
      </div>
      <div className="qi-meta">
        <PlanTag plan={r.plan} /><span>{r.item_description}</span>
        <span className="amt">{fmtNGN(r.requested_amount)}</span>
      </div>
    </div>
  );
}

/* ============================================================
   Detail view (decision + agent timeline + payload)
   ============================================================ */
function DecisionBlock({ r }) {
  const cls = (STATUS_META[r.status] || STATUS_META.pending).cls;
  const verdict = (r.decision || (STATUS_META[r.status] || STATUS_META.pending).label).toUpperCase();
  let body;
  if (r.error_message) {
    body = <p className="reason">{r.error_message}</p>;
  } else if (r.status === 'received') {
    body = <p className="reason">{r.note}</p>;
  } else if (!r.decision) {
    const label = (STATUS_META[r.status] || STATUS_META.pending).label.toLowerCase();
    body = <p className="reason">No decision yet — request is <b>{label}</b>{r.agent_step ? <> at the <b>{r.agent_step}</b> stage.</> : '.'}</p>;
  } else {
    body = (
      <>
        <p className="reason">{r.reason}</p>
        {r.status === 'approve' && (
          <div className="amt-line">
            <div><span className="lab">Requested</span>{fmtNGNfull(r.requested_amount)}</div>
            <div><span className="lab">Approved</span><b>{fmtNGNfull(r.amount_approved)}</b></div>
          </div>
        )}
      </>
    );
  }
  return (
    <div className={`decision ${cls}`}>
      <div className="verdict-row"><span className="verdict">{verdict}</span><Pill status={r.status} /><Conf level={r.confidence} /></div>
      {body}
      {r.flags && r.flags.length > 0 && (
        <div className="flags">{r.flags.map((f, i) => <span className="flag" key={i}>{f}</span>)}</div>
      )}
    </div>
  );
}
function DetailsGrid({ r }) {
  const cells = [
    ['Enrollee', r.patient_name || 'Unnamed', false],
    ['Insurance no.', r.patient_id, true],
    ['Plan', r.plan, false],
    ['Diagnosis', r.diagnosis, true],
    ['Requested item', r.item_description, false],
    ['Requested value', fmtNGNfull(r.requested_amount), true],
    ['Line items', String(r.line_item_count || (r.items ? r.items.length : 0)), true],
    ['Encounter', r.checkin_type, false],
    ['Facility', r.facility, false],
    ['Provider', r.requesting_provider, false],
    ['Received', r.received_label, true],
    ['Decision latency', fmtSecs(r.processing_seconds), true],
  ];
  return (
    <div className="dgrid">
      {cells.map(([l, v, mono], i) => (
        <div className="cell" key={i}><div className="lab">{l}</div><div className={`val ${mono ? 'mono' : ''}`}>{v}</div></div>
      ))}
    </div>
  );
}
function LineItems({ r }) {
  if (!r.items || !r.items.length) return null;
  return (
    <div>
      <div className="sec-h">Requested items <span className="n">{r.items.length}</span></div>
      <div className="dgrid" style={{ gridTemplateColumns: '1fr 70px 130px' }}>
        {r.items.map((it, i) => (
          <React.Fragment key={i}>
            <div className="cell"><div className="val">{it.name}</div></div>
            <div className="cell"><div className="val mono">×{it.qty}</div></div>
            <div className="cell" style={{ textAlign: 'right' }}><div className="val mono">{fmtNGNfull(it.unit * it.qty)}</div></div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
function AgentTimeline({ r }) {
  if (!r.stages || !r.stages.length) {
    return (
      <div className="muted" style={{ fontFamily: 'var(--mono)', fontSize: '12.5px', padding: '14px 0' }}>
        Pipeline has not started for this request{r.status === 'received' ? ' — awaiting auto-decision.' : '.'}
      </div>
    );
  }
  return (
    <div className="timeline">
      {r.stages.map((s, i) => {
        const cls = s.status === 'processing' ? 'skip' : s.status;
        const node = s.status === 'pass' ? '✓' : s.status === 'fail' ? '✕' : s.n;
        const statTxt = s.status === 'processing' ? 'running' : s.status;
        return (
          <div className={`stage ${cls}`} key={i}>
            <div className="node">{node}</div>
            <div className="s-top">
              <span className="s-name">{s.n}. {s.name}</span>
              <span className="s-stat">{statTxt}</span>
              {s.time ? <span className="s-time">{s.time}</span> : null}
            </div>
            <p className="s-sum">{STAGE_Q[s.name] || ''}</p>
            {s.result ? (
              <div className="s-raw">
                <details><summary>Stage result JSON</summary><CodeBlock data={s.result} /></details>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
function DetailView({ r }) {
  if (!r) {
    return (
      <div className="stub-empty" style={{ paddingTop: 120 }}>
        <div className="ph">▤</div>
        <h4>Select a request</h4>
        <p>Choose a request from the queue to see its decision, the full 4-agent reasoning timeline, and the raw payload.</p>
      </div>
    );
  }
  return (
    <div className="detail">
      <div className="dhead">
        <div>
          <div className="dref">{r.display_request_id}</div>
          <h2 className="dname">{r.patient_name || 'Unnamed enrollee'}</h2>
        </div>
        <div style={{ display: 'flex', gap: 8 }} data-admin-only="">
          <button className="btn sm">Override</button>
          <button className="btn sm">Reassign</button>
        </div>
      </div>
      <DecisionBlock r={r} />
      <div><div className="sec-h">Request details</div><DetailsGrid r={r} /></div>
      <LineItems r={r} />
      <div>
        <div className="sec-h">Agent reasoning timeline <span className="n">{r.stages ? r.stages.length : 0} / 4 stages</span></div>
        <AgentTimeline r={r} />
      </div>
      <div>
        <div className="sec-h">Raw / extracted payload</div>
        <details>
          <summary style={{ fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--ink-3)', cursor: 'pointer' }}>View extracted_fields + raw_payload</summary>
          <CodeBlock data={r.raw_payload || r.extracted_fields} style={{ marginTop: 10 }} />
        </details>
      </div>
    </div>
  );
}

/* ============================================================
   Chrome: status bar, sidebar, ask bar
   ============================================================ */
function StatusBar({ session, role, onRole, refreshedLabel }) {
  const org = session.org_name || 'Organization';
  const short = org.split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="statusbar">
      <div className="sb-org"><span className="org-dot">{short}</span><b>{org}</b><span className="scope">org-scoped</span></div>
      <div className="sb-refresh"><span className="spin" /> {refreshedLabel}</div>
      <div className="sb-right">
        <span className="roleswitch">
          <button className={role === 'admin' ? 'on' : ''} onClick={() => onRole('admin')}>Admin</button>
          <button className={role === 'member' ? 'on' : ''} onClick={() => onRole('member')}>Member</button>
        </span>
        <span className="live-toggle"><span className="led" /> Live</span>
      </div>
    </div>
  );
}

const NAV = [
  { id: 'intake', label: 'Pre-Auth Intake', live: true },
  { id: 'health', label: 'Integration Health', live: false },
  { id: 'audit', label: 'Audit Trail', live: false },
  { id: 'eligibility', label: 'Eligibility Checks', live: false },
  { id: 'support', label: 'Support', live: false },
];
const NAV_ADMIN = [
  { id: 'team', label: 'Team', live: false, lock: true },
  { id: 'apikey', label: 'API Key', live: false, lock: true },
];
function Sidebar({ active, onNav, session, intakeCount }) {
  const initials = (session.name || '?').split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  const item = (n) => (
    <a
      key={n.id}
      className={`navitem ${n.lock ? 'lock' : ''} ${n.id === active ? 'active' : ''} ${n.live ? '' : 'soon'}`}
      href="#"
      onClick={(e) => { e.preventDefault(); onNav(n.id); }}
    >
      <span className="gl" />{n.label}
      {!n.live ? <span className="soon-tag">SOON</span> : (n.id === 'intake' ? <span className="ct">{intakeCount}</span> : null)}
    </a>
  );
  return (
    <aside className="side">
      <div className="idx-label">Index</div>
      {NAV.map(item)}
      <div className="nav-group" data-admin-only="">
        <div className="grp">Admin</div>
        {NAV_ADMIN.map(item)}
      </div>
      <div className="side-foot">
        <div className="row">
          <span className="ava">{initials}</span>
          <span className="who">{session.name}<small>{(session.role || 'member').toUpperCase()} · {session.org_name}</small></span>
        </div>
      </div>
    </aside>
  );
}

function AskBar({ context }) {
  const [q, setQ] = useState('');
  return (
    <div className="askbar-wrap">
      <form className="askbar" autoComplete="off" onSubmit={(e) => e.preventDefault()}>
        <div className="suggests">
          <button type="button" onClick={() => setQ('How many escalations today and why?')}>How many escalations today and why?</button>
          <button type="button" onClick={() => setQ('Summarize denied requests')}>Summarize denied requests</button>
          <button type="button" onClick={() => setQ('Average decision latency?')}>Average decision latency?</button>
        </div>
        <div className="ask-input">
          <span className="caret">▌</span>
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Ask me about ${context}…`} />
          <span className="face">🫥</span>
          <button className="ask-send" type="submit">Ask</button>
        </div>
      </form>
    </div>
  );
}

/* ============================================================
   Stub module views (IA placeholders — not yet wired to data)
   ============================================================ */
function KpiTile({ label, val, sub }) {
  return (
    <div className="kpi">
      <div className="k-label">{label}</div>
      <div className="k-val tnum">{val}</div>
      {sub ? <div className="k-sub">{sub}</div> : null}
    </div>
  );
}
function StubChannel({ title, sub, cols, note }) {
  return (
    <>
      <div className="stub-head"><h1 className="page-title">{title}</h1><span className="stub-badge">Module preview</span></div>
      <p className="page-sub">{sub}</p>
      <div className="stub-table">
        <div className="sth" style={{ gridTemplateColumns: `repeat(${cols.length},1fr)` }}>
          {cols.map((c) => <span key={c}>{c}</span>)}
        </div>
        <div className="stub-empty"><div className="ph">▦</div><h4>No items yet</h4><p>{note}</p></div>
      </div>
    </>
  );
}
function StubView({ id, session }) {
  const org = session.org_name || 'your organization';
  if (id === 'health') {
    return (
      <>
        <div className="stub-head"><h1 className="page-title">Integration Health</h1><span className="stub-badge">Not yet wired</span></div>
        <p className="page-sub">Inbound webhook deliveries from <b>{org}</b> · connect to <span className="muted">/auth/webhook-delivery-logs</span></p>
        <div className="stub-table"><div className="stub-empty"><div className="ph">◴</div><h4>Delivery health view</h4>
          <p>The backend already exposes delivery summary + per-attempt logs (auth, payload validity, duplicates, latency). This view will surface them.</p></div></div>
      </>
    );
  }
  if (id === 'audit') {
    return (
      <>
        <div className="stub-head"><h1 className="page-title">Audit Trail</h1><span className="stub-badge">Not yet wired</span></div>
        <p className="page-sub">Trace one event end-to-end: <span className="muted">delivery → stored request → agent decision</span></p>
        <div className="stub-table"><div className="stub-empty"><div className="ph">⛓</div><h4>End-to-end trace</h4>
          <p>Backed by /auth/webhook-audit-trail — search an event_id, checkin_id, or request_id to follow it across the pipeline.</p></div></div>
      </>
    );
  }
  if (id === 'team') {
    return (
      <>
        <div className="stub-head"><h1 className="page-title">Team</h1><span className="stub-badge">Not yet wired</span></div>
        <p className="page-sub">Members & pending invites for <b>{org}</b></p>
        <div className="ro-banner section-gap" style={{ marginTop: 18 }}><span className="led" style={{ background: 'var(--recv)' }} /> Read-only view — member role cannot invite or remove teammates.</div>
        <div className="stub-table section-gap"><div className="stub-empty"><div className="ph">⊞</div><h4>Team management</h4>
          <p>Backed by /auth/team, /auth/invite-member, /auth/team-member — list members, invite by email, remove.</p></div></div>
      </>
    );
  }
  if (id === 'apikey') {
    return (
      <>
        <div className="stub-head"><h1 className="page-title">API Key</h1><span className="stub-badge">Not yet wired</span></div>
        <p className="page-sub">Credential the HMO uses to authenticate webhook deliveries · <b>{org}</b></p>
        <div className="ro-banner section-gap" style={{ marginTop: 18 }}><span className="led" style={{ background: 'var(--recv)' }} /> Read-only view — only admins can generate or revoke keys.</div>
        <div className="stub-table section-gap"><div className="stub-empty"><div className="ph">🔑</div><h4>API key management</h4>
          <p>Backed by /auth/api-key (generate / show-once / revoke). Used to onboard the client's webhook integration.</p></div></div>
      </>
    );
  }
  if (id === 'eligibility') {
    return <StubChannel title="Eligibility Checks" sub="Provider eligibility requests arriving via Email & WhatsApp" cols={['Source', 'Provider', 'Enrollee ID', 'Plan', 'Status', 'Received']} note="Eligibility intake is being wired up. Channel connectors (Email, WhatsApp) will land here as a live operational queue." />;
  }
  if (id === 'support') {
    return <StubChannel title="Support" sub="Support conversations across Email, WhatsApp & Calls" cols={['Channel', 'Requester', 'Intent', 'Assigned to', 'Status', 'Last activity']} note="Support intake is being wired up. Conversations across channels will be triaged and assigned here." />;
  }
  return null;
}

/* ============================================================
   Icons (inline, matching the prototype)
   ============================================================ */
const IconSearch = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--ink-3)' }}>
    <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
  </svg>
);
const IconCal = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" />
  </svg>
);
const IconCopy = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
  </svg>
);

/* ============================================================
   Login
   ============================================================ */
function Login({ email, setEmail, password, setPassword, onSubmit, error, loading }) {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-2)', padding: 24 }}>
      <form
        onSubmit={onSubmit}
        style={{
          width: 'min(380px, 100%)', background: 'var(--bg)', border: '1px solid var(--line)',
          borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-card)', padding: '34px 30px', display: 'flex',
          flexDirection: 'column', gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ width: 36, height: 36, borderRadius: 9, background: 'linear-gradient(135deg, var(--indigo), #8b6cf0)', color: '#fff', display: 'grid', placeItems: 'center', fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13 }}>SL</span>
          <div>
            <p className="eyebrow" style={{ margin: 0 }}>Saaspro Labs</p>
            <h1 style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 500, margin: '2px 0 0' }}>Pre-Auth Operations</h1>
          </div>
        </div>
        <label style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          Email
          <div className="search"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" autoComplete="email" required /></div>
        </label>
        <label style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          Password
          <div className="search"><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter password" autoComplete="current-password" required /></div>
        </label>
        {error ? <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--bad-ink)', background: 'var(--bad-bg)', border: '1px solid var(--bad-line)', borderRadius: 8, padding: '8px 12px' }}>{error}</div> : null}
        <button className="btn indigo" type="submit" disabled={loading} style={{ justifyContent: 'center' }}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
        <span className="eyebrow" style={{ textAlign: 'center' }}>Backend: {API_BASE_URL}</span>
      </form>
    </main>
  );
}

/* ============================================================
   App
   ============================================================ */
export default function App() {
  const [session, setSession] = useState(() => {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? JSON.parse(s) : null;
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [activeNav, setActiveNav] = useState('intake');
  const [role, setRole] = useState('admin');
  const [lastLoaded, setLastLoaded] = useState(null);

  useEffect(() => { document.body.dataset.layout = 'split'; return () => { delete document.body.dataset.layout; }; }, []);
  useEffect(() => { document.body.classList.toggle('role-member', role === 'member'); }, [role]);
  useEffect(() => { if (session) setRole(session.role || 'admin'); }, [session]);

  async function apiRequest(path, options = {}) {
    const headers = {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(options.headers || {}),
    };
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const detail = data?.detail || data?.message || response.statusText;
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return data;
  }

  async function handleLogin(event) {
    event.preventDefault();
    setLoginError('');
    setLoginLoading(true);
    try {
      const data = await apiRequest('/auth/login', { method: 'POST', body: { email, password } });
      const next = { token: data.token, role: data.role, name: data.name, org_name: data.org_name };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setSession(next);
      setRole(next.role || 'admin');
      setEmail('');
      setPassword('');
    } catch (err) {
      setLoginError(err.message || 'Login failed');
    } finally {
      setLoginLoading(false);
    }
  }

  async function loadDashboard({ silent = false } = {}) {
    if (!session?.token) return;
    if (!silent) setLoading(true);
    setError('');
    try {
      const data = await apiRequest('/auth/preauth-dashboard');
      setDashboard(data);
      setLastLoaded(Date.now());
    } catch (err) {
      if (/token expired/i.test(err.message || '')) {
        signOut();
        setLoginError('Session expired. Please sign in again.');
        return;
      }
      setError(err.message || 'Could not load dashboard');
    } finally {
      if (!silent) setLoading(false);
    }
  }

  function signOut() {
    localStorage.removeItem(STORAGE_KEY);
    setSession(null);
    setDashboard(null);
    setSelectedId('');
  }

  useEffect(() => { if (session?.token) loadDashboard(); /* eslint-disable-next-line */ }, [session?.token]);
  useEffect(() => {
    if (!session?.token) return undefined;
    const t = setInterval(() => loadDashboard({ silent: true }), 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [session?.token]);

  const rawRequests = dashboard?.requests || [];
  const summary = dashboard?.summary || {};
  const requests = useMemo(() => rawRequests.map(mapRequest), [rawRequests]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return requests.filter((r) => {
      const okS = statusFilter === 'all' || r.status === statusFilter;
      const blob = [r.display_request_id, r.patient_name, r.patient_id, r.plan, r.item_description, r.facility, r.requesting_provider, r.decision]
        .filter(Boolean).join(' ').toLowerCase();
      return okS && (!q || blob.includes(q));
    });
  }, [requests, query, statusFilter]);

  const selected = requests.find((r) => r.request_id === selectedId) || filtered[0] || null;

  useEffect(() => {
    if (filtered.length && !filtered.some((r) => r.request_id === selectedId)) {
      setSelectedId(filtered[0].request_id);
    }
  }, [filtered, selectedId]);

  if (!session) {
    return <Login email={email} setEmail={setEmail} password={password} setPassword={setPassword} onSubmit={handleLogin} error={loginError} loading={loginLoading} />;
  }

  const refreshedLabel = loading ? 'Refreshing…' : (lastLoaded ? `Refreshed ${timeAgo(new Date(lastLoaded).toISOString())}` : 'Connecting…');
  const statusFilters = ['all', 'approve', 'deny', 'escalate', 'processing', 'pending', 'received'];

  return (
    <div className="app">
      <StatusBar session={session} role={role} onRole={setRole} refreshedLabel={refreshedLabel} />
      <Sidebar active={activeNav} onNav={setActiveNav} session={session} intakeCount={summary.received_24h ?? 0} />

      <main className="main">
        {activeNav === 'intake' ? (
          <section id="view-intake" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
            <div className="split-top">
              <div className="ro-banner" style={{ marginBottom: 16 }}>
                <span className="led" style={{ background: 'var(--recv)' }} /> Read-only view — you're signed in as a member. Operational data is visible; actions are disabled.
              </div>
              <div className="page-head">
                <div>
                  <h1 className="page-title" style={{ fontSize: 26 }}>Pre-Authorization</h1>
                  <p className="page-sub" style={{ marginTop: 6 }}>
                    <span className="cal" aria-hidden="true"><IconCal /></span>
                    Live · {requests.length} recent requests
                    {loading ? <span className="muted"> · loading…</span> : null}
                  </p>
                </div>
                <div className="page-actions">
                  <button className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => loadDashboard()}><IconCopy /></button>
                  <button className="btn primary" data-admin-only="">Export report</button>
                </div>
              </div>

              <div className="kpi-strip" style={{ marginTop: 20 }}>
                <KpiTile label="Received 24h" val={(summary.received_24h ?? 0).toLocaleString()} sub={`${(summary.total ?? 0).toLocaleString()} total this period`} />
                <KpiTile label="Approved" val={(summary.approved ?? 0).toLocaleString()} sub={<><b>{summary.total ? Math.round((summary.approved / summary.total) * 100) : 0}%</b> of decisions</>} />
                <KpiTile label="Denied / Escalated" val={`${summary.denied ?? 0} / ${summary.escalated ?? 0}`} sub={`${summary.pending ?? 0} pending · ${summary.errors ?? 0} errors`} />
                <KpiTile label="Approved value" val={fmtNGN(summary.total_amount_approved ?? 0)} sub="NGN authorized" />
                <KpiTile label="Avg latency" val={(summary.avg_processing_seconds != null ? Number(summary.avg_processing_seconds).toFixed(1) : '—') + 's'} sub="vs ~30 min manual" />
              </div>

              <div className="toolbar" style={{ marginTop: 18 }}>
                <div className="search">
                  <IconSearch />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search reference, patient, provider, plan, item…" />
                </div>
                {statusFilters.map((s) => (
                  <button key={s} className={`statbtn ${statusFilter === s ? 'on' : ''}`} onClick={() => setStatusFilter(s)}>
                    {s === 'all' ? 'All' : (STATUS_META[s]?.label || s)}
                  </button>
                ))}
              </div>
            </div>

            <div className="splitwrap">
              <div className="split-list">
                <div className="sl-head"><span>Request queue</span><span>{filtered.length} request{filtered.length === 1 ? '' : 's'}</span></div>
                <div>
                  {filtered.map((r) => (
                    <QueueItem key={r.request_id} r={r} selected={selected?.request_id === r.request_id} onSelect={setSelectedId} />
                  ))}
                  {!filtered.length && (
                    <div className="stub-empty" style={{ padding: '60px 24px' }}>
                      <div className="ph">▤</div><h4>No requests</h4>
                      <p>{error ? error : 'Incoming webhook requests will appear here after processing.'}</p>
                    </div>
                  )}
                </div>
              </div>
              <div className="split-detail" id="detail-pane">
                <DetailView r={selected} />
              </div>
            </div>
          </section>
        ) : (
          <section id="view-stub" style={{ padding: '30px 40px 120px', overflow: 'auto' }}>
            <StubView id={activeNav} session={session} />
          </section>
        )}
      </main>

      <AskBar context={activeNav === 'intake' ? 'this request' : 'this view'} />
    </div>
  );
}
