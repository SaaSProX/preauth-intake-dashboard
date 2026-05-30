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
   SVG chart builders (ported from the prototype, return HTML strings)
   ============================================================ */
function chartBars(data, { w = 560, h = 200, max = null, accent = 'var(--ink-3)', labels = null } = {}) {
  if (!data || !data.length) return '';
  const m = max || Math.max(...data) * 1.1 || 1;
  const pad = { l: 38, r: 8, t: 8, b: 22 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const bw = iw / data.length;
  const barW = Math.max(2, bw * 0.4);
  let bars = '';
  data.forEach((v, i) => {
    const bh = (v / m) * ih;
    const x = pad.l + i * bw + (bw - barW) / 2;
    const y = pad.t + ih - bh;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${accent}"/>`;
  });
  let grid = '', ylab = '';
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const val = (m / ticks) * t;
    const y = pad.t + ih - (val / m) * ih;
    grid += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`;
    ylab += `<text x="${pad.l - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-family="var(--mono)" font-size="9.5" fill="var(--ink-4)">${val >= 1000 ? (val / 1000) + 'k' : Math.round(val)}</text>`;
  }
  let xlab = '';
  if (labels) labels.forEach((l, i) => {
    const idx = Math.round((data.length - 1) * (i / (labels.length - 1)));
    const x = pad.l + idx * bw + bw / 2;
    xlab += `<text x="${x.toFixed(1)}" y="${h - 5}" text-anchor="middle" font-family="var(--mono)" font-size="9.5" fill="var(--ink-4)">${l}</text>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="none" style="display:block">${grid}${bars}${ylab}${xlab}</svg>`;
}
function chartLine(data, { w = 560, h = 200, accent = 'var(--indigo)', fill = true, labels = null, prefix = '', suffix = '' } = {}) {
  if (!data || data.length < 2) return '';
  const max = Math.max(...data) * 1.12, min = Math.min(...data) * 0.85;
  const span = max - min || 1;
  const pad = { l: 44, r: 10, t: 10, b: 22 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const xs = (i) => pad.l + (iw * i) / (data.length - 1);
  const ys = (v) => pad.t + ih - ((v - min) / span) * ih;
  let d = '';
  data.forEach((v, i) => { d += (i ? 'L' : 'M') + xs(i).toFixed(1) + ' ' + ys(v).toFixed(1) + ' '; });
  const area = d + `L${xs(data.length - 1).toFixed(1)} ${(pad.t + ih).toFixed(1)} L${xs(0).toFixed(1)} ${(pad.t + ih).toFixed(1)} Z`;
  let grid = '', ylab = '';
  for (let t = 0; t <= 4; t++) {
    const val = min + (span / 4) * t;
    const y = ys(val);
    grid += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${w - pad.r}" y2="${y.toFixed(1)}" stroke="var(--line)" stroke-width="1" stroke-dasharray="2 3"/>`;
    ylab += `<text x="${pad.l - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-family="var(--mono)" font-size="9.5" fill="var(--ink-4)">${prefix}${val >= 1000 ? (val / 1000).toFixed(0) + 'k' : Math.round(val)}${suffix}</text>`;
  }
  let xlab = '';
  if (labels) labels.forEach((l, i) => {
    const idx = Math.round((data.length - 1) * (i / (labels.length - 1)));
    xlab += `<text x="${xs(idx).toFixed(1)}" y="${h - 5}" text-anchor="middle" font-family="var(--mono)" font-size="9.5" fill="var(--ink-4)">${l}</text>`;
  });
  const gid = 'g' + Math.random().toString(36).slice(2, 7);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="none" style="display:block">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity="0.16"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient></defs>
    ${grid}${fill ? `<path d="${area}" fill="url(#${gid})"/>` : ''}
    <path d="${d}" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${data.map((v, i) => i === data.length - 1 ? `<circle cx="${xs(i).toFixed(1)}" cy="${ys(v).toFixed(1)}" r="3.5" fill="${accent}"/>` : '').join('')}
    ${ylab}${xlab}</svg>`;
}
function chartDonut(slices, { size = 188, thickness = 26 } = {}) {
  const total = slices.reduce((a, s) => a + s.v, 0) || 1;
  const r = (size - thickness) / 2, cx = size / 2, cy = size / 2, C = 2 * Math.PI * r;
  let off = 0, segs = '';
  slices.forEach((s) => {
    const len = (s.v / total) * C;
    segs += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.c}" stroke-width="${thickness}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    off += len;
  });
  const top = slices.reduce((a, s) => (s.v > a.v ? s : a), slices[0] || { v: 0, k: '' });
  return `<div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap">
    <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="flex:none">${segs}
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-family="var(--mono)" font-size="26" font-weight="600" fill="var(--ink)">${Math.round((top.v / total) * 100)}%</text>
      <text x="${cx}" y="${cy + 18}" text-anchor="middle" font-family="var(--mono)" font-size="10" fill="var(--ink-3)">${(top.k || '').toUpperCase()}</text>
    </svg>
    <div style="display:flex;flex-direction:column;gap:10px">
      ${slices.map((s) => `<div style="display:flex;align-items:center;gap:9px;font-family:var(--mono);font-size:12.5px"><span style="width:9px;height:9px;border-radius:2px;background:${s.c}"></span><span style="color:var(--ink-2);min-width:78px">${s.k}</span><b style="color:var(--ink)">${s.v.toLocaleString()}</b></div>`).join('')}
    </div></div>`;
}

function chartHBars(data, { accent = 'var(--indigo)' } = {}) {
  const max = Math.max(...data.map((d) => d.v)) || 1;
  return `<div style="display:flex;flex-direction:column;gap:10px">${data.map((d) => `<div style="display:grid;grid-template-columns:64px 1fr 48px;align-items:center;gap:10px;font-family:var(--mono);font-size:12px"><span style="color:var(--ink-2)">${d.k}</span><span style="height:9px;background:var(--bg-3);border-radius:5px;overflow:hidden"><span style="display:block;height:100%;width:${(d.v / max * 100).toFixed(1)}%;background:${accent};border-radius:5px"></span></span><b style="text-align:right;color:var(--ink)">${d.v}</b></div>`).join('')}</div>`;
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
  return <span className={`conf ${String(level).toLowerCase()}`}><span className="bars"><i /><i /><i /></span><b>{level}</b> confidence</span>;
}
function PlanTag({ plan }) {
  return <span className={`plan-tag ${planClass(plan)}`}>{plan}</span>;
}
function CodeBlock({ data, style }) {
  return <div className="codeblock" style={style} dangerouslySetInnerHTML={{ __html: jsonPretty(data) }} />;
}
function Html({ html, className, style }) {
  return <div className={className} style={style} dangerouslySetInnerHTML={{ __html: html }} />;
}

/* ============================================================
   Report: metric card + queue table
   ============================================================ */
function MetricCard({ title, desc, big, chartHtml, moveH, moveP }) {
  return (
    <div className="metric">
      <h3>{title}</h3>
      <p className="desc">{desc}</p>
      {big ? <div className="big" dangerouslySetInnerHTML={{ __html: big }} /> : null}
      <div className="chart-wrap">
        {chartHtml ? <Html html={chartHtml} /> : <div className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 12, padding: '24px 0' }}>Not enough data for a trend yet.</div>}
      </div>
      <div className="insight-sep"><span className="sparkle">✦</span> Insight is autogenerated</div>
      <div className="move-h">{moveH}</div>
      <p className="move-p">{moveP}</p>
    </div>
  );
}
function QueueHead() {
  return (
    <div className="qhead">
      <span>Reference</span><span>Patient</span><span>Plan</span><span>Item</span>
      <span style={{ textAlign: 'right' }}>Amount</span><span style={{ textAlign: 'right' }}>Status · latency</span><span style={{ textAlign: 'right' }}>Received</span>
    </div>
  );
}
function QueueRow({ r, selected, onSelect }) {
  const ref = (r.display_request_id || '').split('/').slice(-1)[0] || r.request_id;
  return (
    <div className={`qrow ${selected ? 'sel' : ''}`} onClick={() => onSelect(r.request_id)}>
      <div className="ref">{ref}<small>{r.checkin_type} · {r.item_type || '—'}</small></div>
      <div className="pt">{r.patient_name || <span className="muted">Unnamed enrollee</span>}<small>{r.patient_id}</small></div>
      <div className="plan"><PlanTag plan={r.plan} /></div>
      <div className="item" title={r.item_description}>{r.item_description}{r.line_item_count > 1 ? <span className="muted"> ·{r.line_item_count}</span> : ''}</div>
      <div className="amt">{fmtNGN(r.requested_amount)}</div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}><Pill status={r.status} /><span className="lat">{fmtSecs(r.processing_seconds)}</span></div>
      <div className="when">{r.received_label}</div>
    </div>
  );
}

/* ============================================================
   Detail (used inside the drawer)
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
      {r.flags && r.flags.length > 0 && <div className="flags">{r.flags.map((f, i) => <span className="flag" key={i}>{f}</span>)}</div>}
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
  return <div className="dgrid">{cells.map(([l, v, mono], i) => (
    <div className="cell" key={i}><div className="lab">{l}</div><div className={`val ${mono ? 'mono' : ''}`}>{v}</div></div>
  ))}</div>;
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
    return <div className="muted" style={{ fontFamily: 'var(--mono)', fontSize: '12.5px', padding: '14px 0' }}>Pipeline has not started for this request{r.status === 'received' ? ' — awaiting auto-decision.' : '.'}</div>;
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
            {s.result ? <div className="s-raw"><details><summary>Stage result JSON</summary><CodeBlock data={s.result} /></details></div> : null}
          </div>
        );
      })}
    </div>
  );
}
function DetailView({ r }) {
  if (!r) return null;
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
function Drawer({ request, open, onClose }) {
  return (
    <>
      <div className={`drawer-scrim ${open ? 'open' : ''}`} onClick={onClose} />
      <aside className={`drawer ${open ? 'open' : ''}`}>
        <button className="icon-btn dclose" onClick={onClose} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
        <div className="dwrap"><div id="drawer-body">{open && request ? <DetailView r={request} /> : null}</div></div>
      </aside>
    </>
  );
}

/* ============================================================
   Chrome: status bar, sidebar, ask bar
   ============================================================ */
function StatusBar({ session, role, onRole, refreshedLabel }) {
  const org = session.org_name || 'Organization';
  const short = org.split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  const isAdmin = (session.role || 'member') === 'admin';
  return (
    <div className="statusbar">
      <div className="sb-org"><span className="org-dot">{short}</span><b>{org}</b><span className="scope">org-scoped</span></div>
      <div className="sb-refresh"><span className="spin" /> {refreshedLabel}</div>
      <div className="sb-right">
        {isAdmin ? (
          <span className="roleswitch" title="Preview the member experience">
            <button className={role === 'admin' ? 'on' : ''} onClick={() => onRole('admin')}>Admin</button>
            <button className={role === 'member' ? 'on' : ''} onClick={() => onRole('member')}>Member</button>
          </span>
        ) : (
          <span className="roleswitch"><button className="on">Member</button></span>
        )}
        <span className="live-toggle"><span className="led" /> Live</span>
      </div>
    </div>
  );
}
const NAV = [
  { id: 'intake', label: 'Pre-Auth Intake', live: true },
  { id: 'health', label: 'Integration Health', live: true },
  { id: 'audit', label: 'Audit Trail', live: true },
  { id: 'eligibility', label: 'Eligibility Checks', live: false },
  { id: 'support', label: 'Support', live: false },
];
const NAV_ADMIN = [
  { id: 'team', label: 'Team', live: true, lock: true },
  { id: 'apikey', label: 'API Key', live: true, lock: true },
];
const NAV_PLATFORM = [
  { id: 'onboarding', label: 'Onboarding', live: true, lock: true },
];
function Sidebar({ active, onNav, session, intakeCount, collapsed, onToggleCollapse, isSuperAdmin, onSignOut }) {
  const initials = (session.name || '?').split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  const item = (n) => (
    <a key={n.id} className={`navitem ${n.lock ? 'lock' : ''} ${n.id === active ? 'active' : ''} ${n.live ? '' : 'soon'}`} href="#" title={collapsed ? n.label : undefined} onClick={(e) => { e.preventDefault(); onNav(n.id); }}>
      <span className="gl" /><span className="nav-label">{n.label}</span>
      {!n.live ? <span className="soon-tag">SOON</span> : (n.id === 'intake' ? <span className="ct">{intakeCount}</span> : null)}
    </a>
  );
  return (
    <aside className="side">
      <div className="side-head">
        <span className="side-brand"><img src="/saaspro-mark.png" alt="SaaSPro" className="brand-mark" /><span className="brand-name">SaaSPro</span></span>
        <button className="side-toggle" onClick={onToggleCollapse} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-label="Toggle sidebar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">{collapsed ? <path d="M9 18l6-6-6-6" /> : <path d="M15 18l-6-6 6-6" />}</svg>
        </button>
      </div>
      {NAV.map(item)}
      <div className="nav-group" data-admin-only="">
        <div className="grp">Admin</div>
        {NAV_ADMIN.map(item)}
      </div>
      {isSuperAdmin && (
        <div className="nav-group">
          <div className="grp">Platform</div>
          {NAV_PLATFORM.map(item)}
        </div>
      )}
      <div className="side-foot">
        <div className="row">
          <span className="ava">{initials}</span>
          <span className="who">{session.name}<small>{(session.role || 'member').toUpperCase()} · {session.org_name}</small></span>
          <button className="signout-btn" onClick={onSignOut} title="Sign out" aria-label="Sign out">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
          </button>
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
   Integration Health (wired to /auth/webhook-delivery-logs)
   ============================================================ */
function KpiTile({ label, val, sub }) {
  return (
    <div className="kpi">
      <div className="k-label">{label}</div>
      <div className="k-val tnum" dangerouslySetInnerHTML={{ __html: val }} />
      {sub ? <div className="k-sub" dangerouslySetInnerHTML={{ __html: sub }} /> : null}
    </div>
  );
}
function HealthView({ data, loading, error, org }) {
  const d = (data && data.summary) || {};
  const logs = (data && data.logs) || [];
  const recv = d.total_received || 0;
  const pct = (n) => (recv ? ((n / recv) * 100).toFixed(1) : '0.0');
  const funnel = chartHBars([
    { k: 'Received', v: d.total_received || 0 },
    { k: 'Auth ok', v: d.auth_success || 0 },
    { k: 'Valid', v: d.payload_valid || 0 },
    { k: 'DB saved', v: d.db_saved || 0 },
    { k: 'HTTP 2xx', v: d.http_success || 0 },
  ]);
  const clean = (d.auth_failed || 0) + (d.payload_invalid || 0) + (d.db_failed || 0) === 0;
  const attemptMeta = (l) => {
    if (l.auth_status && l.auth_status !== 'auth_success') return { label: 'auth failed', color: 'var(--bad)' };
    if (l.payload_valid === false) return { label: 'invalid', color: 'var(--warn)' };
    if (l.db_insert_status === 'db_insert_failed') return { label: 'db failed', color: 'var(--bad)' };
    return { label: 'valid', color: 'var(--ok)' };
  };
  const shortId = (l) => (l.checkin_id ? l.checkin_id.split('/').slice(-1)[0] : (l.delivery_id || '').slice(0, 8));
  return (
    <>
      <div className="stub-head"><h1 className="page-title">Integration Health</h1></div>
      <p className="page-sub">Inbound webhook deliveries from <b>{org}</b> · <span className="muted">latest {d.latest_received_at ? timeAgo(d.latest_received_at) : '—'}</span></p>
      {error ? <div className="ro-banner" style={{ display: 'flex', marginTop: 18, background: 'var(--bad-bg)', borderColor: 'var(--bad-line)', color: 'var(--bad-ink)' }}><span className="led" style={{ background: 'var(--bad)' }} /> {error}</div> : null}
      <div className="kpi-strip section-gap" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <KpiTile label="Deliveries received" val={(d.total_received || 0).toLocaleString()} sub={`${d.latest_received_at ? timeAgo(d.latest_received_at) : '—'} latest`} />
        <KpiTile label="Auth success" val={`${pct(d.auth_success || 0)}<small>%</small>`} sub={`${d.auth_failed || 0} failed`} />
        <KpiTile label="Payload valid" val={`${pct(d.payload_valid || 0)}<small>%</small>`} sub={`${d.payload_invalid || 0} invalid`} />
        <KpiTile label="Avg processing" val={`${d.avg_processing_time_ms != null ? Math.round(d.avg_processing_time_ms) : '—'}<small>ms</small>`} sub={`${d.http_failed || 0} HTTP errors`} />
      </div>
      <div className="grid-2 section-gap">
        <div className="metric">
          <h3>Delivery funnel</h3><p className="desc">Where inbound requests succeed or drop off</p>
          <div className="chart-wrap"><Html html={funnel} /></div>
          <div className="insight-sep"><span className="sparkle">✦</span> Insight is autogenerated</div>
          <div className="move-h">{recv === 0 ? 'No deliveries yet' : clean ? 'Pipe is healthy' : 'Some deliveries dropped'}</div>
          <p className="move-p">{d.auth_failed || 0} auth failures and {d.payload_invalid || 0} invalid payloads in the window. {d.duplicate_event_attempts || 0} duplicate events and {d.repeated_checkin_attempts || 0} repeated check-ins were de-duplicated.</p>
        </div>
        <div className="metric">
          <h3>Recent delivery attempts</h3><p className="desc">Including rejected deliveries, for observability</p>
          <div className="chart-wrap" style={{ marginTop: 14 }}>
            {logs.length === 0 ? (
              <div className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 12, padding: '16px 0' }}>{loading ? 'Loading…' : 'No deliveries in range.'}</div>
            ) : logs.slice(0, 8).map((l) => {
              const m = attemptMeta(l);
              return (
                <div key={l.delivery_id} style={{ display: 'grid', gridTemplateColumns: '96px 1fr 80px 64px 44px', gap: 10, alignItems: 'center', fontFamily: 'var(--mono)', fontSize: '11.5px', padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
                  <span title={l.checkin_id || l.delivery_id}>{shortId(l)}</span>
                  <span className="muted">{l.created_at ? timeAgo(l.created_at) : '—'}</span>
                  <span style={{ color: m.color }}>{m.label}</span>
                  <span className="muted">{l.db_insert_status === 'db_upsert_success' ? 'saved' : (l.db_insert_status === 'db_insert_failed' ? 'failed' : '—')}</span>
                  <b>{l.http_status_returned ?? '—'}</b>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

/* ============================================================
   Audit Trail (wired to /auth/webhook-audit-trail)
   ============================================================ */
function AuditView({ data, loading, error, query, setQuery, onTrace }) {
  const traces = (data && data.traces) || [];
  const t = traces[0];
  const nodes = [];
  if (t) {
    const dl = t.delivery || {};
    const pa = t.preauth || {};
    const ag = t.agent || {};
    const deliveryOk = dl.auth_status === 'auth_success' && (dl.http_status_returned ? dl.http_status_returned < 400 : true);
    nodes.push({ st: deliveryOk ? 'pass' : 'fail', name: 'Webhook delivery', sum: [dl.auth_status, dl.payload_status, dl.processing_time_ms != null ? dl.processing_time_ms + 'ms' : null].filter(Boolean).join(' · '), time: dl.received_at ? fmtClock(dl.received_at) : '' });
    nodes.push({ st: pa.request_id ? 'pass' : 'skip', name: 'Request stored', sum: pa.request_id ? `${pa.request_id} · status ${pa.status || '—'}` : 'not stored', time: pa.received_at ? fmtClock(pa.received_at) : '' });
    asArr(ag.agent_logs).forEach((l) => nodes.push({ st: l.status === 'pass' || l.status === 'fail' ? l.status : 'pass', name: l.agent_name || STAGE_NAMES[l.agent_num] || 'Stage', sum: STAGE_Q[l.agent_name] || '', time: l.logged_at ? fmtClock(l.logged_at) : '' }));
    if (pa.decision) {
      const dst = pa.decision === 'APPROVE' ? 'pass' : pa.decision === 'DENY' ? 'fail' : 'skip';
      nodes.push({ st: dst, name: `Outcome — ${pa.decision}`, sum: asObj(ag.agent_result).confidence ? `${asObj(ag.agent_result).confidence} confidence recorded` : 'Decision recorded', time: pa.processed_at ? fmtClock(pa.processed_at) : '' });
    }
  }
  return (
    <>
      <div className="stub-head"><h1 className="page-title">Audit Trail</h1></div>
      <p className="page-sub">Trace one event end-to-end: <span className="muted">delivery → stored request → agent decision</span></p>
      <div className="toolbar section-gap">
        <div className="search" style={{ maxWidth: 420 }}>
          <span className="muted mono" style={{ fontSize: 12 }}>trace</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onTrace(); }} placeholder="event_id · checkin_id · request_id" />
        </div>
        <button className="btn indigo" onClick={onTrace}>Trace event</button>
      </div>
      {error ? <div className="ro-banner" style={{ display: 'flex', marginTop: 18, background: 'var(--bad-bg)', borderColor: 'var(--bad-line)', color: 'var(--bad-ink)' }}><span className="led" style={{ background: 'var(--bad)' }} /> {error}</div> : null}
      {loading ? <div className="muted section-gap" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>Loading…</div>
        : !t ? <div className="stub-table section-gap"><div className="stub-empty"><div className="ph">⛓</div><h4>No trace found</h4><p>Search an event_id, checkin_id, or request_id to follow it across the pipeline.</p></div></div>
          : (
            <>
              <p className="page-sub section-gap" style={{ marginTop: 18 }}>Tracing <b>{t.delivery?.checkin_id || t.preauth?.request_id || t.delivery?.event_id}</b>{traces.length > 1 ? <span className="muted"> · {traces.length} matches, showing latest</span> : null}</p>
              <div className="timeline section-gap" style={{ maxWidth: 680, marginTop: 14 }}>
                {nodes.map((n, i) => (
                  <div className={`stage ${n.st}`} key={i}>
                    <div className="node">{n.st === 'pass' ? '✓' : n.st === 'fail' ? '✕' : (i + 1)}</div>
                    <div className="s-top"><span className="s-name">{n.name}</span><span className="s-stat">{n.st}</span>{n.time ? <span className="s-time">{n.time}</span> : null}</div>
                    <p className="s-sum">{n.sum}</p>
                  </div>
                ))}
              </div>
            </>
          )}
    </>
  );
}

/* ============================================================
   Team (wired to /auth/team, /auth/invite-member, /auth/team-member)
   ============================================================ */
function TeamView({ data, loading, error, notice, isAdmin, org, inviteEmail, setInviteEmail, inviting, onInvite, onRemove }) {
  const members = (data && data.members) || [];
  return (
    <>
      <div className="stub-head"><h1 className="page-title">Team</h1></div>
      <p className="page-sub">Members & pending invites for <b>{org}</b></p>
      {isAdmin ? (
        <div className="toolbar section-gap" data-admin-only="">
          <div className="search" style={{ maxWidth: 360 }}><span className="muted mono" style={{ fontSize: 12 }}>invite</span><input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') onInvite(); }} placeholder="teammate@org.com" /></div>
          <button className="btn indigo" onClick={onInvite} disabled={inviting}>{inviting ? 'Sending…' : 'Send invite'}</button>
        </div>
      ) : (
        <div className="ro-banner section-gap" style={{ marginTop: 18 }}><span className="led" style={{ background: 'var(--recv)' }} /> Read-only view — member role cannot invite or remove teammates.</div>
      )}
      {notice ? <div className="ro-banner section-gap" style={{ display: 'flex', marginTop: 14, background: 'var(--ok-bg)', borderColor: 'var(--ok-line)', color: 'var(--ok-ink)' }}><span className="led" style={{ background: 'var(--ok)' }} /> {notice}</div> : null}
      {error ? <div className="ro-banner section-gap" style={{ display: 'flex', marginTop: 14, background: 'var(--bad-bg)', borderColor: 'var(--bad-line)', color: 'var(--bad-ink)' }}><span className="led" style={{ background: 'var(--bad)' }} /> {error}</div> : null}
      <div className="queue section-gap" style={{ marginTop: 18 }}>
        <div className="qhead" style={{ gridTemplateColumns: '1.4fr 1.6fr 100px 110px 90px' }}><span>Member</span><span>Email</span><span>Role</span><span>Status</span><span /></div>
        {members.map((m) => (
          <div className="qrow" key={m.email} style={{ gridTemplateColumns: '1.4fr 1.6fr 100px 110px 90px', cursor: 'default' }}>
            <div className="pt"><span className="ava" style={{ display: 'inline-grid', width: 22, height: 22, borderRadius: '50%', background: 'var(--indigo)', color: '#fff', placeItems: 'center', fontFamily: 'var(--mono)', fontSize: 10, marginRight: 8, verticalAlign: 'middle' }}>{(m.name || m.email).split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase()}</span>{m.name}</div>
            <div className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>{m.email}</div>
            <div><span className="plan-tag">{m.role}</span></div>
            <div><span className={`pill ${m.status === 'active' ? 'approve' : 'escalate'}`}><span className="dot" />{m.status}</span></div>
            <div style={{ textAlign: 'right' }} data-admin-only="">{isAdmin && m.can_delete ? <button className="btn sm" onClick={() => onRemove(m.email)}>Remove</button> : null}</div>
          </div>
        ))}
        {!members.length && <div className="stub-empty" style={{ padding: '40px 24px' }}><div className="ph">⊞</div><h4>{loading ? 'Loading…' : 'No members yet'}</h4></div>}
      </div>
    </>
  );
}

/* ============================================================
   API Key (wired to /auth/api-key + generate/revoke)
   ============================================================ */
function ApiKeyView({ data, loading, error, notice, isAdmin, org, revealed, busy, onGenerate, onRevoke }) {
  const has = !!(data && data.has_api_key);
  return (
    <>
      <div className="stub-head"><h1 className="page-title">API Key</h1></div>
      <p className="page-sub">Credential the HMO uses to authenticate webhook deliveries · <b>{org}</b></p>
      {!isAdmin ? <div className="ro-banner section-gap" style={{ marginTop: 18 }}><span className="led" style={{ background: 'var(--recv)' }} /> Read-only view — only admins can generate or revoke keys.</div> : null}
      {notice ? <div className="ro-banner section-gap" style={{ display: 'flex', marginTop: 14, background: 'var(--ok-bg)', borderColor: 'var(--ok-line)', color: 'var(--ok-ink)' }}><span className="led" style={{ background: 'var(--ok)' }} /> {notice}</div> : null}
      {error ? <div className="ro-banner section-gap" style={{ display: 'flex', marginTop: 14, background: 'var(--bad-bg)', borderColor: 'var(--bad-line)', color: 'var(--bad-ink)' }}><span className="led" style={{ background: 'var(--bad)' }} /> {error}</div> : null}
      <div className="metric section-gap" style={{ maxWidth: 620, marginTop: 20 }}>
        <h3>{has || revealed ? 'Active key' : 'No active key'}</h3>
        <p className="desc">{revealed ? 'Copy this now — the full key will not be shown again.' : has ? 'Shown masked. The full key is displayed once, on generation.' : 'Generate a key to authenticate this org’s webhook deliveries.'}</p>
        {(revealed || has) ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, background: revealed ? 'var(--ok-bg)' : 'var(--bg-2)', border: `1px solid ${revealed ? 'var(--ok-line)' : 'var(--line)'}`, borderRadius: 9, padding: '13px 16px', fontFamily: 'var(--mono)', fontSize: 13 }}>
            <span style={{ flex: 1, wordBreak: 'break-all' }}>{revealed || data.masked_api_key || '••••••••••••'}</span>
            <span className={`pill ${revealed ? 'approve' : 'approve'}`}><span className="dot" />{revealed ? 'new' : 'active'}</span>
          </div>
        ) : null}
        {has && data.created_at ? <div className="muted mono" style={{ fontSize: 11.5, marginTop: 10 }}>Created {timeAgo(data.created_at)}</div> : null}
        {isAdmin ? (
          <div style={{ display: 'flex', gap: 10, marginTop: 18 }} data-admin-only="">
            <button className="btn" onClick={onGenerate} disabled={busy}>{busy ? 'Working…' : (has ? 'Regenerate (show once)' : 'Generate key')}</button>
            {has ? <button className="btn" style={{ color: 'var(--bad)', borderColor: 'var(--bad-line)' }} onClick={onRevoke} disabled={busy}>Revoke</button> : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

/* ============================================================
   Onboarding (SaaSPro super-admin: cross-org platform view)
   ============================================================ */
function OnboardingView({ data, loading, error, isSuperAdmin, orgName, setOrgName, adminEmail, setAdminEmail, onCreate, creating, created, createError, onResetCreate, onSelectOrg }) {
  if (!isSuperAdmin) {
    return (
      <>
        <div className="stub-head"><h1 className="page-title">Onboarding</h1></div>
        <p className="page-sub">Platform-only view.</p>
        <div className="stub-table section-gap"><div className="stub-empty"><div className="ph">🔒</div><h4>Not available</h4><p>Only admins of the SaaSPro platform org can onboard new client organizations.</p></div></div>
      </>
    );
  }
  const orgs = (data && data.orgs) || [];
  const totalMembers = orgs.reduce((a, o) => a + (o.members || 0), 0);
  const totalRequests = orgs.reduce((a, o) => a + (o.requests || 0), 0);
  const totalPending = orgs.reduce((a, o) => a + (o.pending_invites || 0), 0);
  return (
    <>
      <div className="stub-head"><h1 className="page-title">Onboarding</h1></div>
      <p className="page-sub">Manage client organizations · <span className="muted">platform-only view</span></p>
      <div className="kpi-strip section-gap" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <KpiTile label="Client organizations" val={orgs.length.toLocaleString()} sub={`${totalPending} pending invites`} />
        <KpiTile label="Total members" val={totalMembers.toLocaleString()} sub="across all orgs" />
        <KpiTile label="Total PA requests" val={totalRequests.toLocaleString()} sub="all-time" />
      </div>
      <div className="grid-2 section-gap">
        <div className="metric">
          <h3>Create a client organization</h3>
          <p className="desc">Spin up a new org and invite its first admin. They receive a registration link (email if Resend is configured).</p>
          <form onSubmit={(e) => { e.preventDefault(); onCreate(); }} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 14 }}>
            <label style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
              Organization name
              <div className="search"><input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Aman HMO" required /></div>
            </label>
            <label style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
              First admin email
              <div className="search"><input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@client.com" required /></div>
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn indigo" type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create org + invite admin'}</button>
              {created ? <button className="btn" type="button" onClick={onResetCreate}>New</button> : null}
            </div>
          </form>
          {createError ? <div className="ro-banner" style={{ display: 'flex', marginTop: 14, background: 'var(--bad-bg)', borderColor: 'var(--bad-line)', color: 'var(--bad-ink)' }}><span className="led" style={{ background: 'var(--bad)' }} /> {createError}</div> : null}
          {created ? (
            <div className="ro-banner" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, marginTop: 14, background: 'var(--ok-bg)', borderColor: 'var(--ok-line)', color: 'var(--ok-ink)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span className="led" style={{ background: 'var(--ok)' }} />Created <b style={{ marginLeft: 4 }}>{created.org.name}</b>{created.invite.email_sent ? '. Invite emailed to ' : '. Email not sent — share this invite link with '}<b style={{ marginLeft: 4 }}>{created.invite.email}</b>:</div>
              <div className="codeblock" style={{ width: '100%', fontSize: 11.5, padding: '10px 12px', wordBreak: 'break-all' }}>{created.invite.invite_link}</div>
            </div>
          ) : null}
        </div>
        <div className="metric">
          <h3>How this works</h3>
          <p className="desc">Members and admins live inside a single client org. SaaSPro super-admins (admins of the platform org) can spin up new client orgs and invite their first admin from here — no CLI required.</p>
          <ol style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.7, marginTop: 12, paddingLeft: 18 }}>
            <li>Create the org and the first admin's invite.</li>
            <li>The admin opens the link, sets a password, signs in.</li>
            <li>They invite their team and generate the webhook API key.</li>
          </ol>
        </div>
      </div>
      <div className="section-gap" style={{ marginTop: 30 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
          <h2 style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 500, margin: 0 }}>Client organizations</h2>
          <span className="muted mono" style={{ fontSize: 12 }}>{orgs.length} org{orgs.length === 1 ? '' : 's'}</span>
        </div>
        {error ? <div className="ro-banner" style={{ display: 'flex', background: 'var(--bad-bg)', borderColor: 'var(--bad-line)', color: 'var(--bad-ink)', marginBottom: 14 }}><span className="led" style={{ background: 'var(--bad)' }} /> {error}</div> : null}
        <div className="queue">
          <div className="qhead" style={{ gridTemplateColumns: '1.4fr 100px 110px 90px 100px 120px' }}>
            <span>Organization</span><span>Members</span><span>Pending</span><span>API keys</span><span>Requests</span><span>Last activity</span>
          </div>
          {orgs.map((o) => (
            <div className="qrow" key={o.id} onClick={() => onSelectOrg && onSelectOrg(o)} title="View this org's intake" style={{ gridTemplateColumns: '1.4fr 100px 110px 90px 100px 120px', cursor: onSelectOrg ? 'pointer' : 'default' }}>
              <div className="pt"><b>{o.name}</b><small>{o.is_active ? 'active' : 'disabled'}</small></div>
              <div className="mono" style={{ fontSize: 12 }}>{(o.members || 0).toLocaleString()}</div>
              <div>{o.pending_invites > 0 ? <span className="pill escalate"><span className="dot" />{o.pending_invites}</span> : <span className="muted mono" style={{ fontSize: 12 }}>—</span>}</div>
              <div className="mono" style={{ fontSize: 12 }}>{(o.api_keys || 0).toLocaleString()}</div>
              <div className="mono" style={{ fontSize: 12 }}>{(o.requests || 0).toLocaleString()}</div>
              <div className="muted mono" style={{ fontSize: 12 }}>{o.last_activity ? timeAgo(o.last_activity) : 'never'}</div>
            </div>
          ))}
          {!orgs.length && <div className="stub-empty" style={{ padding: '40px 24px' }}><div className="ph">⊞</div><h4>{loading ? 'Loading…' : 'No organizations yet'}</h4></div>}
        </div>
      </div>
    </>
  );
}

/* ============================================================
   Stub module views (IA placeholders — not yet wired to data)
   ============================================================ */
function StubChannel({ title, sub, cols, note }) {
  return (
    <>
      <div className="stub-head"><h1 className="page-title">{title}</h1><span className="stub-badge">Module preview</span></div>
      <p className="page-sub">{sub}</p>
      <div className="stub-table">
        <div className="sth" style={{ gridTemplateColumns: `repeat(${cols.length},1fr)` }}>{cols.map((c) => <span key={c}>{c}</span>)}</div>
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
        <div className="stub-table"><div className="stub-empty"><div className="ph">◴</div><h4>Delivery health view</h4><p>The backend already exposes delivery summary + per-attempt logs (auth, payload validity, duplicates, latency). This view will surface them.</p></div></div>
      </>
    );
  }
  if (id === 'audit') {
    return (
      <>
        <div className="stub-head"><h1 className="page-title">Audit Trail</h1><span className="stub-badge">Not yet wired</span></div>
        <p className="page-sub">Trace one event end-to-end: <span className="muted">delivery → stored request → agent decision</span></p>
        <div className="stub-table"><div className="stub-empty"><div className="ph">⛓</div><h4>End-to-end trace</h4><p>Backed by /auth/webhook-audit-trail — search an event_id, checkin_id, or request_id to follow it across the pipeline.</p></div></div>
      </>
    );
  }
  if (id === 'team') {
    return (
      <>
        <div className="stub-head"><h1 className="page-title">Team</h1><span className="stub-badge">Not yet wired</span></div>
        <p className="page-sub">Members & pending invites for <b>{org}</b></p>
        <div className="ro-banner section-gap" style={{ marginTop: 18 }}><span className="led" style={{ background: 'var(--recv)' }} /> Read-only view — member role cannot invite or remove teammates.</div>
        <div className="stub-table section-gap"><div className="stub-empty"><div className="ph">⊞</div><h4>Team management</h4><p>Backed by /auth/team, /auth/invite-member, /auth/team-member — list members, invite by email, remove.</p></div></div>
      </>
    );
  }
  if (id === 'apikey') {
    return (
      <>
        <div className="stub-head"><h1 className="page-title">API Key</h1><span className="stub-badge">Not yet wired</span></div>
        <p className="page-sub">Credential the HMO uses to authenticate webhook deliveries · <b>{org}</b></p>
        <div className="ro-banner section-gap" style={{ marginTop: 18 }}><span className="led" style={{ background: 'var(--recv)' }} /> Read-only view — only admins can generate or revoke keys.</div>
        <div className="stub-table section-gap"><div className="stub-empty"><div className="ph">🔑</div><h4>API key management</h4><p>Backed by /auth/api-key (generate / show-once / revoke). Used to onboard the client's webhook integration.</p></div></div>
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
   Icons
   ============================================================ */
const IconSearch = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--ink-3)' }}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
);
const IconCal = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>
);
const IconCopy = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></svg>
);
const IconExport = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" /></svg>
);

/* ============================================================
   Login
   ============================================================ */
function Login({ email, setEmail, password, setPassword, onSubmit, error, loading }) {
  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-2)', padding: 24 }}>
      <form onSubmit={onSubmit} style={{ width: 'min(380px, 100%)', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-card)', padding: '34px 30px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src="/saaspro-mark.png" alt="SaaSPro Labs" style={{ width: 40, height: 40, borderRadius: 9, display: 'block' }} />
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
        <button className="btn indigo" type="submit" disabled={loading} style={{ justifyContent: 'center' }}>{loading ? 'Signing in…' : 'Sign in'}</button>
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [activeNav, setActiveNav] = useState('intake');
  const [activeTab, setActiveTab] = useState('dashboard');
  const [role, setRole] = useState('admin');
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('saaspro-sidebar-collapsed') === '1'; } catch { return false; } });
  const toggleSidebar = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem('saaspro-sidebar-collapsed', n ? '1' : '0'); } catch (e) { /* ignore */ } return n; });
  const [lastLoaded, setLastLoaded] = useState(null);
  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState('');
  const [audit, setAudit] = useState(null);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState('');
  const [auditQuery, setAuditQuery] = useState('');
  const [team, setTeam] = useState(null);
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamError, setTeamError] = useState('');
  const [teamNotice, setTeamNotice] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [apikey, setApikey] = useState(null);
  const [apikeyError, setApikeyError] = useState('');
  const [apikeyNotice, setApikeyNotice] = useState('');
  const [apikeyBusy, setApikeyBusy] = useState(false);
  const [revealedKey, setRevealedKey] = useState('');
  const [orgs, setOrgs] = useState(null);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [orgsError, setOrgsError] = useState('');
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgAdminEmail, setNewOrgAdminEmail] = useState('');
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [createdOrg, setCreatedOrg] = useState(null);
  const [createOrgError, setCreateOrgError] = useState('');
  const [viewOrgId, setViewOrgId] = useState(null); // { id, name } when a super-admin is drilled into another org

  useEffect(() => { document.body.dataset.layout = 'report'; return () => { delete document.body.dataset.layout; }; }, []);
  useEffect(() => { document.body.classList.toggle('role-member', role === 'member'); }, [role]);
  useEffect(() => { if (session) setRole(session.role || 'admin'); }, [session]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function apiRequest(path, options = {}) {
    const headers = {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
      ...(options.headers || {}),
    };
    const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
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
      const path = '/auth/preauth-dashboard' + (viewOrgId ? `?org_id=${viewOrgId.id}` : '');
      const data = await apiRequest(path);
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

  async function loadHealth() {
    if (!session?.token) return;
    setHealthLoading(true);
    setHealthError('');
    try {
      const data = await apiRequest('/auth/webhook-delivery-logs');
      setHealth(data);
    } catch (err) {
      setHealthError(err.message || 'Could not load delivery logs');
    } finally {
      setHealthLoading(false);
    }
  }

  async function loadAudit(q) {
    if (!session?.token) return;
    setAuditLoading(true);
    setAuditError('');
    try {
      const params = new URLSearchParams();
      const v = (q ?? auditQuery).trim();
      if (v) { if (v.includes('/')) params.set('checkin_id', v); else params.set('request_id', v); }
      const data = await apiRequest(`/auth/webhook-audit-trail?${params.toString()}`);
      setAudit(data);
    } catch (err) { setAuditError(err.message || 'Could not load audit trail'); }
    finally { setAuditLoading(false); }
  }
  async function loadTeam() {
    if (!session?.token) return;
    setTeamLoading(true);
    setTeamError('');
    try { setTeam(await apiRequest('/auth/team')); }
    catch (err) { setTeamError(err.message || 'Could not load team'); }
    finally { setTeamLoading(false); }
  }
  async function inviteMember() {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviting(true); setTeamError(''); setTeamNotice('');
    try {
      const res = await apiRequest('/auth/invite-member', { method: 'POST', body: { email } });
      setTeamNotice(res.message || `Invite created for ${email}`);
      setInviteEmail('');
      await loadTeam();
    } catch (err) { setTeamError(err.message || 'Invite failed'); }
    finally { setInviting(false); }
  }
  async function removeMember(email) {
    setTeamError(''); setTeamNotice('');
    try {
      const res = await apiRequest(`/auth/team-member/${encodeURIComponent(email)}`, { method: 'DELETE' });
      setTeamNotice(res.message || `Removed ${email}`);
      await loadTeam();
    } catch (err) { setTeamError(err.message || 'Remove failed'); }
  }
  async function loadApiKey() {
    if (!session?.token) return;
    setApikeyError('');
    try { setApikey(await apiRequest('/auth/api-key')); }
    catch (err) { setApikeyError(err.message || 'Could not load API key'); }
  }
  async function generateKey() {
    setApikeyBusy(true); setApikeyError(''); setApikeyNotice('');
    try {
      const res = await apiRequest('/auth/api-key/generate', { method: 'POST' });
      setRevealedKey(res.api_key || '');
      setApikeyNotice(res.message || 'API key generated');
      await loadApiKey();
    } catch (err) { setApikeyError(err.message || 'Generate failed'); }
    finally { setApikeyBusy(false); }
  }
  async function revokeKey() {
    setApikeyBusy(true); setApikeyError(''); setApikeyNotice(''); setRevealedKey('');
    try {
      const res = await apiRequest('/auth/api-key', { method: 'DELETE' });
      setApikeyNotice(res.message || 'API key revoked');
      await loadApiKey();
    } catch (err) { setApikeyError(err.message || 'Revoke failed'); }
    finally { setApikeyBusy(false); }
  }

  async function loadOrgs() {
    if (!session?.token) return;
    setOrgsLoading(true);
    setOrgsError('');
    try { setOrgs(await apiRequest('/auth/onboarding/orgs')); }
    catch (err) { setOrgsError(err.message || 'Could not load organizations'); }
    finally { setOrgsLoading(false); }
  }
  async function createOrg() {
    const name = newOrgName.trim();
    const email = newOrgAdminEmail.trim();
    if (!name || !email) return;
    setCreatingOrg(true);
    setCreateOrgError('');
    setCreatedOrg(null);
    try {
      const data = await apiRequest('/auth/onboarding/create-org', { method: 'POST', body: { org_name: name, admin_email: email } });
      setCreatedOrg(data);
      setNewOrgName('');
      setNewOrgAdminEmail('');
      await loadOrgs();
    } catch (err) { setCreateOrgError(err.message || 'Create failed'); }
    finally { setCreatingOrg(false); }
  }
  function resetCreateOrg() { setCreatedOrg(null); setCreateOrgError(''); }

  function signOut() {
    localStorage.removeItem(STORAGE_KEY);
    setSession(null);
    setDashboard(null);
    setSelectedId('');
    setDrawerOpen(false);
    setViewOrgId(null);
  }
  function exitViewAs() {
    setViewOrgId(null);
    setActiveNav('onboarding');
    setSelectedId('');
    setDrawerOpen(false);
    setDashboard(null);
  }

  useEffect(() => { if (session?.token) loadDashboard(); /* eslint-disable-next-line */ }, [session?.token, viewOrgId]);
  useEffect(() => {
    if (!session?.token) return undefined;
    const t = setInterval(() => loadDashboard({ silent: true }), 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [session?.token, viewOrgId]);

  useEffect(() => {
    if (!session?.token) return;
    if (activeNav === 'health' && !health) loadHealth();
    if (activeNav === 'audit' && !audit) loadAudit('');
    if (activeNav === 'team' && !team) loadTeam();
    if (activeNav === 'apikey' && !apikey) loadApiKey();
    if (activeNav === 'onboarding' && !orgs) loadOrgs();
    // eslint-disable-next-line
  }, [session?.token, activeNav]);

  const rawRequests = dashboard?.requests || [];
  const summary = dashboard?.summary || {};
  const series = dashboard?.series || [];
  const requests = useMemo(() => rawRequests.map(mapRequest), [rawRequests]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return requests.filter((r) => {
      const okS = statusFilter === 'all' || r.status === statusFilter;
      const blob = [r.display_request_id, r.patient_name, r.patient_id, r.plan, r.item_description, r.facility, r.requesting_provider, r.decision].filter(Boolean).join(' ').toLowerCase();
      return okS && (!q || blob.includes(q));
    });
  }, [requests, query, statusFilter]);

  const selected = requests.find((r) => r.request_id === selectedId) || null;

  function openRequest(id) { setSelectedId(id); setDrawerOpen(true); }

  if (!session) {
    return <Login email={email} setEmail={setEmail} password={password} setPassword={setPassword} onSubmit={handleLogin} error={loginError} loading={loginLoading} />;
  }

  const refreshedLabel = loading ? 'Refreshing…' : (lastLoaded ? `Refreshed ${timeAgo(new Date(lastLoaded).toISOString())}` : 'Connecting…');
  const isSuperAdmin = (session.role === 'admin') && ((session.org_name || '').toUpperCase() === 'SAASPRO');
  const statusFilters = ['all', 'approve', 'deny', 'escalate', 'processing', 'pending', 'received', 'error'];

  // chart inputs from the real daily series + summary
  const dayLabels = series.map((d) => d.day.slice(5));
  const recvSeries = series.map((d) => d.received);
  const latSeries = series.map((d) => d.avg_latency);
  const valSeries = series.map((d) => d.approved_value);
  const decided = (summary.approved || 0) + (summary.denied || 0) + (summary.escalated || 0);
  const approvalRate = decided ? Math.round((summary.approved / decided) * 100) : 0;
  const outcomeSplit = [
    { k: 'Approved', v: summary.approved || 0, c: 'var(--ok)' },
    { k: 'Denied', v: summary.denied || 0, c: 'var(--bad)' },
    { k: 'Escalated', v: summary.escalated || 0, c: 'var(--warn)' },
    { k: 'Pending', v: (summary.pending || 0) + (summary.processing || 0), c: 'var(--ink-4)' },
  ];
  const avgLatTxt = summary.avg_processing_seconds != null ? Number(summary.avg_processing_seconds).toFixed(1) : '—';

  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      <StatusBar session={session} role={role} onRole={setRole} refreshedLabel={refreshedLabel} />
      <Sidebar active={activeNav} onNav={(id) => { setActiveNav(id); setDrawerOpen(false); setRevealedKey(''); setApikeyNotice(''); setTeamNotice(''); }} session={session} intakeCount={summary.received_24h ?? 0} collapsed={collapsed} onToggleCollapse={toggleSidebar} isSuperAdmin={isSuperAdmin} onSignOut={signOut} />

      <main className="main">
        {activeNav === 'intake' ? (
          <section id="view-intake">
            {viewOrgId ? (
              <div className="ro-banner" style={{ display: 'flex', alignItems: 'center', marginBottom: 14, background: 'var(--tint)', borderColor: 'var(--indigo-soft)', color: 'var(--indigo)' }}>
                <span className="led" style={{ background: 'var(--indigo)' }} />
                Viewing as super-admin · Pre-Auth Intake scoped to <b style={{ marginLeft: 4 }}>{viewOrgId.name}</b>
                <button className="btn sm" onClick={exitViewAs} style={{ marginLeft: 'auto' }}>← Back to platform view</button>
              </div>
            ) : null}
            <div className="ro-banner"><span className="led" style={{ background: 'var(--recv)' }} /> Read-only view — you're signed in as a member. Operational data is visible; actions are disabled.</div>

            <div className="page-head">
              <div>
                <h1 className="page-title">Pre-Authorization</h1>
                <p className="page-sub">
                  <span className="cal" aria-hidden="true"><IconCal /></span>
                  Live · {summary.total ?? requests.length} requests this period
                </p>
              </div>
              <div className="page-actions">
                <button className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => loadDashboard()}><IconCopy /></button>
                <button className="btn primary" data-admin-only="">Export report <IconExport /></button>
              </div>
            </div>

            <div className="tabs">
              <button className={activeTab === 'dashboard' ? 'on' : ''} onClick={() => setActiveTab('dashboard')}>Dashboard</button>
              <button className={activeTab === 'chat' ? 'on' : ''} onClick={() => setActiveTab('chat')}>Chat</button>
            </div>

            {activeTab === 'dashboard' ? (
              <div id="tab-dashboard">
                <div className="grid-2 section-gap" style={{ marginTop: 24 }}>
                  <MetricCard
                    title="Requests received"
                    desc="Inbound pre-auth volume across the period"
                    big={`${summary.received_24h ?? 0} <small>last 24h</small>`}
                    chartHtml={chartBars(recvSeries, { accent: 'var(--ink-3)', labels: dayLabels })}
                    moveH="Inbound volume"
                    moveP={`${summary.total ?? 0} requests this period. ${summary.processing ?? 0} processing and ${summary.pending ?? 0} pending a first decision.`}
                  />
                  <MetricCard
                    title="Decision outcomes"
                    desc="How the AI pipeline resolved this period's requests"
                    chartHtml={chartDonut(outcomeSplit)}
                    moveH={`${approvalRate}% approval rate`}
                    moveP={`${(summary.approved ?? 0).toLocaleString()} approved, ${summary.denied ?? 0} denied, ${summary.escalated ?? 0} escalated for human review.`}
                  />
                  <MetricCard
                    title="Decision latency"
                    desc="Time from received → decided"
                    big={`${avgLatTxt}<small>s avg</small>`}
                    chartHtml={chartLine(latSeries, { accent: 'var(--indigo)', suffix: 's' })}
                    moveH="Seconds, not minutes"
                    moveP={`Average decision latency is ${avgLatTxt}s versus a ~30-minute manual baseline.`}
                  />
                  <MetricCard
                    title="PA value approved"
                    desc="Total authorized value (NGN)"
                    big={fmtNGN(summary.total_amount_approved ?? 0)}
                    chartHtml={chartLine(valSeries, { accent: 'var(--ok)', prefix: '₦' })}
                    moveH={`${fmtNGN(summary.total_amount_approved ?? 0)} authorized`}
                    moveP="Authorized value across approved requests this period."
                  />
                </div>

                <div className="section-gap" style={{ marginTop: 34 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
                    <h2 style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 500, margin: 0 }}>Request queue</h2>
                    <span className="muted mono" style={{ fontSize: 12 }}>{filtered.length} request{filtered.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="toolbar" style={{ marginBottom: 14 }}>
                    <div className="search">
                      <IconSearch />
                      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search reference, patient, provider, plan, item, facility…" />
                    </div>
                    {statusFilters.map((s) => (
                      <button key={s} className={`statbtn ${statusFilter === s ? 'on' : ''}`} onClick={() => setStatusFilter(s)}>{s === 'all' ? 'All' : (STATUS_META[s]?.label || s)}</button>
                    ))}
                  </div>
                  <div className="queue">
                    <QueueHead />
                    <div>
                      {filtered.map((r) => (
                        <QueueRow key={r.request_id} r={r} selected={selected?.request_id === r.request_id && drawerOpen} onSelect={openRequest} />
                      ))}
                      {!filtered.length && (
                        <div className="stub-empty" style={{ padding: '60px 24px' }}>
                          <div className="ph">▤</div><h4>No requests</h4>
                          <p>{error ? error : 'Incoming webhook requests will appear here after processing.'}</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div id="tab-chat" style={{ marginTop: 30 }}>
                <div className="metric" style={{ maxWidth: 760 }}>
                  <h3>Ask about this report</h3>
                  <p className="desc">The assistant answers from this period's pre-auth queue and summary — decisions, denials, escalations, latency, value.</p>
                  <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>Try asking</div>
                    <div className="suggests" style={{ padding: 0 }}>
                      <button type="button">Why were requests escalated this period?</button>
                      <button type="button">Which denials were due to eligibility?</button>
                      <button type="button">What's the total approved value and biggest single request?</button>
                    </div>
                    <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>Type your question in the bar at the bottom of the screen.</p>
                  </div>
                </div>
              </div>
            )}
          </section>
        ) : (
          <section id="view-stub" style={{ paddingBottom: 120 }}>
            {activeNav === 'health' ? <HealthView data={health} loading={healthLoading} error={healthError} org={session.org_name} />
              : activeNav === 'audit' ? <AuditView data={audit} loading={auditLoading} error={auditError} query={auditQuery} setQuery={setAuditQuery} onTrace={() => loadAudit()} />
              : activeNav === 'team' ? <TeamView data={team} loading={teamLoading} error={teamError} notice={teamNotice} isAdmin={role === 'admin'} org={session.org_name} inviteEmail={inviteEmail} setInviteEmail={setInviteEmail} inviting={inviting} onInvite={inviteMember} onRemove={removeMember} />
              : activeNav === 'apikey' ? <ApiKeyView data={apikey} error={apikeyError} notice={apikeyNotice} isAdmin={role === 'admin'} org={session.org_name} revealed={revealedKey} busy={apikeyBusy} onGenerate={generateKey} onRevoke={revokeKey} />
              : activeNav === 'onboarding' ? <OnboardingView data={orgs} loading={orgsLoading} error={orgsError} isSuperAdmin={isSuperAdmin} orgName={newOrgName} setOrgName={setNewOrgName} adminEmail={newOrgAdminEmail} setAdminEmail={setNewOrgAdminEmail} onCreate={createOrg} creating={creatingOrg} created={createdOrg} createError={createOrgError} onResetCreate={resetCreateOrg} onSelectOrg={(o) => { setViewOrgId({ id: o.id, name: o.name }); setActiveNav('intake'); setSelectedId(''); setDrawerOpen(false); setDashboard(null); }} />
              : <StubView id={activeNav} session={session} />}
          </section>
        )}
      </main>

      <AskBar context={activeNav === 'intake' ? 'this queue' : 'this view'} />
      <Drawer request={selected} open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}
