/* ============================================================
   Agent vs AMAN Accuracy view (SAA-52)

   Mirrors the SAAS Pro design bundle (Accuracy Dashboard.html +
   app/accuracy.js + app/accuracy-data.js). Consumes a single
   backend endpoint, GET /auth/qa/accuracy, which returns:

     { window, params, aggregates: { all, advisory, applied }, records }

   Three exports:
     - AccuracyView          : the full page (heroes + value/lat + mismatch + table)
     - AccuracyDetailDrawer  : drawer body rendering agent-vs-AMAN side-by-side
     - WeeklyQaReportSheet   : print portal for the Weekly QA Report PDF

   The portal pattern is identical to src/report.jsx — hidden on
   screen via display:none, revealed inside @media print rules in
   App.css. Everything else on the page is hidden during print.
   ============================================================ */
import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

/* ---------- domain metadata ---------- */
export const MISMATCH_META = {
  coverage:    { label: 'Coverage mismatch',    cls: 'deny',     blurb: 'Agent and AMAN disagreed on whether the item is covered.' },
  limits:      { label: 'Limits mismatch',      cls: 'deny',     blurb: 'Agent said within benefit/cap; AMAN said over (or vice-versa).' },
  amount:      { label: 'Amount mismatch',      cls: 'escalate', blurb: 'Both approved, but approved amounts differ beyond tolerance.' },
  aman_over:   { label: 'AMAN overruled',       cls: 'escalate', blurb: 'Agent denied; AMAN approved on final review.' },
  agent_over:  { label: 'Agent overruled',      cls: 'deny',     blurb: 'Agent approved; AMAN denied on final review.' },
  eligibility: { label: 'Eligibility mismatch', cls: 'deny',     blurb: 'Agent and AMAN disagreed on member eligibility.' },
};
export const BUCKET_META = {
  matched:       { label: 'Matched',       cls: 'approve', accent: 'var(--ok)',    blurb: 'Agent and AMAN reached the same decision; approved amounts within tolerance.' },
  mismatched:    { label: 'Mismatched',    cls: 'deny',    accent: 'var(--bad)',   blurb: 'Agent and AMAN disagree on decision or amount.' },
  pending_aman:  { label: 'Pending AMAN',  cls: 'escalate', accent: 'var(--warn)', blurb: "Agent has decided; AMAN hasn't finalized yet." },
  agent_skipped: { label: 'Agent skipped', cls: 'pending', accent: 'var(--slate)', blurb: "Agent didn't render a firm verdict — escalated, errored, or still running." },
};

/* ---------- formatters ---------- */
export function fmtNGN(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return '₦' + (v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 2) + 'm';
  if (v >= 1_000) return '₦' + Math.round(v / 1_000) + 'k';
  return '₦' + Math.round(v);
}
export function fmtNGNfull(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG');
}
export function fmtMins(m) {
  if (m == null) return '—';
  if (m < 1) return '<1m';
  if (m < 60) return Math.round(m) + 'm';
  let h = Math.floor(m / 60);
  let r = Math.round(m % 60);
  // Carry: rounding 59.6 minutes lands on r=60, which should become +1h.
  if (r >= 60) { h += 1; r = 0; }
  return r ? `${h}h ${r}m` : `${h}h`;
}
export function fmtLat(s) {
  if (s == null) return '—';
  return s < 60 ? s.toFixed(1) + 's' : (s / 60).toFixed(1) + 'm';
}
function ago(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!t) return '—';
  const mins = Math.max(0, (Date.now() - t) / 60_000);
  if (mins < 1) return '<1m ago';
  if (mins < 60) return Math.round(mins) + 'm ago';
  if (mins < 60 * 24) return Math.round(mins / 60) + 'h ago';
  return Math.round(mins / (60 * 24)) + 'd ago';
}
function submittedAt(row) {
  return row?.submitted_at || row?.received_at;
}

const DEC_TO_STATUS = { APPROVE: 'approve', DENY: 'deny', ESCALATE: 'escalate' };
function decPill(dec) {
  if (!dec) return <span className="pill pending"><span className="dot" />Pending</span>;
  const s = DEC_TO_STATUS[dec] || 'pending';
  return <span className={`pill ${s}`}><span className="dot" />{dec[0] + dec.slice(1).toLowerCase()}</span>;
}
function catBadge(cat) {
  if (!cat) return null;
  const m = MISMATCH_META[cat];
  if (!m) return null;
  return <span className={`cat-badge ${m.cls}`}>{m.label}</span>;
}

const IconSearch = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--ink-3)' }}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
);
const IconCal = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>
);

function speedFactor(latency) {
  if (!latency?.aman_min || !latency?.agent_s) return null;
  return Math.round((latency.aman_min * 60) / latency.agent_s);
}

/* ============================================================
   Page sections — pure renderers off `data` (the endpoint payload)
   ============================================================ */
function HeroStrip({ A, tolerance }) {
  const cards = [
    { key: 'matched', count: A.matched, scored: true },
    { key: 'mismatched', count: A.mismatched, scored: true },
    { key: 'pending_aman', count: A.pending_aman, scored: false },
    { key: 'agent_skipped', count: A.agent_skipped, scored: false },
  ];
  return (
    <div className="acc-heroes">
      {cards.map(({ key, count, scored }) => {
        const m = BUCKET_META[key];
        const denom = scored ? A.scored : A.total;
        const pct = denom ? (count / denom * 100).toFixed(1) : '0.0';
        let subsub = null;
        if (key === 'matched') subsub = <div className="subsub"><span>decision <b>{A.decision_match}</b></span><span>amount ±{Math.round(tolerance * 100)}% <b>{A.amount_match}</b></span></div>;
        else if (key === 'mismatched') subsub = <div className="subsub"><span>across <b>{(A.categories || []).filter((c) => c.v > 0).length}</b> categories</span></div>;
        else if (key === 'pending_aman') subsub = <div className="subsub"><span>awaiting AMAN writeback</span></div>;
        else subsub = <div className="subsub"><span>escalated · errored · running</span></div>;
        return (
          <div key={key} className="acc-hero" data-tip={m.blurb}>
            <div className="lab"><span className="bdot" style={{ background: m.accent }} />{m.label}<span className="q">?</span></div>
            <div className="num tnum">{count}</div>
            <div className="sub">{pct}% of <b>{denom}</b> {scored ? 'scored' : 'total'}</div>
            {subsub}
          </div>
        );
      })}
    </div>
  );
}

function ValueCard({ A }) {
  const v = A.value || {};
  const max = Math.max(v.requested || 0, 1);
  const rows = [
    ['Requested by HMO', v.requested, 'var(--ink-4)'],
    ['Agent-approved', v.agent_approved, 'var(--indigo)'],
    ['AMAN-approved', v.aman_approved, 'var(--ok)'],
    ['Rejected (final)', v.rejected, 'var(--bad)'],
  ];
  const delta = (v.aman_approved || 0) - (v.agent_approved || 0);
  const deltaCls = delta >= 0 ? 'pos' : 'neg';
  const deltaSign = delta >= 0 ? '+' : '−';
  return (
    <div className="metric">
      <h3>Value flow</h3>
      <p className="desc">Authorized value through the pipeline (₦) — agent vs AMAN final</p>
      <div className="vflow">
        {rows.map(([l, amt, c]) => (
          <div key={l} className="vrow">
            <span className="vlab">{l}</span>
            <span className="vbar"><span style={{ width: `${((amt || 0) / max * 100).toFixed(1)}%`, background: c }} /></span>
            <span className="vamt">{fmtNGNfull(amt || 0)}</span>
          </div>
        ))}
        <div className="vrow delta">
          <span className="vlab">AMAN − Agent Δ</span>
          <span className="vbar"><span style={{ width: `${Math.min(100, Math.abs(delta) / max * 100).toFixed(1)}%`, background: delta >= 0 ? 'var(--ok)' : 'var(--bad)' }} /></span>
          <span className={`vamt ${deltaCls}`}>{deltaSign}{fmtNGNfull(Math.abs(delta))}</span>
        </div>
      </div>
      {v.overturned_denials > 0 ? (
        <div className="vcatch"><span className="sp">✦</span><div><b>{fmtNGN(v.overturned_denials)}</b> in agent denials that AMAN later overturned — value the agent flagged for a second look before payout.</div></div>
      ) : null}
    </div>
  );
}

function LatencyCard({ A }) {
  const L = A.latency || {};
  const agentMin = (L.agent_s || 0) / 60;
  const totalMin = agentMin + (L.aman_min || 0);
  const maxMin = Math.max(totalMin, 1);
  const factor = speedFactor(L);
  const rows = [
    { lab: 'Agent decision', num: fmtLat(L.agent_s), c: 'var(--ok)', mins: agentMin, p: `p50 ${fmtLat(L.agent_p50)} · p95 ${fmtLat(L.agent_p95)}` },
    { lab: 'AMAN review',    num: fmtMins(L.aman_min), c: 'var(--warn)', mins: L.aman_min || 0, p: `p50 ${fmtMins(L.aman_p50)} · p95 ${fmtMins(L.aman_p95)}` },
    { lab: 'Total end-to-end', num: fmtMins(totalMin), c: 'var(--slate)', mins: totalMin, p: 'submitted → AMAN final' },
  ];
  return (
    <div className="metric">
      <h3>Time to decision <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-4)', fontWeight: 400 }}>· agent vs AMAN</span></h3>
      <p className="desc">How long each side takes to reach a verdict</p>
      <div className="lat-rows">
        {rows.map((r) => (
          <div key={r.lab} className="lat-row">
            <div className="lr-top">
              <span className="lr-lab"><span className="swatch" style={{ background: r.c }} />{r.lab}</span>
              <span className="lr-num">{r.num}</span>
            </div>
            <div className="lr-scale"><span style={{ width: `${Math.max(2, (r.mins || 0) / maxMin * 100).toFixed(2)}%`, background: r.c }} /></div>
            <div className="lr-pct">{r.p}</div>
          </div>
        ))}
      </div>
      {factor ? (
        <div className="lat-tag">The agent reaches a verdict on average <b>{factor.toLocaleString()}×</b> faster than AMAN's manual review.</div>
      ) : (
        <div className="lat-tag" style={{ fontStyle: 'normal' }}>AMAN review timing will appear once AMAN starts writing back finals.</div>
      )}
    </div>
  );
}

function MismatchCard({ A, activeCategory, onPickCategory }) {
  const cats = (A.categories || []).filter((c) => c.v > 0).slice().sort((a, b) => b.v - a.v);
  const total = cats.reduce((s, c) => s + c.v, 0) || 1;
  const max = Math.max(...cats.map((c) => c.v), 1);
  const shades = ['#c0362c', '#cf4a40', '#d65f56', '#dd766e', '#e48d86', '#eca49f'];
  return (
    <div className="metric">
      <h3>Where we disagree</h3>
      <p className="desc">Mismatched PAs by category — what drove the disagreement</p>
      <div className="mm-bars">
        {cats.length ? cats.map((c, i) => {
          const m = MISMATCH_META[c.key] || { label: c.key, cls: 'deny', blurb: '' };
          const w = Math.max(8, c.v / max * 100);
          const shade = shades[Math.min(i, shades.length - 1)];
          return (
            <div
              key={c.key}
              className={`mm-row ${activeCategory === c.key ? 'active' : ''}`}
              onClick={() => onPickCategory(c.key)}
              data-tip={m.blurb}
            >
              <span className="mm-lab">{m.label}</span>
              <span className="mm-track"><span style={{ width: `${w.toFixed(1)}%`, background: shade }}>{c.v}</span></span>
              <span className="mm-pct">{Math.round(c.v / total * 100)}%</span>
            </div>
          );
        }) : (
          <p className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 12.5, padding: '6px 0' }}>
            No mismatches in this mode — every scored PA agreed with AMAN.
          </p>
        )}
      </div>
      {cats.length ? (
        <div className="mm-foot"><span className="sp">✦</span>
          <div><b>{MISMATCH_META[cats[0].key]?.label || cats[0].key}</b> leads with {cats[0].v} of {total} mismatches ({Math.round(cats[0].v / total * 100)}%). {MISMATCH_META[cats[0].key]?.blurb} Click any bar to filter the table below.</div>
        </div>
      ) : null}
    </div>
  );
}

function recordsForMode(records, mode) {
  if (mode === 'all') return records;
  return records.filter((r) => (r.callback_mode || 'advisory') === mode);
}

function refTail(s) {
  if (!s) return '—';
  const parts = String(s).split('/');
  return parts[parts.length - 1] || s;
}

function lineDecisionFromItem(item, parent) {
  const agent = item?.agent_decision || null;
  const status = String(item?.aman_status || '').toLowerCase();
  const aman =
    status === 'approved' ? 'APPROVE' :
    status === 'rejected' ? 'DENY' :
    status === 'queried' ? 'ESCALATE' :
    null;

  if (!agent && !aman) {
    return { bucket: 'pending_aman', category: null };
  }
  if (!agent) {
    return { bucket: 'agent_skipped', category: null };
  }
  if (!aman) {
    return { bucket: 'pending_aman', category: null };
  }
  if (agent !== aman) {
    return {
      bucket: 'mismatched',
      category: agent === 'DENY' && aman === 'APPROVE'
        ? 'aman_over'
        : agent === 'APPROVE' && aman === 'DENY'
          ? 'agent_over'
          : parent?.mismatch_category || 'coverage',
    };
  }
  if (agent === 'APPROVE') {
    const agentAmount = Number(item?.agent_recommended_cost || 0);
    const amanAmount = Number(item?.aman_approved_cost || 0);
    const base = Math.max(Math.abs(agentAmount), Math.abs(amanAmount), 1);
    if (Math.abs(agentAmount - amanAmount) / base > 0.05) {
      return { bucket: 'mismatched', category: 'amount' };
    }
  }
  return { bucket: 'matched', category: null };
}

function rowsFromRecords(records) {
  return records.flatMap((r) => {
    const items = Array.isArray(r.items_compare) && r.items_compare.length
      ? r.items_compare
      : [{
          name: r.item_description || '—',
          agent_decision: r.agent_decision,
          aman_status: r.aman_decision === 'APPROVE' ? 'approved' : r.aman_decision === 'DENY' ? 'rejected' : r.aman_decision === 'ESCALATE' ? 'queried' : null,
          agent_recommended_cost: r.agent_amount,
          aman_approved_cost: r.aman_amount,
        }];

    return items.map((item, index) => {
      const line = lineDecisionFromItem(item, r);
      return {
        ...r,
        line_key: `${r.request_id || 'pa'}-${item.claim_item_id || index}`,
        line_index: index + 1,
        line_count: items.length,
        line_item: item,
        line_bucket: line.bucket,
        line_mismatch_category: line.category,
      };
    });
  });
}

function DrilldownTable({ records, A, state, setState, onRowOpen, tolerance }) {
  const PER_PAGE = 14;
  const all = useMemo(() => {
    let recs = recordsForMode(records, state.mode);
    let rows = rowsFromRecords(recs);
    if (state.outcome === 'matched') rows = rows.filter((r) => r.line_bucket === 'matched');
    if (state.outcome === 'mismatched') rows = rows.filter((r) => r.line_bucket === 'mismatched' || r.bucket === 'mismatched');
    if (state.outcome === 'approved') rows = rows.filter((r) => (r.line_item || {}).aman_status === 'approved');
    if (state.outcome === 'rejected') rows = rows.filter((r) => (r.line_item || {}).aman_status === 'rejected');
    if (state.outcome === 'pending') rows = rows.filter((r) => !(r.line_item || {}).aman_status || r.line_bucket === 'pending_aman');
    if (state.onlyMismatch) rows = rows.filter((r) => r.line_bucket === 'mismatched' || r.bucket === 'mismatched');
    if (state.category) rows = rows.filter((r) => r.line_mismatch_category === state.category || r.mismatch_category === state.category);
    if (state.plan !== 'all') {
      const p = state.plan.toLowerCase();
      rows = rows.filter((r) => (r.plan || '').toLowerCase().includes(p));
    }
    if (state.search) {
      const q = state.search.toLowerCase();
      rows = rows.filter((r) => {
        const item = r.line_item || {};
        return `${r.display_request_id || ''} ${r.patient_name || ''} ${r.patient_id || ''} ${item.name || ''} ${r.plan || ''} ${item.claim_item_id || ''}`.toLowerCase().includes(q);
      });
    }
    return rows.slice().sort((a, b) => new Date(submittedAt(b) || 0).getTime() - new Date(submittedAt(a) || 0).getTime());
  }, [records, state.mode, state.outcome, state.onlyMismatch, state.category, state.plan, state.search]);

  if (!all.length) {
    return (
      <div className="acc-table">
        <div className="acc-thead">
          <span>Reference</span><span>Patient</span><span>Service / procedure</span>
          <span>Agent → AMAN</span><span>Category</span><span>Latency</span><span className="r">Submitted</span>
        </div>
        <div className="acc-empty">
          <div className="ph">✓</div>
          <h4>{state.onlyMismatch ? 'No line-item mismatches to investigate' : 'No line items match these filters'}</h4>
          <p>{state.onlyMismatch || state.outcome === 'mismatched' ? 'Every visible line item in this view agreed with AMAN. Switch back to All lines, or widen the date range.' : 'Try clearing the search or filter.'}</p>
        </div>
      </div>
    );
  }

  const pages = Math.ceil(all.length / PER_PAGE);
  const page = Math.min(Math.max(1, state.page), Math.max(1, pages));
  const slice = all.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  return (
    <div className="acc-table">
      <div className="acc-thead">
        <span>Reference</span><span>Patient</span><span>Service / procedure</span>
        <span>Agent → AMAN</span><span>Category</span><span>Latency</span><span className="r">Submitted</span>
      </div>
      {slice.map((r) => {
        const agentLat = r.agent_decision ? fmtLat(r.agent_latency_s) : '—';
        const amanLat = r.aman_review_min != null ? fmtMins(r.aman_review_min) : 'pending';
        const item = r.line_item || {};
        const category = r.line_mismatch_category;
        return (
          <div key={r.line_key} className="acc-trow" onClick={() => onRowOpen(r)}>
            <div className="ref">{refTail(r.display_request_id)}<small>{r.plan || '—'} · line {r.line_index}/{r.line_count}</small></div>
            <div className="pt">{r.patient_name || <span className="muted">Unnamed</span>}<small>{r.patient_id}</small></div>
            <div className="item" title={item.name || ''}>
              <span className="item-name">{item.name || '—'}</span>
              {item.claim_item_id ? <small>claim #{item.claim_item_id}</small> : null}
            </div>
            <div className="vs">{decPill(item.agent_decision)}<span className="arrow">→</span>{decPill(
              item.aman_status === 'approved' ? 'APPROVE' :
              item.aman_status === 'rejected' ? 'DENY' :
              item.aman_status === 'queried' ? 'ESCALATE' :
              null
            )}</div>
            <div>
              {category
                ? catBadge(category)
                : <span className="bucket-badge">{BUCKET_META[r.line_bucket]?.label || r.line_bucket}</span>}
            </div>
            <div className="lat"><b>agent</b> {agentLat}<br /><b>AMAN</b> {amanLat}</div>
            <div className="when">{ago(submittedAt(r))}</div>
          </div>
        );
      })}
      <div className="acc-tfoot">
        <span>{all.length} line item{all.length === 1 ? '' : 's'}{state.outcome !== 'all' ? ` · ${state.outcome}` : ''}{state.onlyMismatch ? ' with mismatch' : ''}{state.category ? ` · ${MISMATCH_META[state.category]?.label || state.category}` : ''}</span>
        {pages > 1 ? (
          <div className="pager">
            {Array.from({ length: pages }, (_, i) => (
              <button key={i} className={i + 1 === page ? 'on' : ''} onClick={() => setState({ ...state, page: i + 1 })}>{i + 1}</button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ============================================================
   Date range toolbar — quick presets (Today / 7d / 30d / This month)
   + from/to inputs. Emits ISO yyyy-mm-dd strings.
   ============================================================ */
function pad2(n) { return String(n).padStart(2, '0'); }
function isoDay(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function todayIso() { return isoDay(new Date()); }
function daysAgoIso(n) { const d = new Date(); d.setDate(d.getDate() - n); return isoDay(d); }
function startOfMonthIso() { const d = new Date(); d.setDate(1); return isoDay(d); }

function DateRangeBar({ from, to, onChange, presetLabel }) {
  const [open, setOpen] = useState(false);
  const presets = [
    { key: 'today', label: 'Today', from: todayIso(), to: todayIso() },
    { key: '7d',    label: 'Last 7 days', from: daysAgoIso(6), to: todayIso() },
    { key: '30d',   label: 'Last 30 days', from: daysAgoIso(29), to: todayIso() },
    { key: 'mtd',   label: 'This month', from: startOfMonthIso(), to: todayIso() },
    { key: 'all',   label: 'All time', from: '', to: '' },
  ];
  const active = (() => {
    if (!from && !to) return '7d';
    return presets.find((p) => p.from === from && p.to === to)?.key || 'custom';
  })();
  const label = presets.find((p) => p.key === active)?.label || `${from || 'start'} → ${to || 'today'}`;
  const applyRange = (nextFrom, nextTo, close = true) => {
    onChange(nextFrom, nextTo);
    if (close) setOpen(false);
  };

  return (
    <div className="date-range">
      <button
        type="button"
        className={`date-range-btn ${open ? 'on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-tip="Filter by PA submitted date."
        data-tip-pos="below"
      >
        <IconCal />
        <span>{label}</span>
        {presetLabel ? <i className="mini-spinner" aria-label="Loading filtered data" /> : null}
        <span className="chev" aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div className="date-popover">
          {presetLabel ? <div className="date-loading"><i className="mini-spinner" /> Updating range...</div> : null}
          <div className="range-presets">
            {presets.map((preset) => (
              <button key={preset.key} type="button" onClick={() => applyRange(preset.from, preset.to)}>
                <span>{preset.label}</span>
              </button>
            ))}
          </div>
          <div className="custom-range">
            <div className="custom-range-head">
              <span>✓</span>
              <b>Custom range</b>
            </div>
            <div className="custom-range-inputs">
              <input type="date" value={from || ''} onChange={(e) => applyRange(e.target.value || '', to || '', false)} />
              <input type="date" value={to || ''} onChange={(e) => applyRange(from || '', e.target.value || '', false)} />
            </div>
          </div>
        </div>
      ) : null}
      {(from || to) && !open ? (
        <button
          type="button"
          className="statbtn"
          onClick={() => applyRange('', '')}
          data-tip="Clears the window and falls back to the backend default."
          data-tip-pos="below"
          data-tip-align="right"
          style={{ marginLeft: 8 }}
        >Reset</button>
      ) : null}
    </div>
  );
}

/* ============================================================
   <AccuracyView> — the page
   ============================================================ */
export function AccuracyView({ data, loading, error, onRefresh, onOpenRow, onDownloadReport, isAdmin, period, dateFrom, dateTo, onDateChange }) {
  const [state, setState] = useState({
    mode: 'all',
    outcome: 'all',
    onlyMismatch: false,
    category: null,
    plan: 'all',
    search: '',
    page: 1,
  });

  const aggregates = data?.aggregates || {};
  const A = aggregates[state.mode] || { total: 0, scored: 0, matched: 0, mismatched: 0, pending_aman: 0, agent_skipped: 0, decision_match: 0, amount_match: 0, value: {}, latency: {}, categories: [] };
  const records = data?.records || [];
  const tolerance = data?.params?.tolerance ?? 0.05;
  const label = data?.window?.label || period || '—';

  return (
    <section id="view-accuracy">
      <div className="page-head">
        <div>
          <h1 className="page-title">Agent vs AMAN Accuracy</h1>
          <p className="page-sub">
            <span data-tip="Period — adjust via the date range below.">{label}</span>
            <span style={{ margin: '0 8px', opacity: 0.4 }}>·</span>
            <span><b>{A.total}</b> PAs · {A.scored} scored · {A.label || (state.mode === 'all' ? 'All modes' : state.mode === 'advisory' ? 'Advisory mode' : 'Applied mode')}</span>
          </p>
        </div>
        <div className="page-actions">
          <span className="acc-modeswitch">
            {['all', 'advisory', 'applied'].map((m) => (
              <button key={m} className={state.mode === m ? 'on' : ''} onClick={() => setState((s) => ({ ...s, mode: m, page: 1 }))}>
                {m === 'all' ? 'All' : m === 'advisory' ? 'Advisory' : 'Applied'}
              </button>
            ))}
          </span>
          <button className="icon-btn" title="Refresh" aria-label="Refresh" onClick={onRefresh}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v5h-5" /></svg>
          </button>
          {isAdmin ? (
            <button
              className="btn primary"
              onClick={() => onDownloadReport(state.mode)}
              data-tip="Open a print-friendly Weekly QA Report for the current mode and date range. Use the browser's Save as PDF."
              data-tip-pos="below"
              data-tip-align="right"
            >
              Download Weekly QA Report
              <svg style={{ marginLeft: 6 }} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" /></svg>
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="ro-banner" style={{ display: 'flex', marginTop: 18, background: 'var(--bad-bg)', borderColor: 'var(--bad-line)', color: 'var(--bad-ink)' }}>
          <span className="led" style={{ background: 'var(--bad)' }} /> {error}
        </div>
      ) : null}

      <div className="section-gap" style={{ marginTop: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
          <h2 style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 500, margin: 0 }}>Filter</h2>
          <span className="muted mono" style={{ fontSize: 12 }}>{A.total || 0} PA{A.total === 1 ? '' : 's'} · {A.scored || 0} scored</span>
        </div>
        <div className="toolbar" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
          <div className="search" style={{ minWidth: 240, flex: '1 1 240px' }}>
            <IconSearch />
            <input
              value={state.search}
              onChange={(e) => setState((s) => ({ ...s, search: e.target.value, page: 1 }))}
              placeholder="Search reference, patient, plan, service..."
              data-tip="Filters the current mode + filter set. Matches reference, patient name/ID, plan, service, and claim ID."
              data-tip-pos="below"
              data-tip-align="left"
            />
          </div>
          {onDateChange ? (
            <DateRangeBar
              from={dateFrom}
              to={dateTo}
              onChange={onDateChange}
              presetLabel={loading ? 'Loading...' : null}
            />
          ) : null}
          <span className="acc-modeswitch acc-outcome-filter" data-tip="Filter the line-item review table by AMAN outcome or mismatch status." data-tip-pos="below">
            {[
              ['all', 'All lines'],
              ['approved', 'Approved'],
              ['rejected', 'Rejected'],
              ['mismatched', 'Mismatch'],
              ['pending', 'Pending'],
            ].map(([key, name]) => (
              <button
                key={key}
                className={state.outcome === key ? 'on' : ''}
                onClick={() => setState((s) => ({
                  ...s,
                  outcome: key,
                  onlyMismatch: key === 'mismatched',
                  category: null,
                  page: 1,
                }))}
              >
                {name}
              </button>
            ))}
          </span>
        </div>
      </div>

      <div className="acc-sec" style={{ marginTop: 20 }}>
        <HeroStrip A={A} tolerance={tolerance} />
      </div>

      <div className="acc-sec">
        <div className="acc-sec-h">Value &amp; time <span className="hint">— correct-decision value, and time the agent saves</span></div>
        <div className="grid-2"><ValueCard A={A} /><LatencyCard A={A} /></div>
      </div>

      <div className="acc-sec">
        <div className="acc-sec-h">Mismatch breakdown <span className="hint">— is the disagreement systematic?</span></div>
        <MismatchCard
          A={A}
          activeCategory={state.category}
          onPickCategory={(cat) => setState((s) => {
            const nextCategory = s.category === cat ? null : cat;
            return { ...s, category: nextCategory, outcome: nextCategory ? 'mismatched' : s.outcome, onlyMismatch: !!nextCategory, page: 1 };
          })}
        />
      </div>

      <div className="section-gap" style={{ marginTop: 30 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
          <h2 style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 500, margin: 0 }}>Line-item review</h2>
          <span className="muted mono" style={{ fontSize: 12 }}>Click any row to compare decisions</span>
        </div>
        {loading && !data ? (
          <div className="acc-table">
            <div className="acc-empty"><div className="ph">…</div><h4>Loading accuracy data</h4><p>Crunching every PA in this window against AMAN's final decisions.</p></div>
          </div>
        ) : (
          <DrilldownTable
            records={records}
            A={A}
            state={state}
            setState={setState}
            onRowOpen={onOpenRow}
            tolerance={tolerance}
          />
        )}
      </div>
    </section>
  );
}

/* ============================================================
   <AccuracyDetailDrawer> — drawer body for one accuracy row
   ============================================================ */
function VsCol({ who, dec, amt, meta, reason }) {
  const s = dec ? (DEC_TO_STATUS[dec] || 'pending') : 'pending';
  const verdict = dec ? (dec[0] + dec.slice(1).toLowerCase()) : 'Not finalized';
  return (
    <div className="vs-col">
      <div className="vs-who">
        <span className={`ic ${who === 'Agent' ? 'agent' : 'aman'}`}>{who === 'Agent' ? 'AI' : 'AM'}</span>
        {who === 'Agent' ? 'SaaSPro Agent' : 'AMAN final'}
      </div>
      <div className={`vs-verdict ${s}`}>{verdict.toUpperCase()}</div>
      {amt != null ? <div className="vs-amt">Approved <b>{fmtNGNfull(amt)}</b></div> : (dec ? <div className="vs-amt">—</div> : null)}
      <div className="vs-meta">{meta}</div>
      {reason ? <div className="vs-reason">{reason}</div> : null}
    </div>
  );
}

function BannerFor({ r, tolerance }) {
  const b = r.bucket;
  if (b === 'matched') {
    const tag = r.agent_decision === 'APPROVE' ? ` and approved amounts are within ±${Math.round((tolerance || 0.05) * 100)}%` : '';
    return <div className="vs-banner match"><span className="sp">✓</span><div><b>Match.</b> Agent and AMAN reached the same decision{tag}.</div></div>;
  }
  if (b === 'mismatched') {
    const m = MISMATCH_META[r.mismatch_category] || { label: 'Mismatch', blurb: '' };
    return <div className="vs-banner mismatch"><span className="sp">✕</span><div><b>{m.label}.</b> {r.aman_note || m.blurb}</div></div>;
  }
  if (b === 'pending_aman') {
    return <div className="vs-banner pending"><span className="sp">◷</span><div><b>Pending AMAN.</b> The agent has decided; AMAN hasn't written back a final decision yet.</div></div>;
  }
  return <div className="vs-banner skipped"><span className="sp">—</span><div><b>Agent skipped.</b> {r.aman_note || 'The agent rendered no firm verdict; AMAN handled this PA directly.'}</div></div>;
}

function AmanStatusPill({ status }) {
  if (!status) return <span className="pill pending"><span className="dot" />Not seen</span>;
  const s = String(status).toLowerCase();
  if (s === 'approved') return <span className="pill approve"><span className="dot" />Approved</span>;
  if (s === 'rejected') return <span className="pill deny"><span className="dot" />Rejected</span>;
  if (s === 'queried')  return <span className="pill escalate"><span className="dot" />Queried</span>;
  return <span className="pill pending"><span className="dot" />{s[0].toUpperCase() + s.slice(1)}</span>;
}

function AgentItemPill({ decision }) {
  if (decision === 'APPROVE') return <span className="pill approve"><span className="dot" />Covered</span>;
  if (decision === 'DENY')    return <span className="pill deny"><span className="dot" />Denied</span>;
  return <span className="pill pending"><span className="dot" />—</span>;
}

function ItemCompareTable({ items }) {
  if (!items || !items.length) {
    return (
      <p className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 12, padding: '8px 0' }}>
        No per-item breakdown for this PA — neither the agent nor AMAN sent line-level decisions.
      </p>
    );
  }
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.8fr 130px 130px 110px 110px', gap: 12, padding: '10px 14px', background: 'var(--bg-2)', borderBottom: '1px solid var(--line)', fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
        <span>Line item</span>
        <span>Agent verdict</span>
        <span>AMAN verdict</span>
        <span style={{ textAlign: 'right' }}>Agent ₦</span>
        <span style={{ textAlign: 'right' }}>AMAN ₦</span>
      </div>
      {items.map((it, i) => {
        const reason = it.agent_reason;
        const amanComment = it.aman_comment;
        const amanMeta = [it.aman_auth_code ? `Auth ${it.aman_auth_code}` : '', it.aman_decided_at ? `Decided ${it.aman_decided_at}` : ''].filter(Boolean).join(' · ');
        return (
          <div key={it.claim_item_id || i} style={{ borderTop: i ? '1px solid var(--line)' : 'none' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1.8fr 130px 130px 110px 110px', gap: 12, padding: '10px 14px', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13, color: 'var(--ink)' }}>{it.name}</div>
                {it.quantity ? <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>qty {it.quantity}</div> : null}
              </div>
              <div><AgentItemPill decision={it.agent_decision} /></div>
              <div><AmanStatusPill status={it.aman_status} /></div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'right', color: 'var(--ink-2)' }}>
                {it.agent_decision === 'APPROVE'
                  ? fmtNGNfull(it.agent_recommended_cost || it.agent_requested_cost)
                  : (it.agent_decision === 'DENY' ? '₦0' : '—')}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'right', color: 'var(--ink)' }}>
                {it.aman_status === 'approved' ? fmtNGNfull(it.aman_approved_cost) : (it.aman_status === 'rejected' ? '₦0' : '—')}
              </div>
            </div>
            {reason ? (
              <div style={{ padding: '0 14px 12px 14px', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.5 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--ink-3)', marginRight: 6 }}>Why the agent said this:</span>
                {reason}
              </div>
            ) : null}
            {amanComment || amanMeta ? (
              <div style={{ padding: reason ? '0 14px 12px 14px' : '0 14px 12px 14px', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.5 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--ink-3)', marginRight: 6 }}>AMAN comment:</span>
                {amanComment || 'No comment'}{amanMeta ? <span style={{ color: 'var(--ink-3)' }}> · {amanMeta}</span> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function AmanCountsSummary({ counts }) {
  if (!counts) return null;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return null;
  const chip = (k, label, cls) => counts[k] > 0 ? (
    <span key={k} className={`pill ${cls}`} style={{ marginRight: 6 }}>
      <span className="dot" />{counts[k]} {label}
    </span>
  ) : null;
  return (
    <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--ink-3)', marginRight: 8 }}>AMAN line breakdown</span>
      {chip('approved', 'approved', 'approve')}
      {chip('rejected', 'rejected', 'deny')}
      {chip('queried', 'queried', 'escalate')}
      {chip('pending', 'pending', 'pending')}
    </div>
  );
}

function ConsumptionSummary({ consumption }) {
  if (!consumption) return null;
  const limits = [
    ...((Array.isArray(consumption.enrollee_limits) && consumption.enrollee_limits) || []),
    ...((Array.isArray(consumption.policy_limits) && consumption.policy_limits) || []),
  ];
  if (!limits.length) {
    return (
      <div className="vs-banner pending" style={{ marginTop: 12 }}>
        <span className="sp">◷</span>
        <div><b>No consumption limits in latest AMAN payload.</b> The agent may have used fallback plan rules for this PA.</div>
      </div>
    );
  }
  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg)' }}>
      <div style={{ padding: '10px 14px', background: 'var(--bg-2)', borderBottom: '1px solid var(--line)', fontFamily: 'var(--mono)', fontSize: 10.5, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--ink-3)' }}>
        Cycle {consumption.cycle?.label || '—'}
      </div>
      {limits.slice(0, 8).map((limit, i) => (
        <div key={`${limit.limit_definition_id || 'limit'}-${i}`} style={{ display: 'grid', gridTemplateColumns: '1fr 92px 92px 92px', gap: 10, padding: '10px 14px', borderTop: i ? '1px solid var(--line)' : 'none', alignItems: 'center' }}>
          <div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink)' }}>
              Rule {limit.limit_definition_id || '—'} · {limit.metric_name || limit.metric_type || 'Limit'}
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>
              {limit.target_type || 'scope'} · {limit.period || 'period'}
            </div>
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'right' }}>cap<br /><b>{fmtNGNfull(limit.limit_value)}</b></div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'right' }}>used<br /><b>{fmtNGNfull(limit.consumed_value)}</b></div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'right' }}>left<br /><b>{fmtNGNfull(limit.remaining_value)}</b></div>
        </div>
      ))}
    </div>
  );
}

export function AccuracyDetailDrawer({ r, tolerance = 0.05, onOpenInIntake }) {
  if (!r) return null;
  const focusedItems = r.line_item ? [r.line_item] : (r.items_compare || []);
  const line = r.line_item || null;
  const lineAmanDecision = line ? (
    line.aman_status === 'approved' ? 'APPROVE' :
    line.aman_status === 'rejected' ? 'DENY' :
    line.aman_status === 'queried' ? 'ESCALATE' :
    null
  ) : null;
  const compareRecord = line ? {
    ...r,
    bucket: r.line_bucket,
    mismatch_category: r.line_mismatch_category,
    agent_decision: line.agent_decision,
    aman_decision: lineAmanDecision,
    agent_amount: line.agent_decision === 'APPROVE' ? (line.agent_recommended_cost || line.agent_requested_cost) : 0,
    aman_amount: line.aman_status === 'approved' ? line.aman_approved_cost : 0,
  } : r;
  const agentLat = r.agent_decision ? fmtLat(r.agent_latency_s) : '—';
  const amanLat = r.aman_review_min != null ? fmtMins(r.aman_review_min) : 'pending';
  const agentMeta = r.agent_decision ? `decided in ${agentLat}` : 'escalated / no verdict';
  const amanMeta = r.aman_decision ? `reviewed in ${amanLat} · ${r.callback_mode || 'advisory'}` : 'awaiting writeback';
  const agentNote = (line && line.agent_reason) || r.agent_reason || 'No agent reason captured.';
  const amanComment = line?.aman_comment || r.aman_note || '';
  const amanNote = amanComment || (lineAmanDecision || r.aman_decision ? 'AMAN did not include a comment for this line.' : 'AMAN has not written back a final decision for this line yet.');
  const lineTitle = line?.name || r.item_description || 'Selected line';
  const lineClaim = line?.claim_item_id ? `claim #${line.claim_item_id}` : null;
  return (
    <div className="detail">
      <div className="dhead">
        <div>
          <div className="dref">{r.display_request_id}</div>
          <h2 className="dname">{r.patient_name || 'Unnamed enrollee'}</h2>
          <div className="dsub">{r.plan || '—'} · {r.patient_id || '—'}</div>
        </div>
        {onOpenInIntake ? (
          <button className="btn sm primary" onClick={() => onOpenInIntake(r)} data-tip="Open the full PA drawer in Pre-Auth Intake.">
            Open in PA intake
          </button>
        ) : null}
      </div>

      <div>
        <div className="sec-h">{line ? 'Selected line decision' : 'Decision compare'} <span className="n">agent ↔ AMAN</span></div>
        <div className="vs-grid">
          <VsCol
            who="Agent"
            dec={line ? line.agent_decision : r.agent_decision}
            amt={line ? (line.agent_decision === 'APPROVE' ? (line.agent_recommended_cost || line.agent_requested_cost) : null) : (r.agent_decision === 'APPROVE' ? r.agent_amount : null)}
            meta={agentMeta}
            reason={(line && line.agent_reason) || r.agent_reason || ''}
          />
          <VsCol
            who="AMAN"
            dec={line ? lineAmanDecision : r.aman_decision}
            amt={line ? (line.aman_status === 'approved' ? line.aman_approved_cost : null) : (r.aman_decision === 'APPROVE' ? r.aman_amount : null)}
            meta={amanMeta}
            reason={r.aman_note || ''}
          />
        </div>
        <BannerFor r={compareRecord} tolerance={tolerance} />
        <AmanCountsSummary counts={r.aman_item_counts} />
      </div>

      <div>
        <div className="sec-h">Decision notes</div>
        <div className="decision-notes">
          <div className="decision-note">
            <div className="k">Line</div>
            <div className="v">{lineTitle}</div>
            {lineClaim ? <div className="m">{lineClaim}</div> : null}
            <div className="m">{r.requested_amount != null ? `Requested ${fmtNGNfull(line?.agent_requested_cost || r.requested_amount)}` : 'Requested —'}</div>
          </div>
          <div className="decision-note">
            <div className="k">Agent reason</div>
            <div className="v">{agentNote}</div>
          </div>
          <div className="decision-note">
            <div className="k">AMAN comment</div>
            <div className="v">{amanNote}</div>
            {line?.aman_auth_code ? <div className="m">Auth {line.aman_auth_code}</div> : null}
          </div>
        </div>
      </div>

      <div>
        <div className="sec-h">{line ? 'Focused line decision' : 'Line decisions'} <span className="n">{line ? `line ${r.line_index || 1} of ${r.line_count || (r.items_compare || []).length || 1}` : `${(r.items_compare || []).length} items`}</span></div>
        <ItemCompareTable items={focusedItems} />
      </div>
    </div>
  );
}

/* ============================================================
   <WeeklyQaReportSheet> — print portal
   Mirrors saas-pro/project/Weekly QA Report.html in the design bundle.
   Cadence (Daily / Weekly / Custom range) is detected from the window
   length so the same component renders either flavour.
   ============================================================ */
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function detectCadence(window) {
  if (!window?.from || !window?.to) return { period: 'Custom', title: 'QA Report', cadence: 'Ad-hoc', intro: 'Custom-range view of agent-vs-AMAN accuracy for the period shown.' };
  const ms = new Date(window.to).getTime() - new Date(window.from).getTime();
  const days = Math.round(ms / (24 * 60 * 60 * 1000)) + 1;
  if (days <= 1) return {
    period: 'Daily', title: 'Daily QA Report', cadence: 'Daily · End of day',
    intro: "Today's view — every PA the agent decided against AMAN's same-day final. Daily QA cadence catches drift early before it shows up in the weekly roll-up.",
  };
  if (days <= 8) return {
    period: 'Weekly', title: 'Weekly QA Report', cadence: 'Weekly · Monday',
    intro: "Rolling 7-day view — the standard QA cadence reviewed with AMAN each Monday. Accuracy is the agent's decision measured against AMAN's final human decision; in advisory mode AMAN makes the binding call, so every scored PA is a like-for-like comparison.",
  };
  if (days <= 32) return {
    period: 'Monthly', title: 'Monthly QA Report', cadence: 'Monthly',
    intro: 'Monthly roll-up of agent-vs-AMAN accuracy. Useful for trend review across multiple weekly cycles.',
  };
  return {
    period: 'Custom', title: `QA Report · ${days}-day range`, cadence: 'Ad-hoc',
    intro: `Custom ${days}-day window. Use this for board reviews or quarterly assessments.`,
  };
}

function DecPillRaw({ d }) {
  if (!d) return <span className="pill pending"><span className="dot" />Pending</span>;
  const s = DEC_TO_STATUS[d] || 'pending';
  const label = d[0] + d.slice(1).toLowerCase();
  return <span className={`pill ${s}`}><span className="dot" />{label}</span>;
}

export function WeeklyQaReportSheet({ data, mode = 'all', session, orgName }) {
  if (typeof document === 'undefined' || !data) return null;
  const A = data.aggregates?.[mode] || data.aggregates?.all;
  if (!A) return null;
  const L = A.latency || {};
  const factor = speedFactor(L);
  const matchRate = A.scored ? ((A.matched / A.scored) * 100).toFixed(1) : '—';
  const cats = (A.categories || []).filter((c) => c.v > 0).slice().sort((a, b) => b.v - a.v);
  const top10 = (data.records || [])
    .filter((r) => r.bucket === 'mismatched')
    .sort((a, b) => new Date(submittedAt(b) || 0).getTime() - new Date(submittedAt(a) || 0).getTime())
    .slice(0, 10);
  const cadence = detectCadence(data.window);
  const v = A.value || {};
  const maxV = Math.max(v.requested || 0, 1);
  const delta = (v.aman_approved || 0) - (v.agent_approved || 0);
  const agentMin = (L.agent_s || 0) / 60;
  const totalMin = agentMin + (L.aman_min || 0);
  const maxMin = Math.max(totalMin, 1);
  const totalMM = cats.reduce((s, c) => s + c.v, 0) || 1;
  const maxC = Math.max(...cats.map((c) => c.v), 1);
  const shades = ['#c0362c', '#cf4a40', '#d65f56', '#dd766e', '#e48d86', '#eca49f'];
  const todayStr = fmtDate(new Date().toISOString());

  const topCat = cats[0] ? (MISMATCH_META[cats[0].key]?.label || cats[0].key).toLowerCase() : '—';
  const interpTone = (Number(matchRate) >= 90)
    ? 'Accuracy is in range to begin expanding applied mode on the highest-confidence categories.'
    : 'Recommend keeping advisory mode while the mismatch categories above are reviewed with AMAN.';

  return createPortal(
    <div className="qa-report-portal">
      <div className="paper-stage">
        <div className="sheet">
          {/* masthead */}
          <header className="rpt-mast">
            <div className="rpt-brand">
              <span className="rpt-mark" />
              <span className="rpt-word">SaaSPro</span>
            </div>
            <div className="rpt-mast-r">
              <div className="rpt-doc">{cadence.title}</div>
              <div className="rpt-class">CONFIDENTIAL · {(orgName || 'AMAN').toUpperCase()}</div>
            </div>
          </header>

          {/* title block */}
          <div className="rpt-title">
            <div className="rt-eyebrow">Agent vs AMAN · pre-authorization accuracy</div>
            <h1 className="rt-name">{cadence.title}</h1>
            <div className="rt-sub">{data.window?.label || '—'} · {A.label || mode}</div>
            <div className="rt-meta">
              <div className="rt-cell"><span className="rt-l">Period</span><span className="rt-v">{cadence.period}</span></div>
              <div className="rt-cell"><span className="rt-l">PAs in window</span><span className="rt-v">{A.total}</span></div>
              <div className="rt-cell"><span className="rt-l">Scored vs AMAN</span><span className="rt-v">{A.scored}</span></div>
              <div className="rt-cell"><span className="rt-l">Match rate</span><span className="rt-v">{matchRate}%</span></div>
              <div className="rt-cell"><span className="rt-l">Mode</span><span className="rt-v">{A.label}</span></div>
              <div className="rt-cell"><span className="rt-l">Prepared by</span><span className="rt-v">{session?.name || '—'} · QA</span></div>
              <div className="rt-cell"><span className="rt-l">Generated</span><span className="rt-v">{todayStr}</span></div>
              <div className="rt-cell"><span className="rt-l">Cadence</span><span className="rt-v">{cadence.cadence}</span></div>
            </div>
            <p className="rt-note">{cadence.intro}</p>
          </div>

          {/* headline accuracy */}
          <div className="qa-sech">Headline accuracy <small>— how often the agent agreed with AMAN's final decision</small></div>
          <div className="qa-buckets">
            {['matched', 'mismatched', 'pending_aman', 'agent_skipped'].map((key) => {
              const meta = BUCKET_META[key];
              const cls = key === 'pending_aman' ? 'pending' : key === 'agent_skipped' ? 'skipped' : key;
              const count = A[key];
              const scored = key === 'matched' || key === 'mismatched';
              const denom = scored ? A.scored : A.total;
              const pct = denom ? ((count / denom) * 100).toFixed(1) : '0.0';
              return (
                <div key={key} className={`qa-bucket ${cls}`}>
                  <div className="l">{meta.label}</div>
                  <div className="v">{count}</div>
                  <div className="s">{pct}% of {denom} {scored ? 'scored' : 'total'}</div>
                </div>
              );
            })}
          </div>

          {/* value + time */}
          <div className="qa-sech">Value &amp; time</div>
          <div className="qa-two">
            <div className="qa-card">
              <h3>Value flow</h3>
              <p className="muted">Authorized value (₦) — agent vs AMAN final</p>
              <div className="vflow">
                {[
                  ['Requested', v.requested, 'var(--ink-4)'],
                  ['Agent-approved', v.agent_approved, 'var(--indigo)'],
                  ['AMAN-approved', v.aman_approved, 'var(--ok)'],
                  ['Rejected (final)', v.rejected, 'var(--bad)'],
                ].map(([lab, amt, c]) => (
                  <div key={lab} className="vrow">
                    <span className="vlab">{lab}</span>
                    <span className="vbar"><span style={{ width: `${((amt || 0) / maxV * 100).toFixed(1)}%`, background: c }} /></span>
                    <span className="vamt">{fmtNGNfull(amt || 0)}</span>
                  </div>
                ))}
                <div className="vrow delta">
                  <span className="vlab">AMAN − Agent Δ</span>
                  <span className="vbar"><span style={{ width: `${Math.min(100, Math.abs(delta) / maxV * 100).toFixed(1)}%`, background: delta >= 0 ? 'var(--ok)' : 'var(--bad)' }} /></span>
                  <span className={`vamt ${delta >= 0 ? 'pos' : 'neg'}`}>{delta >= 0 ? '+' : '−'}{fmtNGNfull(Math.abs(delta))}</span>
                </div>
              </div>
            </div>

            <div className="qa-card">
              <h3>Time to decision</h3>
              <p className="muted">How long each side takes to reach a verdict</p>
              <div className="lat-rows">
                {[
                  { lab: 'Agent decision', num: fmtLat(L.agent_s), c: 'var(--ok)', mins: agentMin, p: `p50 ${fmtLat(L.agent_p50)} · p95 ${fmtLat(L.agent_p95)}` },
                  { lab: 'AMAN review',    num: fmtMins(L.aman_min), c: 'var(--warn)', mins: L.aman_min || 0, p: `p50 ${fmtMins(L.aman_p50)} · p95 ${fmtMins(L.aman_p95)}` },
                  { lab: 'Total end-to-end', num: fmtMins(totalMin), c: 'var(--slate)', mins: totalMin, p: 'submitted → AMAN final' },
                ].map((r) => (
                  <div key={r.lab} className="lat-row">
                    <div className="lr-top">
                      <span className="lr-lab"><span className="swatch" style={{ background: r.c }} />{r.lab}</span>
                      <span className="lr-num">{r.num}</span>
                    </div>
                    <div className="lr-scale"><span style={{ width: `${Math.max(2, (r.mins || 0) / maxMin * 100).toFixed(2)}%`, background: r.c }} /></div>
                    <div className="lr-pct">{r.p}</div>
                  </div>
                ))}
              </div>
              {factor ? (
                <div className="lat-tag">Agent reaches a verdict <b>{factor.toLocaleString()}×</b> faster than AMAN's manual review.</div>
              ) : (
                <div className="lat-tag">AMAN review timing will appear once AMAN starts writing back finals.</div>
              )}
            </div>
          </div>

          {/* mismatch breakdown — visual bars */}
          <div className="qa-sech">Mismatch breakdown <small>— is the disagreement systematic?</small></div>
          <div className="qa-card">
            <div className="mm-bars">
              {cats.length ? cats.map((c, i) => {
                const meta = MISMATCH_META[c.key] || { label: c.key };
                const w = Math.max(8, c.v / maxC * 100);
                const shade = shades[Math.min(i, shades.length - 1)];
                return (
                  <div key={c.key} className="mm-row">
                    <span className="mm-lab">{meta.label}</span>
                    <span className="mm-track"><span style={{ width: `${w.toFixed(1)}%`, background: shade }}>{c.v}</span></span>
                    <span className="mm-pct">{Math.round(c.v / totalMM * 100)}%</span>
                  </div>
                );
              }) : (
                <p className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>No mismatches in this mode — every scored PA agreed with AMAN.</p>
              )}
            </div>
          </div>

          {/* top mismatches table */}
          <div className="qa-sech">{cadence.period === 'Daily' ? 'Today’s mismatches' : 'Top mismatches'} <small>— {top10.length} most recent, to walk through with AMAN</small></div>
          <table className="qa-table">
            <colgroup>
              <col className="c-ref" /><col className="c-pt" /><col className="c-item" />
              <col className="c-vs" /><col className="c-cat" /><col className="c-lat" />
            </colgroup>
            <thead>
              <tr><th>Ref</th><th>Patient</th><th>Item</th><th>Agent → AMAN</th><th>Category</th><th>Agent / AMAN</th></tr>
            </thead>
            <tbody>
              {top10.length ? top10.map((r) => {
                const cat = r.mismatch_category ? MISMATCH_META[r.mismatch_category] : null;
                return (
                  <tr key={r.request_id}>
                    <td className="ref">{refTail(r.display_request_id)}</td>
                    <td>
                      <div className="pt-name">{r.patient_name || 'Unnamed'}</div>
                      <div className="muted mono" style={{ fontSize: 10.5, fontFamily: 'var(--mono)', color: 'var(--ink-3)' }}>{r.patient_id}</div>
                    </td>
                    <td><div className="pt-name">{r.item_description || '—'}</div></td>
                    <td><div className="vs"><DecPillRaw d={r.agent_decision} /><span className="arrow">→</span><DecPillRaw d={r.aman_decision} /></div></td>
                    <td>{cat ? <span className={`cat-badge ${cat.cls}`}>{cat.label}</span> : null}</td>
                    <td className="latcell">
                      {r.agent_decision ? fmtLat(r.agent_latency_s) : '—'}<br />
                      {r.aman_review_min != null ? fmtMins(r.aman_review_min) : '—'}
                    </td>
                  </tr>
                );
              }) : (
                <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--ink-3)' }}>No mismatches to investigate in this window.</td></tr>
              )}
            </tbody>
          </table>

          {/* interpretation paragraph */}
          <div className="qa-interp">
            <b>Read:</b> {(() => {
              const p = cadence.period.toLowerCase();
              if (p === 'daily') return 'Today';
              if (p === 'weekly') return 'Over this week';
              if (p === 'monthly') return 'Over this month';
              return 'In this period';
            })()}, the agent agreed with AMAN on <b>{A.matched} of {A.scored}</b> scored decisions (<b>{matchRate}%</b>){factor ? <>, reaching each verdict on average <b>{factor.toLocaleString()}× faster</b> than manual review</> : ''}.
            {cats.length ? <> Disagreements are concentrated in <b>{topCat}</b> calls; <b>{fmtNGN(v.overturned_denials || 0)}</b> sat in agent denials that AMAN later overturned. {interpTone}</> : <> No mismatches were flagged — every scored PA matched.</>}
          </div>

          {/* footer */}
          <div className="rpt-end">
            <span className="re-brand">
              <span className="rpt-mark sm" />
              SaaSPro Labs · pre-authorization agent
            </span>
            <span>Generated {todayStr} · {A.label} · for {orgName || 'AMAN'}</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
