import React, { useEffect, useMemo, useState, createContext, useContext, useCallback, useRef } from 'react';
import { AlertTriangle, CheckCircle2, Radio, RefreshCw, Unplug } from 'lucide-react';
import { PatientReportSheet } from './report.jsx';

const STORAGE_KEY = 'saaspro-preauth-dashboard-session';
const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000');

function normalizeApiBaseUrl(value) {
  const t = String(value || '').trim();
  if (!t) return 'http://localhost:8000';
  const w = /^https?:\/\//i.test(t) ? t : `http://${t}`;
  return w.replace(/\/+$/, '');
}
function isInviteRegistrationRoute() {
  const params = new URLSearchParams(window.location.search);
  return window.location.pathname === '/register' || params.has('token');
}
function replaceBrowserPath(path) {
  window.history.replaceState({}, '', path);
}
async function publicApiRequest(path, options = {}) {
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
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
function todayDateInputValue(timeZone = 'Africa/Lagos') {
  return dateInputValueFromDate(new Date(), timeZone);
}
function dateInputValueFromDate(date, timeZone = 'Africa/Lagos') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function dateInputValueDaysAgo(daysAgo, timeZone = 'Africa/Lagos') {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return dateInputValueFromDate(date, timeZone);
}
function formatDateRangeLabel(from, to) {
  if (!from && !to) return 'All time';
  const dateFor = (value) => {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const aDate = dateFor(from);
  const bDate = dateFor(to);
  const full = (date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const short = (date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (!aDate && !bDate) return from || to || 'All time';
  if (aDate && bDate && from === to) return full(aDate);
  if (aDate && bDate && aDate.getFullYear() === bDate.getFullYear()) return `${short(aDate)} - ${full(bDate)}`;
  if (aDate && bDate) return `${full(aDate)} - ${full(bDate)}`;
  if (aDate) return `${full(aDate)} - today`;
  return `Until ${full(bDate)}`;
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
  approve: { label: 'Approve', cls: 'approve', help: 'Agent decided to authorize the request.' },
  deny: { label: 'Deny', cls: 'deny', help: 'Agent refused the request — usually exclusion, limit exceeded, or eligibility issue.' },
  escalate: { label: 'Escalate', cls: 'escalate', help: 'Agent flagged for human review — high cost, ambiguous, or missing data.' },
  pending: { label: 'Pending', cls: 'pending', help: 'Received but not yet picked up. Awaiting an agent run.' },
  processing: { label: 'Processing', cls: 'processing', help: 'Pipeline is mid-run. Should resolve within seconds.' },
  received: { label: 'Received', cls: 'received', help: 'Live HMO payload captured. Decisioning paused pending mapping validation.' },
  error: { label: 'Error', cls: 'error', help: 'Pipeline crashed before deciding. See the request drawer for the error message.' },
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
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function formatChartValue(value, { prefix = '', suffix = '' } = {}) {
  const n = Number(value || 0);
  const formatted = Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return `${prefix}${formatted}${suffix}`;
}
function chartTooltip(label, value, x, y, { w = 560, padRight = 8, prefix = '', suffix = '' } = {}) {
  const tipW = 142;
  const tipH = 38;
  const tipX = Math.max(8, Math.min(w - padRight - tipW, x - tipW / 2));
  const tipY = Math.max(6, y - tipH - 10);
  return `
    <g class="chart-tooltip" transform="translate(${tipX.toFixed(1)} ${tipY.toFixed(1)})">
      <rect width="${tipW}" height="${tipH}" rx="7" fill="var(--ink)" opacity="0.96"/>
      <text x="10" y="16" font-family="var(--mono)" font-size="11" font-weight="600" fill="#fff">${escapeHtml(formatChartValue(value, { prefix, suffix }))}</text>
      <text x="10" y="30" font-family="var(--mono)" font-size="9.5" fill="rgba(255,255,255,.72)">${escapeHtml(label)}</text>
    </g>
  `;
}

/* ============================================================
   SVG chart builders (ported from the prototype, return HTML strings)
   ============================================================ */
function chartBars(data, { w = 560, h = 200, max = null, accent = 'var(--ink-3)', labels = null, tooltipLabels = null, prefix = '', suffix = '' } = {}) {
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
    const label = tooltipLabels?.[i] || labels?.[i] || `Point ${i + 1}`;
    const cx = x + barW / 2;
    bars += `<g class="chart-hit"><rect class="chart-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${accent}"/><rect x="${(pad.l + i * bw).toFixed(1)}" y="${pad.t}" width="${bw.toFixed(1)}" height="${ih.toFixed(1)}" fill="transparent" pointer-events="all"/>${chartTooltip(label, v, cx, y, { w, padRight: pad.r, prefix, suffix })}</g>`;
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
    const idx = labels.length <= 1 ? 0 : Math.round((data.length - 1) * (i / (labels.length - 1)));
    const x = pad.l + idx * bw + bw / 2;
    xlab += `<text x="${x.toFixed(1)}" y="${h - 5}" text-anchor="middle" font-family="var(--mono)" font-size="9.5" fill="var(--ink-4)">${l}</text>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="none" style="display:block">${grid}${bars}${ylab}${xlab}</svg>`;
}
function chartLine(data, { w = 560, h = 200, accent = 'var(--indigo)', fill = true, labels = null, tooltipLabels = null, prefix = '', suffix = '' } = {}) {
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
    const idx = labels.length <= 1 ? 0 : Math.round((data.length - 1) * (i / (labels.length - 1)));
    xlab += `<text x="${xs(idx).toFixed(1)}" y="${h - 5}" text-anchor="middle" font-family="var(--mono)" font-size="9.5" fill="var(--ink-4)">${l}</text>`;
  });
  const gid = 'g' + Math.random().toString(36).slice(2, 7);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="none" style="display:block">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity="0.16"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient></defs>
    ${grid}${fill ? `<path d="${area}" fill="url(#${gid})"/>` : ''}
    <path d="${d}" fill="none" stroke="${accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${data.map((v, i) => {
    const label = tooltipLabels?.[i] || labels?.[i] || `Point ${i + 1}`;
    const hitW = i === 0 || i === data.length - 1 ? Math.max(20, iw / (data.length - 1) / 2) : Math.max(24, iw / (data.length - 1));
    return `<g class="chart-hit"><rect x="${(xs(i) - hitW / 2).toFixed(1)}" y="${pad.t}" width="${hitW.toFixed(1)}" height="${ih.toFixed(1)}" fill="transparent" pointer-events="all"/><circle class="chart-point" cx="${xs(i).toFixed(1)}" cy="${ys(v).toFixed(1)}" r="${i === data.length - 1 ? '3.5' : '2.5'}" fill="${accent}" opacity="${i === data.length - 1 ? '1' : '0.55'}"/>${chartTooltip(label, v, xs(i), ys(v), { w, padRight: pad.r, prefix, suffix })}</g>`;
  }).join('')}
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

// ── PA event-timeline helpers (ported from origin/main / kalycoding) ──────
// His /auth/preauth-events endpoint returns one row per intake webhook for
// a single check-in. These helpers normalize the fields his payloads carry.
function _evtNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function eventValue(event) { return _evtNum(event?.items_added_total) ?? _evtNum(event?.total_requested_cost) ?? 0; }
function eventItemCount(event) { return _evtNum(event?.items_added_count) ?? _evtNum(event?.item_count) ?? 0; }
const AMAN_CATEGORY_LABELS = {
  1: 'Drugs and consumables',
  2: 'Services and procedures',
  3: 'Laboratory investigations',
  4: 'Radiological investigations',
  5: 'Dental care',
  6: 'Optical care',
  7: 'Immunization and vaccine',
  8: 'Wellness',
};
const AMAN_CARE_TYPE_LABELS = {
  1: 'Inpatient',
  2: 'Outpatient',
  3: 'Antenatal',
  4: 'Dental Care',
  5: 'Optical care',
  6: 'Telemedicine',
  7: 'Wellness',
};
function amanMappedLabel(map, value) {
  const n = _evtNum(value);
  return n == null ? null : map[n] || null;
}
function categoryLabel(value) {
  if (value == null || value === '') return null;
  const label = amanMappedLabel(AMAN_CATEGORY_LABELS, value);
  return label ? `${label} (#${value})` : `#${value}`;
}
function careTypeLabel(value) {
  return amanMappedLabel(AMAN_CARE_TYPE_LABELS, value);
}
function closeNumberMatch(a, b) {
  const x = _evtNum(a); const y = _evtNum(b);
  return x !== null && y !== null && Math.abs(x - y) < 0.01;
}
function itemRequestedCost(it) {
  const direct = _evtNum(it?.requested_cost) ?? _evtNum(it?.estimated_cost) ?? _evtNum(it?.cost) ?? _evtNum(it?.amount);
  if (direct != null && direct) return direct;
  const u = _evtNum(it?.unit_cost); const q = _evtNum(it?.quantity) || 1;
  return u != null ? u * q : 0;
}
function eventItemId(event, it, idx) {
  return it?.claim_item_id || it?.facility_tariff_item_id || it?.id || `${event?.event_id || 'event'}-${idx}`;
}
function normalizeEventItem(event, it, idx) {
  return {
    id: eventItemId(event, it, idx),
    name: it?.item_name || it?.description || it?.name || `Item ${it?.id || idx + 1}`,
    quantity: it?.quantity ?? 1,
    requested_cost: itemRequestedCost(it),
    unit_cost: _evtNum(it?.unit_cost),
    approved_cost: it?.approved_cost ?? null,
    unit_approved_cost: it?.unit_approved_cost ?? null,
    item_status: it?.status ?? it?.claim_item_status ?? null,
    item_status_label: it?.item_status_label || null,
    pricing_source: it?.pricing_source || null,
    category_id: it?.category_id ?? null,
    category_label: it?.category_label || categoryLabel(it?.category_id),
    claim_item_id: it?.claim_item_id ?? null,
    tariff_id: it?.facility_tariff_item_id ?? null,
    flags: it?.flags || null,
    raw: it,
  };
}
function eventSnapshotItems(event) {
  const payload = asObj(event?.raw_payload);
  const extracted = asObj(event?.extracted_fields);
  const pa = asArr(payload?.pa_items).length
    ? asArr(payload?.pa_items)
    : asArr(extracted?.items).length
      ? asArr(extracted.items)
      : asArr(extracted?.requested_items);
  return pa.map((it, idx) => normalizeEventItem(event, it, idx));
}
function stableEventItemKey(it) {
  if (it?.id != null && /^\d+$/.test(String(it.id))) return `id:${it.id}`;
  return [
    String(it?.name || '').toLowerCase().replace(/\s+/g, ' ').trim(),
    _evtNum(it?.quantity) ?? '',
    (_evtNum(it?.requested_cost) ?? 0).toFixed(2),
  ].join('|');
}
function itemsAddedFromEvent(event) {
  const payload = asObj(event?.raw_payload);
  const added = asArr(payload?.submission?.items_added);
  const pa = asArr(payload?.pa_items).length ? asArr(payload?.pa_items) : asArr(asObj(event?.extracted_fields)?.items);
  const used = new Set();
  if (added.length) {
    return added.map((it, idx) => {
      const id = it?.id;
      const candidate = pa
        .map((p, pi) => ({ p, pi }))
        .filter(({ p, pi }) => {
          const key = p?.claim_item_id || `${p?.facility_tariff_item_id || 'item'}-${pi}`;
          if (used.has(key)) return false;
          const qm = closeNumberMatch(p?.quantity, it?.quantity);
          const am = closeNumberMatch(p?.requested_cost, it?.requested_cost);
          return (
            String(p?.facility_tariff_item_id || '') === String(id || '') ||
            String(p?.claim_item_id || '') === String(id || '') ||
            (qm && am) ||
            (pi === idx && added.length === pa.length)
          );
        })
        .sort((l, r) => {
          const score = ({ p, pi }) => {
            const idMatch = String(p?.facility_tariff_item_id || '') === String(id || '') || String(p?.claim_item_id || '') === String(id || '');
            const qm = closeNumberMatch(p?.quantity, it?.quantity);
            const am = closeNumberMatch(p?.requested_cost, it?.requested_cost);
            const om = pi === idx && added.length === pa.length;
            const pen = String(p?.status || '').toLowerCase() === 'pending';
            if (idMatch && qm && am && pen) return 0;
            if (idMatch && qm && am) return 1;
            if (qm && am && om && pen) return 2;
            if (qm && am && om) return 3;
            if (qm && am && pen) return 4;
            if (qm && am) return 5;
            if (om && pen) return 6;
            if (om) return 7;
            return 8;
          };
          return score(l) - score(r);
        });
      const m = candidate[0]?.p;
      const key = m?.claim_item_id || (m ? `${m?.facility_tariff_item_id || 'item'}-${candidate[0]?.pi}` : null);
      if (key) used.add(key);
      return {
        id: m?.claim_item_id || m?.facility_tariff_item_id || `${event?.event_id || 'event'}-${idx}-${id || 'item'}`,
        name: m?.item_name || m?.description || m?.name || `Item ${id || idx + 1}`,
        quantity: it?.quantity ?? m?.quantity ?? 1,
        requested_cost: _evtNum(it?.requested_cost) ?? itemRequestedCost(m || it),
        unit_cost: _evtNum(m?.unit_cost),
        approved_cost: m?.approved_cost ?? null,
        unit_approved_cost: m?.unit_approved_cost ?? null,
        item_status: m?.status ?? m?.claim_item_status ?? null,
        item_status_label: m?.item_status_label || null,
        pricing_source: m?.pricing_source || null,
        category_id: m?.category_id ?? it?.category_id ?? null,
        category_label: m?.category_label || categoryLabel(m?.category_id ?? it?.category_id),
        claim_item_id: m?.claim_item_id ?? null,
        tariff_id: m?.facility_tariff_item_id ?? id ?? null,
        flags: m?.flags || null,
        raw: m || it,
      };
    });
  }
  return pa.map((it, idx) => normalizeEventItem(event, it, idx));
}
function existingItemsFromFirstEvent(event) {
  const payload = asObj(event?.raw_payload);
  const addedRaw = asArr(payload?.submission?.items_added);
  if (!addedRaw.length) return [];
  const snapshot = eventSnapshotItems(event);
  if (!snapshot.length || snapshot.length <= addedRaw.length) return [];
  const addedKeys = new Set(itemsAddedFromEvent(event).map(stableEventItemKey));
  return snapshot.filter((it) => !addedKeys.has(stableEventItemKey(it)));
}
function eventItemsTotal(items) {
  return asArr(items).reduce((sum, it) => sum + (_evtNum(it?.requested_cost) ?? 0), 0);
}
function itemStatusInfo(it) {
  const raw = it?.item_status_label || it?.item_status;
  const s = String(raw ?? '').trim().toLowerCase();
  const approved = _evtNum(it?.approved_cost);
  const unitApproved = _evtNum(it?.unit_approved_cost);
  if (['approved', 'approve', '1'].includes(s) || (!s && ((approved != null && approved > 0) || (unitApproved != null && unitApproved > 0)))) {
    return { label: 'approved', bg: 'var(--ok-bg)', ink: 'var(--ok-ink)', line: 'var(--ok-line)' };
  }
  if (['rejected', 'reject', 'denied', 'deny', '3'].includes(s)) {
    return { label: 'rejected', bg: 'var(--bad-bg)', ink: 'var(--bad-ink)', line: 'var(--bad-line)' };
  }
  if (['queried', 'query', '2'].includes(s)) {
    return { label: 'queried', bg: 'var(--warn-bg)', ink: 'var(--warn-ink)', line: 'var(--warn-line)' };
  }
  if (['pending', '0'].includes(s)) {
    return { label: 'pending', bg: 'var(--slate-bg)', ink: 'var(--slate-ink)', line: 'var(--slate-line)' };
  }
  if (s) {
    return { label: s, bg: 'var(--bg-3)', ink: 'var(--ink-2)', line: 'var(--line-2)' };
  }
  return null;
}
function ItemStatusBadge({ item }) {
  const meta = itemStatusInfo(item);
  if (!meta) return null;
  return (
    <span
      data-tip="Item status from AMAN's PA payload."
      style={{
        background: meta.bg,
        color: meta.ink,
        border: `1px solid ${meta.line}`,
        padding: '1px 7px',
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 600,
        textTransform: 'uppercase',
        fontFamily: 'var(--mono)',
        whiteSpace: 'nowrap',
      }}
    >
      {meta.label}
    </span>
  );
}
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
  return asArr(list).map((it) => {
    const itm = asObj(it);
    return {
      name: itm.item_name || itm.description || itm.name || 'Item',
      qty: Number(itm.quantity) || 1,
      unit: Number(itm.unit_cost ?? itm.requested_cost ?? itm.cost ?? 0) || 0,
      item_status: itm.status ?? itm.claim_item_status ?? null,
      item_status_label: itm.item_status_label || null,
      requested_cost: itm.requested_cost ?? null,
      approved_cost: itm.approved_cost ?? null,
      unit_approved_cost: itm.unit_approved_cost ?? null,
      pricing_source: itm.pricing_source || null,
      category_id: itm.category_id ?? null,
      category_label: itm.category_label || categoryLabel(itm.category_id),
      claim_item_id: itm.claim_item_id ?? null,
      tariff_id: itm.facility_tariff_item_id ?? null,
      type: itm.type || itm.category || null,
      code: itm.code || itm.service_code || itm.cpt || null,
      facility: itm.facility || itm.facility_name || null,
      provider: itm.requesting_provider || itm.provider || null,
      diagnosis: itm.diagnosis || itm.indication || null,
      flags: itm.flags || null,
      raw: itm,
    };
  });
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
const STAGE_TIPS = {
  Eligibility: 'Is the member valid — active, not expired, within age limit, enrollment valid?',
  'Plan & Coverage': 'Is each requested item covered, excluded, or in a waiting period?',
  'Utilization & Limits': 'Does this PA fit under the patient’s bucket limit and annual cap?',
  'Final Decision': 'Aggregates stages 1–3 into APPROVE / DENY / ESCALATE plus an approved amount.',
};
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
      logged_at: l.logged_at,
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
      out.push({ n: i, name: STAGE_NAMES[i], status, time: '', logged_at: null, result: o });
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
    checkin_type: enc.checkin_type || careTypeLabel(enc.care_type) || '—',
    reason: r.reason || ar.reasoning || ar.denial_reason || ar.escalation_reason || '',
    error_message: r.error_message,
    flags: asArr(ar.flags),
    items,
    note: isLive ? 'Live HMO payload received. Automated decisioning is paused pending mapping validation for this corporation.' : '',
    stages: deriveStages(r),
    raw_payload: r.raw_payload,
    extracted_fields: r.extracted_fields,
    patient_pa_count: r.patient_pa_count || 0,
    coverage: (() => {
      const ag2 = asObj(asObj(r.agent_result).agent2);
      if (!ag2 || (!ag2.covered_items && !ag2.denied_items)) return null;
      return {
        covered: asArr(ag2.covered_items).map(String),
        denied: asArr(ag2.denied_items).map(String),
        reason: ag2.reason || null,
        exclusion_detail: ag2.exclusion_detail || null,
        plan_restriction_detail: ag2.plan_restriction_detail || null,
        waiting_period_detail: ag2.waiting_period_detail || null,
      };
    })(),
  };
}

function timestampMs(value) {
  if (!value) return null;
  const d = new Date(parseApiDate(value));
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}
function eventTimeMs(event) {
  return timestampMs(event?.submitted_at || event?.occurred_at || event?.created_at || event?.first_seen_at);
}
function splitStageRuns(stages) {
  const ordered = asArr(stages)
    .map((stage, idx) => ({ ...stage, _idx: idx, _ts: timestampMs(stage.logged_at) }))
    .sort((a, b) => {
      if (a._ts != null && b._ts != null && a._ts !== b._ts) return a._ts - b._ts;
      return a._idx - b._idx;
    });
  const runs = [];
  let current = [];
  ordered.forEach((stage) => {
    const n = Number(stage.n);
    if (current.length && n === 1) {
      runs.push(current);
      current = [];
    }
    current.push(stage);
  });
  if (current.length) runs.push(current);
  return runs.map((run) => run.map(({ _idx, _ts, ...stage }) => stage));
}
function attachStageRunsToEvents(events, stages) {
  const eventRows = asArr(events);
  if (!eventRows.length) return [];
  const runs = splitStageRuns(stages);
  if (!runs.length) return eventRows.map((event) => ({ event, stages: [] }));
  if (eventRows.length === 1 && runs.length > 1) return [{ event: eventRows[0], stages: runs[runs.length - 1] }];
  const used = new Set();
  const toleranceMs = 3 * 60 * 1000;
  return eventRows.map((event, idx) => {
    const start = eventTimeMs(event);
    const next = eventTimeMs(eventRows[idx + 1]);
    let runIndex = -1;
    if (start != null) {
      runIndex = runs.findIndex((run, ri) => {
        if (used.has(ri)) return false;
        const first = timestampMs(run[0]?.logged_at);
        if (first == null) return false;
        return first >= start - toleranceMs && (next == null || first < next - 1000);
      });
    }
    if (runIndex < 0 && runs.length === eventRows.length && !used.has(idx)) runIndex = idx;
    if (runIndex < 0) {
      runIndex = runs.findIndex((run, ri) => {
        if (used.has(ri)) return false;
        const first = timestampMs(run[0]?.logged_at);
        if (first == null || start == null) return false;
        return first >= start - toleranceMs;
      });
    }
    if (runIndex >= 0) {
      used.add(runIndex);
      return { event, stages: runs[runIndex] };
    }
    return { event, stages: [] };
  });
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
function Pill({ status, tipAlign }) {
  const m = STATUS_META[status] || STATUS_META.pending;
  // Pills sit at the right edge of queue rows + most drawer cards, so
  // right-align the tooltip by default to avoid clipping the viewport.
  return <span className={`pill ${m.cls}`} data-tip={m.help} data-tip-align={tipAlign || 'right'}><span className="dot" />{m.label}</span>;
}
function Conf({ level }) {
  if (!level) return null;
  return (
    <span
      className={`conf ${String(level).toLowerCase()}`}
      data-tip="The agent’s self-assessment of how confident it is in this decision. Not a probability — a coarse signal."
      data-tip-align="right"
    >
      <span className="bars"><i /><i /><i /></span><b>{level}</b> confidence
    </span>
  );
}
function PlanTag({ plan }) {
  return <span className={`plan-tag ${planClass(plan)}`}>{plan}</span>;
}
// Toast plumbing — a tiny context so anywhere in the tree can fire a short
// confirmation message in the bottom-right corner. No animation lib, just a
// styled div that mounts for ~2.4s.
const ToastContext = createContext({ show: () => { } });
function useToast() { return useContext(ToastContext); }

function ToastHost({ children }) {
  const [toast, setToast] = useState(null);
  const idRef = useRef(0);
  const show = useCallback((message, kind = 'ok') => {
    idRef.current += 1;
    const id = idRef.current;
    setToast({ id, message, kind });
    setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), 2400);
  }, []);
  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toast ? (
        <div role="status" aria-live="polite" style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 9999,
          padding: '10px 16px', borderRadius: 9,
          background: toast.kind === 'ok' ? 'var(--ok-bg)' : 'var(--bad-bg)',
          color: toast.kind === 'ok' ? 'var(--ok-ink)' : 'var(--bad-ink)',
          border: `1px solid ${toast.kind === 'ok' ? 'var(--ok-line)' : 'var(--bad-line)'}`,
          fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 600,
          boxShadow: '0 6px 24px rgba(0, 0, 0, 0.10)',
          maxWidth: 360,
        }}>{toast.message}</div>
      ) : null}
    </ToastContext.Provider>
  );
}

async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext !== false) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_e) { /* fall through to fallback */ }
  // Fallback for non-HTTPS / older browsers
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_e) {
    return false;
  }
}

function CodeBlock({ data, style }) {
  const { show } = useToast();
  const onCopy = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = (typeof data === 'string') ? data : JSON.stringify(data, null, 2);
    const ok = await copyToClipboard(text);
    show(ok ? 'JSON copied to clipboard' : 'Copy failed — select & copy manually', ok ? 'ok' : 'bad');
  };
  return (
    <div style={{ position: 'relative', ...style }}>
      <button
        type="button"
        onClick={onCopy}
        title="Copy JSON to clipboard"
        style={{
          position: 'absolute', top: 6, right: 6, zIndex: 1,
          background: 'var(--bg)', border: '1px solid var(--line)',
          padding: '3px 9px', borderRadius: 6,
          fontFamily: 'var(--mono)', fontSize: 10.5, fontWeight: 600,
          cursor: 'pointer', color: 'var(--ink-2)',
        }}
      >Copy</button>
      <div className="codeblock" dangerouslySetInnerHTML={{ __html: jsonPretty(data) }} />
    </div>
  );
}
function Html({ html, className, style }) {
  return <div className={className} style={style} dangerouslySetInnerHTML={{ __html: html }} />;
}

/* ============================================================
   Report: metric card + queue table
   ============================================================ */
function MetricCard({ title, desc, big, chartHtml, moveH, moveP, tip }) {
  return (
    <div className="metric">
      <h3 data-tip={tip} data-tip-align="left" data-tip-pos="below">{title}</h3>
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
function LoadingOverlay({ show, label = 'Loading…' }) {
  if (!show) return null;
  return (
    <div className="loading-overlay" role="status" aria-live="polite">
      <div className="loading-card">
        <span className="processing-ring" aria-hidden="true" />
        <div>
          <strong>{label}</strong>
          <small>Fetching the latest records</small>
        </div>
      </div>
    </div>
  );
}
function ValuePairMetricCard({ received, approved, lineItems, eventCount }) {
  const safeReceived = Number(received || 0);
  const safeApproved = Number(approved || 0);
  const approvedPct = safeReceived > 0 ? Math.min(100, Math.round((safeApproved / safeReceived) * 100)) : 0;
  return (
    <div className="metric">
      <h3 data-tip="Received is total inbound PA value from intake events. Approved is the amount authorized by approved agent decisions." data-tip-align="left" data-tip-pos="below">PA value</h3>
      <p className="desc">Received versus approved value across the period</p>
      <div className="value-pair">
        <div className="value-half">
          <span>PA received</span>
          <strong>{fmtNGN(safeReceived)}</strong>
          <small>{(lineItems || 0).toLocaleString()} line items</small>
        </div>
        <div className="value-half approved">
          <span>PA approved</span>
          <strong>{fmtNGN(safeApproved)}</strong>
          <small>{approvedPct}% of received</small>
        </div>
      </div>
      <div className="value-meter" aria-label={`${approvedPct}% of received PA value approved`}>
        <i style={{ width: `${approvedPct}%` }} />
      </div>
      <div className="insight-sep"><span className="sparkle">✦</span> Insight is autogenerated</div>
      <div className="move-h">{fmtNGN(safeReceived)} received · {fmtNGN(safeApproved)} approved</div>
      <p className="move-p">{(eventCount || 0).toLocaleString()} intake events captured. Received value uses event additions, so follow-up items on the same PA are counted cleanly.</p>
    </div>
  );
}
function DateRangeFilter({ dateFrom, dateTo, setDateFrom, setDateTo, onChange, loading }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const label = formatDateRangeLabel(dateFrom, dateTo);
  const presets = [
    { label: 'Last 24 hours', from: () => todayDateInputValue(), to: () => todayDateInputValue() },
    { label: 'Last 7 days', from: () => dateInputValueDaysAgo(6), to: () => todayDateInputValue() },
    { label: 'Last 30 days', from: () => dateInputValueDaysAgo(29), to: () => todayDateInputValue() },
    { label: 'Last 90 days', from: () => dateInputValueDaysAgo(89), to: () => todayDateInputValue() },
    { label: 'All time', from: () => '', to: () => '' },
  ];
  const applyRange = (from, to, close = true) => {
    setDateFrom(from);
    setDateTo(to);
    onChange?.();
    if (close) setOpen(false);
  };
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="date-range" ref={wrapRef}>
      <button
        type="button"
        className={`date-range-btn ${open ? 'on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-tip="Filter by received date. Presets update the date range immediately."
        data-tip-pos="below"
      >
        <IconCal />
        <span>{label}</span>
        {loading ? <i className="mini-spinner" aria-label="Loading filtered data" /> : null}
        <span className="chev" aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div className="date-popover">
          {loading ? <div className="date-loading"><i className="mini-spinner" /> Updating range…</div> : null}
          <div className="range-presets">
            {presets.map((preset) => (
              <button key={preset.label} type="button" onClick={() => applyRange(preset.from(), preset.to())}>
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
              <input type="date" value={dateFrom} onChange={(e) => applyRange(e.target.value, dateTo, false)} />
              <input type="date" value={dateTo} onChange={(e) => applyRange(dateFrom, e.target.value, false)} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
function QueueHead() {
  return (
    <div className="qhead">
      <span>Reference</span><span>Patient</span><span>Plan</span><span>Item</span>
      <span style={{ textAlign: 'right' }}>Amount</span><span style={{ textAlign: 'right' }}>Status · latency</span><span style={{ textAlign: 'right' }}>Received</span><span style={{ textAlign: 'right' }}>Action</span>
    </div>
  );
}
const RETRYABLE_REQUEST_STATUSES = new Set(['pending', 'processing', 'received', 'error']);
function QueueRow({ r, selected, onSelect, onOpenPatient, canRetry, retrying, onRetry }) {
  const ref = (r.display_request_id || '').split('/').slice(-1)[0] || r.request_id;
  const retryable = RETRYABLE_REQUEST_STATUSES.has(r.status);
  return (
    <div className={`qrow ${selected ? 'sel' : ''}`} onClick={() => onSelect(r.request_id)}>
      <div className="ref">{ref}<small>{r.checkin_type} · {r.item_type || '—'}</small></div>
      <div className="pt">
        {r.patient_name || <span className="muted">Unnamed enrollee</span>}
        {r.patient_pa_count > 1 ? (
          <span
            role={onOpenPatient ? 'button' : undefined}
            tabIndex={onOpenPatient ? 0 : undefined}
            className="mono"
            data-tip={`This patient has ${r.patient_pa_count} pre-auth requests in this org. Click to open their patient page.`}
            onClick={(e) => { if (!onOpenPatient) return; e.stopPropagation(); onOpenPatient(r.patient_id); }}
            onKeyDown={(e) => { if (!onOpenPatient) return; if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onOpenPatient(r.patient_id); } }}
            style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 999, background: 'var(--tint)', color: 'var(--indigo)', border: '1px solid var(--indigo-soft)', fontSize: 10.5, fontWeight: 600, verticalAlign: 'middle', cursor: onOpenPatient ? 'pointer' : 'default' }}
          >
            {r.patient_pa_count}× PAs
          </span>
        ) : null}
        <small>{r.patient_id}</small>
      </div>
      <div className="plan"><PlanTag plan={r.plan} /></div>
      <div className="item" title={r.item_description}>{r.item_description}{r.line_item_count > 1 ? <span className="muted"> ·{r.line_item_count}</span> : ''}</div>
      <div className="amt">{fmtNGN(r.requested_amount)}</div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}><Pill status={r.status} /><span className="lat">{fmtSecs(r.processing_seconds)}</span></div>
      <div className="when">{r.received_label}</div>
      <div className="qaction">
        {canRetry && retryable ? (
          <button
            className="btn sm"
            disabled={retrying}
            onClick={(e) => { e.stopPropagation(); onRetry?.(r.request_id); }}
            data-tip="Clear stale agent output and re-run the decision pipeline for this PA."
            data-tip-pos="below"
            data-tip-align="right"
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        ) : <span className="muted mono">—</span>}
      </div>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {r.items.map((it, i) => {
          const total = it.unit * it.qty;
          const approved = Number(it.approved_cost) || 0;
          const hasApprovedField = it.approved_cost != null;
          return (
            <details key={i} style={{ background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 9 }}>
              <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'grid', gridTemplateColumns: '1fr 60px 130px 16px', alignItems: 'center', gap: 10, padding: '10px 12px' }}>
                <div style={{ fontSize: 13 }}>{it.name}</div>
                <div className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>×{it.qty}</div>
                <div className="mono" style={{ fontSize: 12, textAlign: 'right' }}>{fmtNGNfull(total)}</div>
                <div style={{ color: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right' }}>▾</div>
              </summary>
              <div style={{ padding: '12px 14px 14px', borderTop: '1px solid var(--line)', display: 'grid', gridTemplateColumns: '120px 1fr', rowGap: 6, columnGap: 12, fontSize: 12, fontFamily: 'var(--mono)' }}>
                <div className="muted">Unit cost</div><div>{fmtNGNfull(it.unit)}</div>
                <div className="muted">Quantity</div><div>{it.qty}</div>
                <div className="muted">Requested</div><div>{fmtNGNfull(total)}</div>
                <div className="muted">Approved</div><div>{hasApprovedField ? (approved > 0 ? fmtNGNfull(approved) : '₦0 (not approved at item level)') : '—'}</div>
                {it.item_status ? <><div className="muted">Item status</div><div>{it.item_status}</div></> : null}
                {it.pricing_source ? <><div className="muted">Pricing source</div><div>{it.pricing_source}</div></> : null}
                {it.category_id != null ? <><div className="muted">Category</div><div>{it.category_label || categoryLabel(it.category_id)}</div></> : null}
                {it.code ? <><div className="muted">Code</div><div>{it.code}</div></> : null}
                {it.diagnosis ? <><div className="muted">Diagnosis</div><div>{String(it.diagnosis)}</div></> : null}
                {it.provider ? <><div className="muted">Provider</div><div>{providerLabel(it.provider) || JSON.stringify(it.provider)}</div></> : null}
                {it.facility ? <><div className="muted">Facility</div><div>{it.facility}</div></> : null}
                {it.flags && (it.flags.active_count || it.flags.highest_severity) ? (
                  <>
                    <div className="muted">Flags</div>
                    <div>
                      {it.flags.active_count ? <span style={{ marginRight: 10 }}>active: {it.flags.active_count}</span> : null}
                      {it.flags.highest_severity ? <span>severity: {it.flags.highest_severity}</span> : null}
                    </div>
                  </>
                ) : null}
                {(it.claim_item_id || it.tariff_id) ? (
                  <>
                    <div className="muted">IDs</div>
                    <div>
                      {it.claim_item_id ? <span style={{ marginRight: 10 }}>claim: {it.claim_item_id}</span> : null}
                      {it.tariff_id ? <span>tariff: {it.tariff_id}</span> : null}
                    </div>
                  </>
                ) : null}
                <div style={{ gridColumn: '1 / -1', marginTop: 6 }}>
                  <details>
                    <summary style={{ cursor: 'pointer', color: 'var(--ink-3)', fontSize: 11 }}>Raw item JSON</summary>
                    <CodeBlock data={it.raw} />
                  </details>
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
// Render the structured fields each agent produces, lifted out of raw JSON
// so an operator can read a stage at a glance.
function StageHighlights({ stage }) {
  const r = asObj(stage.result);
  if (!r || !Object.keys(r).length) return null;
  const chip = (label, ok) => (
    <span style={{
      fontFamily: 'var(--mono)', fontSize: 11, padding: '2px 8px', borderRadius: 999,
      background: ok ? 'var(--ok-bg)' : 'var(--bad-bg)',
      color: ok ? 'var(--ok-ink)' : 'var(--bad-ink)',
      border: `1px solid ${ok ? 'var(--ok-line)' : 'var(--bad-line)'}`,
    }}>{ok ? '✓' : '✕'} {label}</span>
  );
  const bar = (used, limit) => {
    const pct = limit > 0 ? Math.min(100, (Number(used) || 0) / limit * 100) : 0;
    const over = (Number(used) || 0) > limit;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 90px', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 11.5 }}>
        <span className="muted">{fmtNGN(used || 0)}</span>
        <span style={{ height: 6, background: 'var(--bg-3)', borderRadius: 99, overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: over ? 'var(--bad)' : 'var(--ok)', borderRadius: 99 }} />
        </span>
        <span className="muted" style={{ textAlign: 'right' }}>of {fmtNGN(limit || 0)}</span>
      </div>
    );
  };
  if (stage.n === 1) {
    const c = asObj(r.checks);
    const items = [
      ['Active', c.status_active],
      ['Not expired', c.not_expired],
      ['Age OK', c.age_ok],
      ['Enrollment valid', c.enrollment_valid],
    ].filter(([, v]) => v !== undefined);
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
        {items.map(([k, v]) => <span key={k}>{chip(k, !!v)}</span>)}
        {r.is_platinum_plus ? <span className="mono" style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'var(--tint)', color: 'var(--indigo)', border: '1px solid var(--indigo-soft)' }}>Platinum+</span> : null}
      </div>
    );
  }
  if (stage.n === 2) {
    const covered = asArr(r.covered_items).length;
    const denied = asArr(r.denied_items).length;
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center', fontFamily: 'var(--mono)', fontSize: 11.5 }}>
        {r.benefit_category ? <span className="muted">Category: <b style={{ color: 'var(--ink)' }}>{r.benefit_category}</b></span> : null}
        {covered ? <span style={{ marginLeft: 4 }}>{chip(`${covered} covered`, true)}</span> : null}
        {denied ? <span>{chip(`${denied} denied`, false)}</span> : null}
        {r.exclusion_triggered ? <span style={{ color: 'var(--bad-ink)' }}>· Exclusion: {r.exclusion_detail || 'yes'}</span> : null}
        {r.waiting_period_issue ? <span style={{ color: 'var(--bad-ink)' }}>· Waiting period: {r.waiting_period_detail || 'yes'}</span> : null}
        {r.plan_restriction ? <span style={{ color: 'var(--bad-ink)' }}>· Plan restriction</span> : null}
      </div>
    );
  }
  if (stage.n === 3) {
    if (r.utilization_data_missing && r.bucket_used == null && r.bucket_limit == null) {
      return (
        <div style={{ marginTop: 6, fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--bad-ink)' }}>
          Consumption data unavailable — agent skipped.
        </div>
      );
    }
    return (
      <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
        {r.bucket ? (
          <div>
            <div className="muted mono" style={{ fontSize: 10.5, marginBottom: 4 }}>{r.bucket}{r.bucket_exceeded ? ' · exceeded' : ''}</div>
            {bar(r.bucket_used, r.bucket_limit)}
          </div>
        ) : null}
        <div>
          <div className="muted mono" style={{ fontSize: 10.5, marginBottom: 4 }}>Annual cap{r.annual_cap_exceeded ? ' · exceeded' : ''}</div>
          {bar(r.annual_cap_used, r.annual_cap_limit)}
        </div>
        {r.estimated_cost ? <div className="muted mono" style={{ fontSize: 11.5 }}>This request: <b style={{ color: 'var(--ink)' }}>{fmtNGN(r.estimated_cost)}</b></div> : null}
      </div>
    );
  }
  if (stage.n === 4) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, alignItems: 'center', fontFamily: 'var(--mono)', fontSize: 11.5 }}>
        {r.decision ? <span className="mono" style={{ padding: '2px 8px', borderRadius: 999, background: 'var(--bg-3)', color: 'var(--ink)', border: '1px solid var(--line)', fontWeight: 600 }}>{r.decision}</span> : null}
        {r.confidence ? <span className="muted">Confidence: <b style={{ color: 'var(--ink)' }}>{r.confidence}</b></span> : null}
        {r.amount_approved != null ? <span className="muted">Approved: <b style={{ color: 'var(--ink)' }}>{fmtNGNfull(r.amount_approved)}</b></span> : null}
        {r.no_preauth_required ? <span style={{ color: 'var(--ok-ink)' }}>· No PA required</span> : null}
        {asArr(r.flags).length ? <span style={{ color: 'var(--bad-ink)' }}>· Flags: {asArr(r.flags).join('; ')}</span> : null}
      </div>
    );
  }
  return null;
}

function AgentTimeline({ r, emptyMessage }) {
  if (!r.stages || !r.stages.length) {
    return <div className="muted" style={{ fontFamily: 'var(--mono)', fontSize: '12.5px', padding: '14px 0' }}>{emptyMessage || `Pipeline has not started for this request${r.status === 'received' ? ' — awaiting auto-decision.' : '.'}`}</div>;
  }
  return (
    <div className="timeline">
      {r.stages.map((s, i) => {
        const cls = s.status === 'processing' ? 'skip' : s.status;
        const node = s.status === 'pass' ? '✓' : s.status === 'fail' ? '✕' : s.n;
        const statTxt = s.status === 'processing' ? 'running' : s.status;
        const reason = asObj(s.result).reason || asObj(s.result).reasoning || asObj(s.result).denial_reason || asObj(s.result).escalation_reason || null;
        return (
          <div className={`stage ${cls}`} key={i}>
            <div className="node">{node}</div>
            <div className="s-top">
              <span className="s-name" data-tip={STAGE_TIPS[s.name]} data-tip-align="left">{s.n}. {s.name}</span>
              <span className="s-stat">{statTxt}</span>
              {s.time ? <span className="s-time">{s.time}</span> : null}
            </div>
            <p className="s-sum">{STAGE_Q[s.name] || ''}</p>
            {reason ? <p style={{ fontSize: 12.5, color: 'var(--ink)', margin: '6px 0 0', lineHeight: 1.55 }}>{reason}</p> : null}
            <StageHighlights stage={s} />
            {s.result ? <div className="s-raw" style={{ marginTop: 8 }}><details><summary>Stage result JSON</summary><CodeBlock data={s.result} /></details></div> : null}
          </div>
        );
      })}
    </div>
  );
}
function EventItemRows({ items }) {
  if (!items || !items.length) {
    return <div className="muted mono" style={{ fontSize: 11, marginTop: 6 }}>No item details captured for this event.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
      {items.map((it) => {
        const unit = _evtNum(it.unit_cost);
        const qty = _evtNum(it.quantity) || 1;
        const requested = _evtNum(it.requested_cost) ?? (unit != null ? unit * qty : 0);
        const approved = _evtNum(it.approved_cost);
        return (
          <details key={it.id} style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 7 }}>
            <summary style={{ cursor: 'pointer', listStyle: 'none', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto 60px 110px 16px', gap: 8, alignItems: 'center', padding: '6px 9px' }}>
              <span style={{ fontSize: 12, minWidth: 0 }}>{it.name}</span>
              <ItemStatusBadge item={it} />
              <span className="muted mono" style={{ fontSize: 11 }}>×{qty}</span>
              <span className="mono" style={{ fontSize: 11.5, textAlign: 'right' }}>{fmtNGNfull(requested)}</span>
              <span style={{ color: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right' }}>▾</span>
            </summary>
            <div style={{ padding: '10px 12px 12px', borderTop: '1px solid var(--line)', display: 'grid', gridTemplateColumns: '112px 1fr', rowGap: 6, columnGap: 12, fontSize: 11.5, fontFamily: 'var(--mono)' }}>
              <div className="muted">Unit cost</div><div>{unit != null ? fmtNGNfull(unit) : '—'}</div>
              <div className="muted">Quantity</div><div>{qty}</div>
              <div className="muted">Requested</div><div>{fmtNGNfull(requested)}</div>
              <div className="muted">Approved</div><div>{approved != null ? fmtNGNfull(approved) : '—'}</div>
              {it.item_status != null ? <><div className="muted">Item status</div><div>{itemStatusInfo(it)?.label || String(it.item_status)}</div></> : null}
              {it.pricing_source ? <><div className="muted">Pricing source</div><div>{it.pricing_source}</div></> : null}
              {it.category_id != null ? <><div className="muted">Category</div><div>{it.category_label || categoryLabel(it.category_id)}</div></> : null}
              {it.flags && (it.flags.active_count || it.flags.highest_severity) ? (
                <>
                  <div className="muted">Flags</div>
                  <div>
                    {it.flags.active_count ? <span style={{ marginRight: 10 }}>active: {it.flags.active_count}</span> : null}
                    {it.flags.highest_severity ? <span>severity: {it.flags.highest_severity}</span> : null}
                  </div>
                </>
              ) : null}
              {(it.claim_item_id || it.tariff_id) ? (
                <>
                  <div className="muted">IDs</div>
                  <div>
                    {it.claim_item_id ? <span style={{ marginRight: 10 }}>claim: {it.claim_item_id}</span> : null}
                    {it.tariff_id ? <span>tariff: {it.tariff_id}</span> : null}
                  </div>
                </>
              ) : null}
              <div style={{ gridColumn: '1 / -1', marginTop: 4 }}>
                <details>
                  <summary style={{ cursor: 'pointer', color: 'var(--ink-3)', fontSize: 11 }}>Raw item JSON</summary>
                  <CodeBlock data={it.raw || it} />
                </details>
              </div>
            </div>
          </details>
        );
      })}
    </div>
  );
}
function DetailView({ r, siblings, onSelectSibling, paEvents, paEventsLoading, paEventsError, onOpenPatient }) {
  if (!r) return null;
  const eventRuns = attachStageRunsToEvents(paEvents || [], r.stages || []);
  const firstExistingItems = eventRuns.length ? existingItemsFromFirstEvent(eventRuns[0].event) : [];
  return (
    <div className="detail">
      <div className="dhead">
        <div>
          <div className="dref">{r.display_request_id}</div>
          {onOpenPatient && r.patient_id && r.patient_id !== '—' && r.patient_id.toLowerCase() !== 'unknown' ? (
            <h2
              className="dname"
              role="button"
              tabIndex={0}
              data-tip="Open this patient's full page — all their PAs, totals, and outcome distribution."
              data-tip-align="left"
              onClick={() => onOpenPatient(r.patient_id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenPatient(r.patient_id); } }}
              style={{ cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 4, textDecorationColor: 'var(--indigo-soft)' }}
            >
              {r.patient_name || 'Unnamed enrollee'}
            </h2>
          ) : (
            <h2 className="dname">{r.patient_name || 'Unnamed enrollee'}</h2>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }} data-admin-only="">
          <button className="btn sm">Override</button>
          <button className="btn sm">Reassign</button>
        </div>
      </div>
      <DecisionBlock r={r} />
      <div><div className="sec-h">Request details</div><DetailsGrid r={r} /></div>
      {siblings && siblings.length > 0 ? (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div className="sec-h" data-tip="Every other PA from the same patient_id (or insurance_no fallback when patient_id is unknown), across all queue pages." data-tip-align="left" style={{ marginBottom: 0 }}>Other requests from this patient <span className="n">{siblings.length}</span></div>
            {onOpenPatient && r.patient_id && r.patient_id !== '—' && r.patient_id.toLowerCase() !== 'unknown' ? (
              <button
                className="btn sm"
                onClick={() => onOpenPatient(r.patient_id)}
                data-tip="Opens the dedicated patient page with totals, outcome distribution, and all PAs in one view."
                data-tip-align="right"
                style={{ fontSize: 11 }}
              >View patient page →</button>
            ) : null}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
            {siblings.slice(0, 8).map((s) => (
              <button key={s.request_id} onClick={() => onSelectSibling && onSelectSibling(s.request_id)} style={{ background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 9, padding: '10px 12px', cursor: 'pointer', textAlign: 'left' }} title="Switch to this request">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)' }}>{s.display_request_id}</span>
                  <Pill status={s.status} />
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink)', marginTop: 4 }}>{s.item_description}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>{s.received_label} · {fmtNGN(s.requested_amount)}</div>
              </button>
            ))}
            {siblings.length > 8 ? <div className="muted mono" style={{ fontSize: 11.5, padding: '4px 2px' }}>+{siblings.length - 8} more</div> : null}
          </div>
        </div>
      ) : null}
      {(paEvents && paEvents.length) || paEventsLoading || paEventsError || (r.event_count && r.event_count > 0) ? (
        <div>
          <div className="sec-h" data-tip="Each row is one webhook delivery from the HMO for this check-in. First event = initial capture; later events = additional items added by the doctor." data-tip-align="left">PA event timeline <span className="n">{(paEvents || []).length || r.event_count || 0}</span></div>
          {paEventsError ? (
            <div style={{ padding: '10px 12px', background: 'var(--bad-bg)', color: 'var(--bad-ink)', border: '1px solid var(--bad-line)', borderRadius: 9, fontSize: 12, fontFamily: 'var(--mono)' }}>
              Couldn't load events: {paEventsError}
            </div>
          ) : null}
          {paEventsLoading && !(paEvents || []).length ? (
            <div className="muted mono" style={{ fontSize: 12, padding: '8px 2px' }}>Loading event history…</div>
          ) : null}
          {eventRuns.length ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
              {firstExistingItems.length ? (
                <div style={{ display: 'grid', gridTemplateColumns: '32px 1fr', gap: 10 }}>
                  <div style={{ width: 32, height: 32, display: 'grid', placeItems: 'center', borderRadius: '50%', background: 'var(--bg-3)', color: 'var(--ink-2)', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700 }}>0</div>
                  <div style={{ background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 9, padding: '10px 12px' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
                      <b style={{ fontSize: 13 }}>Existing items</b>
                      <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>{fmtNGNfull(eventItemsTotal(firstExistingItems))}</span>
                    </div>
                    <div className="muted mono" style={{ fontSize: 11, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      <span>{firstExistingItems.length} line item{firstExistingItems.length === 1 ? '' : 's'}</span>
                      <span>· Already on this PA before our first captured event</span>
                    </div>
                    <EventItemRows items={firstExistingItems} />
                  </div>
                </div>
              ) : null}
              {eventRuns.map(({ event, stages }, eventIdx) => {
                const seq = _evtNum(event.event_sequence) || 0;
                const items = itemsAddedFromEvent(event);
                const when = event.submitted_at || event.occurred_at || event.created_at;
                const isLatestEvent = eventIdx === eventRuns.length - 1;
                return (
                  <div key={event.event_id || event.id} style={{ display: 'grid', gridTemplateColumns: '32px 1fr', gap: 10 }}>
                    <div style={{ width: 32, height: 32, display: 'grid', placeItems: 'center', borderRadius: '50%', background: seq <= 1 ? 'var(--indigo)' : 'var(--ink)', color: '#fff', fontFamily: 'var(--mono)', fontSize: 12, fontWeight: 700 }}>{seq || '?'}</div>
                    <div style={{ background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 9, padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 4 }}>
                        <b style={{ fontSize: 13 }}>{seq <= 1 ? 'First captured event' : 'Additional items added'}</b>
                        <span className="mono" style={{ fontSize: 11.5, color: 'var(--ink-2)' }}>{fmtNGNfull(eventValue(event))}</span>
                      </div>
                      <div className="muted mono" style={{ fontSize: 11, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                        <span>{eventItemCount(event)} line item{eventItemCount(event) === 1 ? '' : 's'}</span>
                        <span>· Snapshot: {fmtNGNfull(event.total_requested_cost)}</span>
                        {when ? <span>· {timeAgo(when)}</span> : null}
                      </div>
                      <EventItemRows items={items} />
                      <details style={{ marginTop: 8 }}>
                        <summary style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>Event JSON</summary>
                        <CodeBlock data={event.raw_payload || event.payload_summary || event} style={{ marginTop: 6 }} />
                      </details>
                      <details open={isLatestEvent} style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                        <summary style={{ cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-3)' }}>
                          Agent run {stages.length ? `· ${stages.length} stage${stages.length === 1 ? '' : 's'}` : '· not captured for this event'}
                        </summary>
                        <div style={{ marginTop: 8 }}>
                          <AgentTimeline
                            r={{ ...r, stages }}
                            emptyMessage="No agent run was matched to this event yet."
                          />
                        </div>
                      </details>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : !paEventsLoading && !paEventsError ? (
            <div className="muted mono" style={{ fontSize: 12, padding: '8px 2px' }}>
              No event history yet — request captured before event tracking, or backend returned none.
            </div>
          ) : null}
        </div>
      ) : null}
      {!eventRuns.length && !paEventsLoading ? (
        <div>
          <div className="sec-h" data-tip="All agents that ran for this PA: Eligibility → Coverage → Limits → Final Decision. Each stage shows its reason and structured result." data-tip-align="left">Agent reasoning timeline <span className="n">{r.stages ? r.stages.length : 0} stage{r.stages && r.stages.length === 1 ? '' : 's'}</span></div>
          <AgentTimeline r={r} />
        </div>
      ) : null}
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
function Drawer({ request, open, onClose, siblings, onSelectSibling, paEvents, paEventsLoading, paEventsError, onOpenPatient }) {
  return (
    <>
      <div className={`drawer-scrim ${open ? 'open' : ''}`} onClick={onClose} />
      <aside className={`drawer ${open ? 'open' : ''}`}>
        <button className="icon-btn dclose" onClick={onClose} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
        <div className="dwrap"><div id="drawer-body">{open && request ? <DetailView r={request} siblings={siblings} onSelectSibling={onSelectSibling} paEvents={paEvents} paEventsLoading={paEventsLoading} paEventsError={paEventsError} onOpenPatient={onOpenPatient} /> : null}</div></div>
      </aside>
    </>
  );
}

/* ============================================================
   Chrome: status bar, sidebar, ask bar
   ============================================================ */
function orgInitials(name) {
  return String(name || 'Organization').split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
}
function orgListFromResponse(orgs) {
  if (!orgs) return [];
  if (Array.isArray(orgs)) return orgs;
  if (Array.isArray(orgs.orgs)) return orgs.orgs;
  return [];
}
function StatusBar({ session, role, onRole, refreshedLabel, isPlatformAdmin, orgs, orgsLoading, orgsError, viewOrgId, onSelectOrg, onClearOrg, onLoadOrgs }) {
  const [orgOpen, setOrgOpen] = useState(false);
  const wrapRef = useRef(null);
  const org = session.org_name || 'Organization';
  const currentOrg = viewOrgId?.name || org;
  const short = orgInitials(currentOrg);
  const isAdmin = (session.role || 'member') === 'admin';
  const orgRows = orgListFromResponse(orgs);
  const visibleOrgRows = orgRows.filter((o) => String(o.name || '').toUpperCase() !== String(org || '').toUpperCase());
  useEffect(() => {
    if (!orgOpen) return undefined;
    const onPointerDown = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOrgOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOrgOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [orgOpen]);
  const toggleOrgOpen = () => {
    if (!isPlatformAdmin) return;
    if (!orgs && !orgsLoading) onLoadOrgs?.();
    setOrgOpen((v) => !v);
  };
  return (
    <div className="statusbar">
      <div className="org-switcher" ref={wrapRef}>
        <button
          type="button"
          className={`sb-org ${isPlatformAdmin ? 'switchable' : ''}`}
          onClick={toggleOrgOpen}
          aria-haspopup={isPlatformAdmin ? 'menu' : undefined}
          aria-expanded={isPlatformAdmin ? orgOpen : undefined}
          data-tip={isPlatformAdmin ? 'Switch between client organizations. Your SaaSPro admin account stays the same.' : undefined}
          data-tip-pos="below"
          data-tip-align="left"
        >
          <span className="org-dot">{short}</span>
          <b>{currentOrg}</b>
          <span className="scope">{isPlatformAdmin ? (viewOrgId ? 'client org' : 'platform org') : 'org-scoped'}</span>
          {isPlatformAdmin ? <span className="scope-chev" aria-hidden="true">⌄</span> : null}
        </button>
        {isPlatformAdmin && orgOpen ? (
          <div className="org-menu" role="menu">
            <div className="org-menu-head">Switch organization</div>
            <button
              type="button"
              className={`org-option ${!viewOrgId ? 'on' : ''}`}
              onClick={() => { onClearOrg?.(); setOrgOpen(false); }}
              role="menuitem"
            >
              <span className="org-dot">{orgInitials(org)}</span>
              <span><b>{org}</b><small>Platform workspace</small></span>
            </button>
            {orgsLoading ? <div className="org-menu-note">Loading organizations…</div> : null}
            {orgsError ? <div className="org-menu-note bad">{orgsError}</div> : null}
            {visibleOrgRows.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`org-option ${viewOrgId?.id === o.id ? 'on' : ''}`}
                onClick={() => { onSelectOrg?.(o); setOrgOpen(false); }}
                role="menuitem"
              >
                <span className="org-dot">{orgInitials(o.name)}</span>
                <span><b>{o.name}</b><small>{(o.requests || 0).toLocaleString()} requests · {(o.members || 0).toLocaleString()} members</small></span>
              </button>
            ))}
            {!orgsLoading && !visibleOrgRows.length ? <div className="org-menu-note">No client organizations yet.</div> : null}
          </div>
        ) : null}
      </div>
      <div className="sb-refresh" data-tip="Last successful fetch. Auto-refreshes every 15s. Click the refresh icon on the page header to force a refetch." data-tip-pos="below"><span className="spin" /> {refreshedLabel}</div>
      <div className="sb-right">
        {isAdmin ? (
          <span className="roleswitch" data-tip="Preview what each role sees. Doesn't change your actual role — just toggles the UI for testing." data-tip-pos="below" data-tip-align="right">
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
  { id: 'patients', label: 'Patients', live: true },
  { id: 'support', label: 'AI Customer Ops', live: true },
];
const NAV_ADMIN = [
  { id: 'team', label: 'Team', live: true, lock: true },
  { id: 'apikey', label: 'API Key', live: true, lock: true },
];
const NAV_PLATFORM = [
  { id: 'onboarding', label: 'Onboarding', live: true, lock: true },
];
function Sidebar({ active, onNav, session, intakeCount, collapsed, onToggleCollapse, isPlatformAdmin, onSignOut }) {
  const initials = (session.name || '?').split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  const item = (n) => (
    <a
      key={n.id}
      className={`navitem ${n.lock ? 'lock' : ''} ${n.id === active ? 'active' : ''} ${n.live ? '' : 'soon'}`}
      href="#"
      title={collapsed ? n.label : undefined}
      data-tip={!n.live ? 'Coming soon — this page exists in the design but isn’t wired to a backend endpoint yet.' : (n.lock ? 'Admin-only feature. Hidden for members.' : undefined)}
      data-tip-pos="right"
      onClick={(e) => { e.preventDefault(); onNav(n.id); }}
    >
      <span className="gl" /><span className="nav-label">{n.label}</span>
      {/* {!n.live ? <span className="soon-tag">SOON</span> : (n.id === 'intake' ? <span className="ct">{intakeCount}</span> : null)} */}
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
      {isPlatformAdmin && (
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
          {/* <span className="caret">▌</span> */}
          {/* <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Ask me about ${context}…`} /> */}
          {/* <span className="face">🫥</span> */}
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
const HEALTH_STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'failed', label: 'Any failure' },
  { value: 'auth_failed', label: 'Auth failed' },
  { value: 'invalid_payload', label: 'Invalid payload' },
  { value: 'db_failed', label: 'DB failed' },
  { value: 'http_failed', label: 'HTTP errors' },
  { value: 'duplicates', label: 'Duplicates' },
];
function HealthView({
  data,
  loading,
  error,
  org,
  dateFrom,
  dateTo,
  setDateFrom,
  setDateTo,
  status,
  setStatus,
  limit,
  setLimit,
}) {
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
  const senderName = (l) => l.api_client_name || (l.api_key_hint ? `Unknown key ${l.api_key_hint}` : 'Unknown sender');
  const dbStatusLabel = (status) => {
    if (['db_upsert_success', 'event_saved_latest_state_updated'].includes(status)) return 'saved';
    if (status === 'duplicate_event_seen') return 'dupe';
    if (status === 'db_insert_failed') return 'failed';
    return '—';
  };
  return (
    <div className="loading-host">
      <LoadingOverlay show={loading && !!data} label="Loading delivery logs" />
      <div className="stub-head"><h1 className="page-title">Integration Health</h1></div>
      <p className="page-sub">Inbound webhook deliveries from <b>{org}</b> · <span className="muted">latest {d.latest_received_at ? timeAgo(d.latest_received_at) : '—'}</span></p>
      <p style={{ fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: '10px 0 0', maxWidth: 760 }}>
        Every webhook the HMO sends — successful or not — is logged here. Use this when {org === 'AMAN' ? 'Aman' : 'your HMO'} says &ldquo;I sent it but you didn&rsquo;t receive it&rdquo;: failed deliveries (bad auth, malformed payload, parse errors) appear here even when they never become a PA. The queue and the Patients page only show requests that landed successfully — this page is the source of truth for the delivery layer.
      </p>
      <div className="toolbar section-gap" style={{ marginTop: 18 }}>
        <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} setDateFrom={setDateFrom} setDateTo={setDateTo} loading={loading} />
        <div className="search" style={{ width: 190 }}>
          <span className="muted mono" style={{ fontSize: 12 }}>status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ border: 'none', outline: 'none', fontFamily: 'var(--mono)', fontSize: 12, background: 'transparent', color: 'var(--ink)', padding: '6px 4px', width: '100%' }}>
            {HEALTH_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="search" style={{ width: 150 }}>
          <span className="muted mono" style={{ fontSize: 12 }}>show</span>
          <select value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))} style={{ border: 'none', outline: 'none', fontFamily: 'var(--mono)', fontSize: 12, background: 'transparent', color: 'var(--ink)', padding: '6px 4px', width: '100%' }}>
            {[25, 50, 100, 250, 500, 1000].map((n) => <option key={n} value={n}>{n} logs</option>)}
          </select>
        </div>
      </div>
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
          <h3>Delivery attempts</h3><p className="desc">Showing {logs.length.toLocaleString()} of {(d.total_received || 0).toLocaleString()} matching logs · sender, auth result, and DB status</p>
          <div className="chart-wrap" style={{ marginTop: 14 }}>
            {logs.length === 0 ? (
              <div className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 12, padding: '16px 0' }}>{loading ? 'Loading…' : 'No deliveries in range.'}</div>
            ) : (
              <div style={{ maxHeight: 520, overflow: 'auto', paddingRight: 4 }}>
                {logs.map((l) => {
                  const m = attemptMeta(l);
                  return (
                    <div key={l.delivery_id} style={{ display: 'grid', gridTemplateColumns: '96px minmax(0,1.2fr) 74px 78px 58px 44px', gap: 10, alignItems: 'center', fontFamily: 'var(--mono)', fontSize: '11.5px', padding: '9px 0', borderBottom: '1px solid var(--line)' }}>
                      <span title={l.checkin_id || l.delivery_id}>{shortId(l)}</span>
                      <span className="muted" title={senderName(l)} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{senderName(l)}</span>
                      <span className="muted">{l.created_at ? timeAgo(l.created_at) : '—'}</span>
                      <span style={{ color: m.color }}>{m.label}</span>
                      <span className="muted">{dbStatusLabel(l.db_insert_status)}</span>
                      <b>{l.http_status_returned ?? '—'}</b>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Patients — index + detail (wired to /auth/patients + /auth/patient-history)
   ============================================================ */
const OUTCOME_DOT = {
  approve: 'var(--ok)',
  deny: 'var(--bad)',
  escalate: 'var(--warn)',
  processing: 'var(--indigo)',
  pending: 'var(--slate)',
  received: 'var(--recv)',
  error: 'var(--bad)',
};
const OUTCOME_LABEL = {
  approve: 'approve', deny: 'deny', escalate: 'escalate',
  processing: 'processing', pending: 'pending', received: 'received', error: 'error',
};
function OutcomePills({ counts, size = 'sm' }) {
  const items = ['approve', 'deny', 'escalate', 'processing', 'pending', 'received', 'error']
    .map((k) => [k, counts?.[k] || 0])
    .filter(([, n]) => n > 0);
  if (!items.length) return <span className="muted mono" style={{ fontSize: 11 }}>—</span>;
  const padding = size === 'lg' ? '4px 10px' : '2px 8px';
  const fontSize = size === 'lg' ? 12 : 11;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {items.map(([k, n]) => (
        <span
          key={k}
          className="mono"
          data-tip={`${n} ${OUTCOME_LABEL[k]} ${n === 1 ? 'request' : 'requests'} from this patient.`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding, borderRadius: 999, fontSize, fontWeight: 600,
            background: 'var(--bg-2)', border: '1px solid var(--line)', color: 'var(--ink-2)',
          }}
        >
          <span style={{ width: 7, height: 7, borderRadius: 99, background: OUTCOME_DOT[k] }} />
          {n} {OUTCOME_LABEL[k]}
        </span>
      ))}
    </div>
  );
}

function PatientsIndex({ data, loading, error, q, setQ, sort, setSort, outcome, setOutcome, page, setPage, onOpenPatient, onBack }) {
  const list = (data && data.patients) || [];
  const meta = data?.meta || {};
  const pagination = data?.pagination || {};
  const dw = meta.data_window || {};
  const fmt = (iso) => { if (!iso) return null; const d = new Date(iso); return isNaN(d) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
  const dwFrom = fmt(dw.earliest); const dwTo = fmt(dw.latest);
  return (
    <>
      {onBack ? (
        <div style={{ marginBottom: 12 }}>
          <button className="btn sm" onClick={onBack} data-tip="Return to the Pre-Auth Intake queue." data-tip-align="left">← Back to Pre-Auth Intake</button>
        </div>
      ) : null}
      <div className="page-head">
        <div>
          <h1 className="page-title">Patients</h1>
          <p className="page-sub">
            <span className="cal" aria-hidden="true"><IconCal /></span>
            <span data-tip="Distinct patients with at least one PA in this org. 'Unknown' patient IDs are excluded.">{meta.distinct_patients_org_total ?? 0} patients</span>
            {dwFrom && dwTo ? <><span style={{ margin: '0 8px', opacity: 0.4 }}>·</span>{dwFrom} → {dwTo}</> : null}
          </p>
        </div>
      </div>
      <p style={{ fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: '10px 0 0', maxWidth: 760 }}>
        Investigate at the enrollee level. Each row groups every PA we've received for one patient — sort by volume to spot frequent requesters, by value to flag high spend, or by denials to surface possible misuse. Click any row for the patient's full timeline.
      </p>
      <div className="toolbar" style={{ marginTop: 18, marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="search" style={{ minWidth: 240, flex: '1 1 240px' }} data-tip="Search across patient name, patient ID, and insurance number." data-tip-pos="below" data-tip-align="left">
          <IconSearch />
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search by name or ID…" />
        </div>
        <div className="search" style={{ width: 'auto', padding: '0 12px', gap: 6 }} data-tip="Reorder the list by recency, volume, value, or denial count." data-tip-pos="below">
          <span className="muted mono" style={{ fontSize: 11 }}>Sort</span>
          <select value={sort} onChange={(e) => { setSort(e.target.value); setPage(1); }} style={{ border: 'none', outline: 'none', fontFamily: 'var(--mono)', fontSize: 12, background: 'transparent', color: 'var(--ink)', padding: '6px 4px' }}>
            <option value="latest">Latest activity</option>
            <option value="count">Most PAs</option>
            <option value="requested">Highest requested</option>
            <option value="approved">Highest approved</option>
            <option value="denials">Most denials</option>
          </select>
        </div>
        <div className="search" style={{ width: 'auto', padding: '0 12px', gap: 6 }} data-tip="Narrow to patients who have at least one PA of a given outcome." data-tip-pos="below">
          <span className="muted mono" style={{ fontSize: 11 }}>Outcome</span>
          <select value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(1); }} style={{ border: 'none', outline: 'none', fontFamily: 'var(--mono)', fontSize: 12, background: 'transparent', color: 'var(--ink)', padding: '6px 4px' }}>
            <option value="all">All patients</option>
            <option value="denials">Has denials</option>
            <option value="escalations">Has escalations</option>
            <option value="approvals">Has approvals</option>
            <option value="open">Has open PAs</option>
          </select>
        </div>
      </div>
      {error ? <div className="ro-banner" style={{ display: 'flex', marginBottom: 14, background: 'var(--bad-bg)', borderColor: 'var(--bad-line)', color: 'var(--bad-ink)' }}><span className="led" style={{ background: 'var(--bad)' }} /> {error}</div> : null}
      <div className="queue loading-host">
        <LoadingOverlay show={loading && !!list.length} label="Loading patients" />
        <div className="qhead" style={{ gridTemplateColumns: '1.6fr 70px 120px 120px 1.4fr 90px' }}>
          <span>Patient</span>
          <span data-tip="Number of pre-auth requests this patient has in this org.">PAs</span>
          <span data-tip="Sum of requested amounts across all their PAs.">Requested</span>
          <span data-tip="Sum of agent-approved amounts (only counts APPROVE decisions).">Approved</span>
          <span data-tip="Distribution of decisions across this patient's PAs.">Outcomes</span>
          <span style={{ textAlign: 'right' }}>Latest</span>
        </div>
        <div>
          {loading && !list.length ? (
            <div className="muted mono" style={{ padding: '24px 14px', fontSize: 12 }}>Loading patients…</div>
          ) : !list.length ? (
            <div className="stub-empty" style={{ padding: '60px 24px' }}>
              <div className="ph">◐</div><h4>No patients match</h4>
              <p>{q ? 'Try a broader search.' : 'No PAs in this org yet, or all rows have unknown patient IDs.'}</p>
            </div>
          ) : list.map((p) => (
            <div
              key={p.patient_id}
              className="qrow"
              style={{ gridTemplateColumns: '1.6fr 70px 120px 120px 1.4fr 90px', cursor: 'pointer' }}
              onClick={() => onOpenPatient(p.patient_id)}
            >
              <div className="pt">
                {p.patient_name || <span className="muted">Unnamed enrollee</span>}
                <small>{p.patient_id}{p.insurance_no && p.insurance_no !== p.patient_id ? ` · ${p.insurance_no}` : ''}</small>
              </div>
              <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>{p.pa_count}</div>
              <div className="mono" style={{ fontSize: 12.5 }}>{fmtNGN(p.total_requested)}</div>
              <div className="mono" style={{ fontSize: 12.5 }}>{p.total_approved > 0 ? fmtNGN(p.total_approved) : <span className="muted">—</span>}</div>
              <div><OutcomePills counts={p.outcome_counts} /></div>
              <div className="when" style={{ textAlign: 'right' }}>{p.latest_received_at ? timeAgo(p.latest_received_at) : '—'}</div>
            </div>
          ))}
        </div>
      </div>
      {(pagination.total_pages || 0) > 1 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)' }}>
          <span>Page {pagination.page} of {pagination.total_pages} · {pagination.total} patients</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn sm" disabled={loading || pagination.page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>‹ Prev</button>
            <button className="btn sm" disabled={loading || pagination.page >= pagination.total_pages} onClick={() => setPage((p) => p + 1)}>Next ›</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function PatientDetail({ patient, loading, error, openedIds, toggleRow, onBack, onDownloadPdf, session, orgName }) {
  // `patient.requests` come from /auth/patient-history (un-mapped). The
  // detail rows below run them through mapRequest; the ReportSheet also
  // wants the mapped shape (with items, stages, etc).
  const requests = (patient?.requests || []).map(mapRequest);
  // Aggregate the same shape /auth/patients returns, but client-side from the
  // full /patient-history payload (more accurate than the index aggregate).
  const counts = requests.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  const totalRequested = requests.reduce((s, r) => s + (Number(r.requested_amount) || 0), 0);
  const totalApproved = requests.reduce((s, r) => s + (r.status === 'approve' ? Number(r.amount_approved || 0) : 0), 0);
  const header = requests[0] || {};
  return (
    <>
      {/* PDF report portal — rendered into document.body, hidden on screen.
          @media print hides everything else and reveals only this. The
          audit metadata (downloaded by, downloaded at) is baked into it. */}
      <PatientReportSheet
        patient={patient}
        requests={(patient?.requests || []).map(mapRequest)}
        session={session}
        orgName={orgName}
      />
      <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <button className="btn sm" onClick={onBack} data-tip="Return to the patients list." data-tip-align="left">← Back to patients</button>
        <span style={{ flex: 1 }} />
        <button
          className="btn sm"
          onClick={onDownloadPdf}
          data-tip="Print the full report as a PDF. The output includes a header with your name, email, the org, and the timestamp for audit purposes."
          data-tip-align="right"
        >Download PDF</button>
      </div>
      <div style={{ background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: 12, padding: '20px 22px', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div className="muted mono" style={{ fontSize: 12, marginBottom: 4 }}>
              {patient?.patient_id || '—'}{header.plan && header.plan !== '—' ? <> · <PlanTag plan={header.plan} /></> : null}
            </div>
            <h1 style={{ fontFamily: 'var(--mono)', fontSize: 26, fontWeight: 600, margin: 0, color: 'var(--ink)' }}>
              {header.patient_name || 'Unnamed enrollee'}
            </h1>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 36, marginTop: 22, borderTop: '1px dashed var(--line-2)', paddingTop: 16, fontFamily: 'var(--mono)' }}>
          <div>
            <div className="muted" style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase' }} data-tip="Number of pre-auth requests this patient has on the platform.">Pre-auths</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{requests.length}</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase' }} data-tip="Sum of requested amounts across all this patient's PAs.">Requested · total</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{fmtNGN(totalRequested)}</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase' }} data-tip="Sum of agent-approved amounts. Counts APPROVE decisions only.">Approved · total</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{fmtNGN(totalApproved)}</div>
          </div>
        </div>
        <div style={{ marginTop: 18 }}>
          <div className="muted" style={{ fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', fontFamily: 'var(--mono)', marginBottom: 8 }}>Outcomes</div>
          <OutcomePills counts={counts} size="lg" />
        </div>
      </div>
      {error ? <div className="ro-banner" style={{ display: 'flex', marginBottom: 14, background: 'var(--bad-bg)', borderColor: 'var(--bad-line)', color: 'var(--bad-ink)' }}><span className="led" style={{ background: 'var(--bad)' }} /> {error}</div> : null}
      {requests.length > 1 ? (
        <div className="ro-banner" style={{ display: 'flex', marginBottom: 14, background: 'var(--tint)', borderColor: 'var(--indigo-soft)', color: 'var(--indigo)' }}>
          <span className="led" style={{ background: 'var(--indigo)' }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
            This enrollee has <b>{requests.length} pre-auth requests</b>. Each row below has its own 4-agent reasoning timeline — expand any request to see exactly how the AI decided it.
          </span>
        </div>
      ) : null}
      {loading && !requests.length ? (
        <div className="muted mono" style={{ padding: '24px 14px', fontSize: 12 }}>Loading patient history…</div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {requests.map((r) => {
          const isOpen = openedIds.has(r.request_id);
          const ref = (r.display_request_id || '').split('/').slice(-1)[0] || r.request_id;
          return (
            <div key={r.request_id} className="pa-print-card" style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 9, overflow: 'hidden' }}>
              <button
                onClick={() => toggleRow(r.request_id)}
                style={{
                  width: '100%', display: 'grid', gridTemplateColumns: '20px 1.6fr 2fr 110px 130px 80px', alignItems: 'center',
                  gap: 12, padding: '12px 14px', cursor: 'pointer', background: 'transparent', border: 'none', textAlign: 'left',
                }}
              >
                <span style={{ color: 'var(--ink-3)', fontFamily: 'var(--mono)', fontSize: 11 }}>{isOpen ? '▾' : '▸'}</span>
                <span className="mono" style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{ref}</span>
                <span style={{ fontSize: 13 }}>{r.item_description}{r.line_item_count > 1 ? <span className="muted"> · {r.line_item_count}</span> : ''}</span>
                <span className="mono" style={{ fontSize: 12.5, textAlign: 'right' }}>{fmtNGN(r.requested_amount)}</span>
                <span style={{ textAlign: 'right' }}><Pill status={r.status} /></span>
                <span className="when" style={{ textAlign: 'right' }}>{r.received_label}</span>
              </button>
              {isOpen ? (
                <div style={{ padding: '14px 18px 20px', borderTop: '1px solid var(--line)', background: 'var(--bg-2)' }}>
                  <DetailView r={r} siblings={[]} onSelectSibling={() => { }} paEvents={[]} paEventsLoading={false} paEventsError="" />
                </div>
              ) : null}
            </div>
          );
        })}
        {!loading && !requests.length ? (
          <div className="stub-empty" style={{ padding: '60px 24px' }}>
            <div className="ph">◐</div><h4>No PAs for this patient</h4>
            <p>This patient ID didn't match any records in this org.</p>
          </div>
        ) : null}
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
      <p style={{ fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: '10px 0 0', maxWidth: 760 }}>
        Paste an event ID, check-in ID, or request ID and we replay it across the webhook delivery layer + the agent pipeline. Use this for &ldquo;the provider says they sent us X — what did we actually do with it?&rdquo; questions, compliance audits, or chasing down a specific failure. It catches things the queue can&rsquo;t — failed deliveries that never became a PA.
      </p>
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
function ApiKeyView({ data, error, notice, isAdmin, org, revealed, busy, onGenerate, onRevoke, keyName, setKeyName }) {
  const keys = (data && data.keys) || [];
  return (
    <>
      <div className="stub-head"><h1 className="page-title">API Keys</h1></div>
      <p className="page-sub">Credentials used to authenticate webhook deliveries · <b>{org}</b></p>
      {!isAdmin ? <div className="ro-banner section-gap" style={{ marginTop: 18 }}><span className="led" style={{ background: 'var(--recv)' }} /> Read-only view — only admins can generate or revoke keys.</div> : null}
      {notice ? <div className="ro-banner section-gap" style={{ display: 'flex', marginTop: 14, background: 'var(--ok-bg)', borderColor: 'var(--ok-line)', color: 'var(--ok-ink)' }}><span className="led" style={{ background: 'var(--ok)' }} /> {notice}</div> : null}
      {error ? <div className="ro-banner section-gap" style={{ display: 'flex', marginTop: 14, background: 'var(--bad-bg)', borderColor: 'var(--bad-line)', color: 'var(--bad-ink)' }}><span className="led" style={{ background: 'var(--bad)' }} /> {error}</div> : null}

      {isAdmin ? (
        <div className="metric section-gap" data-admin-only="" style={{ maxWidth: 760, marginTop: 20 }}>
          <h3>Generate a new key</h3>
          <p className="desc">Name it so you can tell keys apart (e.g. "Aman prod webhook", "Staging test"). The full key is shown once, on generation.</p>
          <form onSubmit={(e) => { e.preventDefault(); onGenerate(); }} style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <div className="search" style={{ flex: 1 }}>
              <input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="Key name (optional)" />
            </div>
            <button className="btn indigo" type="submit" disabled={busy}>{busy ? 'Generating…' : 'Generate key'}</button>
          </form>
          {revealed ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, background: 'var(--ok-bg)', border: '1px solid var(--ok-line)', borderRadius: 9, padding: '13px 16px', fontFamily: 'var(--mono)', fontSize: 13 }}>
                <span style={{ flex: 1, wordBreak: 'break-all' }}>{revealed}</span>
                <span className="pill approve"><span className="dot" />new</span>
              </div>
              <div className="muted mono" style={{ fontSize: 11.5, marginTop: 8 }}>Copy this now — the full key will not be shown again.</div>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="section-gap" style={{ marginTop: 30 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
          <h2 style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 500, margin: 0 }}>Active keys</h2>
          <span className="muted mono" style={{ fontSize: 12 }}>{keys.length} key{keys.length === 1 ? '' : 's'}</span>
        </div>
        <div className="queue">
          <div className="qhead" style={{ gridTemplateColumns: '1.4fr 140px 130px 130px 100px' }}>
            <span>Name</span><span data-tip="Only the first 4 and last 4 characters are stored as a display hint. The full key is shown once at generation — copy it then." data-tip-align="left">Key</span><span>Created</span><span data-tip="Most recent successful webhook authentication with this key. ‘never’ means the HMO hasn’t sent a webhook with it yet." data-tip-align="left">Last used</span><span style={{ textAlign: 'right' }}>Action</span>
          </div>
          {keys.map((k) => (
            <div className="qrow" key={k.id} style={{ gridTemplateColumns: '1.4fr 140px 130px 130px 100px', cursor: 'default' }}>
              <div className="pt"><b>{k.name}</b></div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>{k.masked_api_key}</div>
              <div className="muted mono" style={{ fontSize: 12 }}>{k.created_at ? timeAgo(k.created_at) : '—'}</div>
              <div className="muted mono" style={{ fontSize: 12 }}>{k.last_used_at ? timeAgo(k.last_used_at) : 'never'}</div>
              <div style={{ textAlign: 'right' }} data-admin-only="">
                {isAdmin ? <button className="btn sm" onClick={() => onRevoke && onRevoke(k.id, k.name)} style={{ color: 'var(--bad)', borderColor: 'var(--bad-line)' }} disabled={busy}>Revoke</button> : null}
              </div>
            </div>
          ))}
          {!keys.length && <div className="stub-empty" style={{ padding: '40px 24px' }}><div className="ph">🔑</div><h4>No keys yet</h4><p>{isAdmin ? 'Generate one above to authenticate webhook deliveries from this org.' : 'An admin can generate API keys for this org.'}</p></div>}
        </div>
      </div>
    </>
  );
}

/* ============================================================
   Onboarding (SaaSPro platform admin: cross-org platform view)
   ============================================================ */
function OnboardingView({ data, loading, error, isPlatformAdmin, orgName, setOrgName, adminEmail, setAdminEmail, onCreate, creating, created, createError, onResetCreate, onSelectOrg, onRenameOrg, onToggleActive }) {
  if (!isPlatformAdmin) {
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
      <p style={{ fontFamily: 'var(--mono)', fontSize: 12.5, lineHeight: 1.55, color: 'var(--ink-2)', margin: '10px 0 0', maxWidth: 760 }}>
        Spin up a new HMO client, invite their first admin, or drill into any existing client&rsquo;s queue read-only. This page is visible only to admins of the SaaSPro org — client admins manage their own org&rsquo;s team + keys from their respective Team and API Key pages.
      </p>
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
          <p className="desc">Members and admins live inside a single client org. SaaSPro platform admins (admins of the SAASPRO org) can spin up new client orgs and invite their first admin from here — no CLI required.</p>
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
          <div className="qhead" style={{ gridTemplateColumns: '1.4fr 100px 110px 90px 100px 120px 200px' }}>
            <span>Organization</span><span>Members</span><span>Pending</span><span>API keys</span><span>Requests</span><span>Last activity</span><span style={{ textAlign: 'right' }}>Actions</span>
          </div>
          {orgs.map((o) => (
            <div className="qrow" key={o.id} onClick={() => onSelectOrg && onSelectOrg(o)} title="View this org's intake" style={{ gridTemplateColumns: '1.4fr 100px 110px 90px 100px 120px 200px', cursor: onSelectOrg ? 'pointer' : 'default', opacity: o.is_active ? 1 : 0.55 }}>
              <div className="pt"><b>{o.name}</b><small>{o.is_active ? 'active' : 'disabled'}</small></div>
              <div className="mono" style={{ fontSize: 12 }}>{(o.members || 0).toLocaleString()}</div>
              <div>{o.pending_invites > 0 ? <span className="pill escalate"><span className="dot" />{o.pending_invites}</span> : <span className="muted mono" style={{ fontSize: 12 }}>—</span>}</div>
              <div className="mono" style={{ fontSize: 12 }}>{(o.api_keys || 0).toLocaleString()}</div>
              <div className="mono" style={{ fontSize: 12 }}>{(o.requests || 0).toLocaleString()}</div>
              <div className="muted mono" style={{ fontSize: 12 }}>{o.last_activity ? timeAgo(o.last_activity) : 'never'}</div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                <button className="btn sm" onClick={(e) => { e.stopPropagation(); onRenameOrg && onRenameOrg(o); }} title="Rename">Rename</button>
                {o.name.toUpperCase() !== 'SAASPRO' ? (
                  o.is_active
                    ? <button className="btn sm" onClick={(e) => { e.stopPropagation(); onToggleActive && onToggleActive(o, false); }} style={{ color: 'var(--bad)', borderColor: 'var(--bad-line)' }} data-tip="Inactive orgs can’t accept webhooks or have their members log in. History is preserved." data-tip-pos="below" data-tip-align="right">Deactivate</button>
                    : <button className="btn sm" onClick={(e) => { e.stopPropagation(); onToggleActive && onToggleActive(o, true); }} title="Reactivate">Reactivate</button>
                ) : null}
              </div>
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

function GmailMark({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="brand-mark">
      <path fill="#EA4335" d="M3.6 6.4 12 12.7l8.4-6.3v10.8c0 .7-.6 1.3-1.3 1.3h-2.4V11.1L12 14.6l-4.7-3.5v7.4H4.9c-.7 0-1.3-.6-1.3-1.3V6.4Z" />
      <path fill="#FBBC04" d="M3.6 6.4v-.1c0-.7.6-1.3 1.3-1.3h.6L12 9.9l6.5-4.9h.6c.7 0 1.3.6 1.3 1.3v.1L12 12.7 3.6 6.4Z" />
      <path fill="#34A853" d="M3.6 6.4v10.8c0 .7.6 1.3 1.3 1.3h2.4V11.1L3.6 8.3V6.4Z" />
      <path fill="#4285F4" d="M16.7 18.5h2.4c.7 0 1.3-.6 1.3-1.3V6.4l-3.7 2.8v9.3Z" />
    </svg>
  );
}

function WhatsAppMark({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="brand-mark">
      <path fill="#25D366" d="M12 3.2a8.6 8.6 0 0 0-7.4 13l-1 3.7 3.8-1A8.6 8.6 0 1 0 12 3.2Z" />
      <path fill="#fff" d="M16.8 14.2c-.2-.1-1.4-.7-1.6-.8-.2-.1-.4-.1-.5.1-.2.2-.6.8-.8.9-.1.2-.3.2-.5.1-.3-.1-1.1-.4-2.1-1.3-.8-.7-1.3-1.5-1.5-1.8-.1-.3 0-.4.1-.5l.4-.5c.1-.2.2-.3.2-.5.1-.2 0-.3 0-.5 0-.1-.5-1.3-.7-1.8-.2-.5-.4-.4-.5-.4h-.5c-.2 0-.5.1-.7.3-.2.3-.9.9-.9 2.1s.9 2.4 1 2.6c.1.2 1.8 2.8 4.4 3.9.6.3 1.1.4 1.5.5.6.2 1.2.1 1.6.1.5-.1 1.4-.6 1.6-1.1.2-.6.2-1 .1-1.1-.1-.1-.3-.2-.6-.3Z" />
    </svg>
  );
}

function supportSenderName(value) {
  const text = String(value || '').trim();
  if (!text) return 'Unknown sender';
  const match = text.match(/^"?([^"<]+)"?\s*</);
  return (match ? match[1] : text).trim();
}

function SupportSourceMark({ channel, size = 18 }) {
  if (channel === 'whatsapp') return <WhatsAppMark size={size} />;
  return <GmailMark size={size} />;
}

function SupportInbox({ data, loading, error, selected, onSelect, onRefresh }) {
  const messages = data?.messages || [];
  const active = selected || messages[0] || null;

  return (
    <section className="support-inbox section-gap">
      <div className="support-inbox-head">
        <div>
          <h2>Live support inbox</h2>
          <p>Email and WhatsApp conversations captured for agent handling</p>
        </div>
        <button className="btn sm" type="button" onClick={onRefresh} disabled={loading}>Refresh inbox</button>
      </div>

      {error ? <div className="ro-banner" style={{ display: 'flex', background: 'var(--bad-bg)', borderColor: 'var(--bad-line)', color: 'var(--bad-ink)' }}><span className="led" style={{ background: 'var(--bad)' }} /> {error}</div> : null}

      <div className="support-inbox-grid">
        <div className="support-message-list">
          {loading ? (
            <div className="support-loading"><span className="thinking"><i /><i /><i /></span><b>Loading support inbox</b></div>
          ) : messages.length ? messages.map((m) => (
            <button className={`support-message-row ${active?.id === m.id ? 'active' : ''}`} type="button" key={m.id} onClick={() => onSelect(m)}>
              <span className={`support-source ${m.channel || 'gmail'}`}><SupportSourceMark channel={m.channel} size={18} /></span>
              <span className="support-message-main">
                <span className="support-message-top">
                  <b>{supportSenderName(m.from_email)}</b>
                  <em>{m.received_at ? timeAgo(m.received_at) : 'Just now'}</em>
                </span>
                <span className="support-message-subject">{m.subject || '(No subject)'}</span>
                <span className="support-message-snippet">{m.snippet || m.body_text || 'No preview available'}</span>
              </span>
            </button>
          )) : (
            <div className="support-empty inbox-empty">
              <h4>No support messages yet</h4>
              <p>New Gmail and WhatsApp conversations will appear here after the agent intake receives them.</p>
            </div>
          )}
        </div>

        <div className="support-message-detail">
          {active ? (
            <>
              <div className="support-detail-head">
                <span className={`support-source ${active.channel || 'gmail'}`}><SupportSourceMark channel={active.channel} size={20} /></span>
                <div>
                  <h3>{active.subject || '(No subject)'}</h3>
                  <p>{supportSenderName(active.from_email)} → {active.to_email || active.mailbox_email || 'Inbox'}</p>
                </div>
              </div>
              <div className="support-detail-meta">
                <span>{active.channel === 'whatsapp' ? 'WhatsApp' : 'Gmail'}</span>
                <span>{active.status || 'new'}</span>
                <span>{active.received_at ? new Date(active.received_at).toLocaleString() : 'No timestamp'}</span>
              </div>
              <div className="support-body">
                {active.body_text || active.snippet || 'No readable body captured yet.'}
              </div>
              <div className="support-agent-panel">
                <div className="sec-h"><span>Agent activity</span><b>{active.agent_activity?.length || 0} steps</b></div>
                {(active.agent_activity || []).map((step, idx) => (
                  <div className={`support-agent-step ${step.status || 'pending'}`} key={`${step.step}-${idx}`}>
                    <span className="support-agent-dot" />
                    <div>
                      <b>{step.step}</b>
                      <h4>{step.title}</h4>
                      <p>{step.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="support-empty inbox-empty">
              <h4>Select a message</h4>
              <p>Open a support message to see the captured content and agent activity.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SupportView({ org, data, messagesData, messagesLoading, messagesError, selectedMessage, onSelectMessage, loading, error, notice, isAdmin, isDrillIn, busy, onRefresh, onRefreshMessages, onConnect, onDisconnect, onStartWatch }) {
  const [soonMessage, setSoonMessage] = useState('');
  const connections = data?.connections || [];
  const activeConnections = connections.filter((c) => c.status === 'connected');
  const connected = activeConnections.length > 0;
  const configured = data?.configured !== false;
  const listening = activeConnections.some((c) => c.watch_status === 'active');
  const statusText = listening ? 'Realtime active' : connected ? 'Connected' : 'Not connected';

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">AI Customer Ops</h1>
          <p className="page-sub">Deploy AI agents that handle email and WhatsApp provider requests and enrollee questions for <b>{org}</b></p>
        </div>
        <div className="page-actions">
          <button className="icon-btn" title="Refresh" aria-label="Refresh Gmail integration" onClick={onRefresh} disabled={loading}><RefreshCw size={16} /></button>
        </div>
      </div>

      {notice ? <div className="ro-banner section-gap" style={{ display: 'flex', background: 'var(--ok-bg)', borderColor: 'var(--ok-line)', color: 'var(--ok-ink)' }}><span className="led" style={{ background: 'var(--ok)' }} /> {notice}</div> : null}
      {soonMessage ? <div className="ro-banner section-gap" style={{ display: 'flex', background: 'var(--recv-bg)', borderColor: 'var(--recv-line)', color: 'var(--recv-ink)' }}><span className="led" style={{ background: 'var(--recv)' }} /> {soonMessage}</div> : null}
      {error ? <div className="ro-banner section-gap" style={{ display: 'flex', background: 'var(--bad-bg)', borderColor: 'var(--bad-line)', color: 'var(--bad-ink)' }}><span className="led" style={{ background: 'var(--bad)' }} /> {error}</div> : null}
      {!configured ? <div className="ro-banner section-gap" style={{ display: 'flex', background: 'var(--warn-bg)', borderColor: 'var(--warn-line)', color: 'var(--warn-ink)' }}><span className="led" style={{ background: 'var(--warn)' }} /> Google OAuth credentials are not configured on the backend yet.</div> : null}

      <div className="support-grid section-gap">
        <section className="integration-panel">
          <div className={`integration-icon gmail ${connected ? 'on' : ''}`}>
            <GmailMark size={26} />
          </div>
          <div className="integration-main">
            <div className="integration-top">
              <div>
                <h2>Gmail intake</h2>
                <p>Provider and member email queue</p>
              </div>
              <div className="integration-actions">
                <span className={`pill ${listening ? 'approve' : connected ? 'processing' : 'pending'}`}><span className="dot" />{statusText}</span>
                {isAdmin && !isDrillIn ? (
                  <button className="btn sm primary" onClick={onConnect} disabled={busy || loading || !configured} data-admin-only>
                    <GmailMark size={14} />
                    {connected ? 'Connect another' : 'Connect Gmail'}
                  </button>
                ) : null}
              </div>
            </div>

            {loading ? (
              <div className="support-loading"><span className="thinking"><i /><i /><i /></span><b>Checking Gmail connection</b></div>
            ) : connections.length ? (
              <div className="connection-list">
                {connections.map((c) => (
                  <div className="connection-row" key={c.id}>
                    <div className="connection-name">
                      {c.status === 'connected' ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                      <span>{c.email}</span>
                    </div>
                    <div className="connection-meta">
                      <span>{c.status}</span>
                      <span>{c.watch_status === 'active' ? 'Listener active' : c.watch_status === 'error' ? 'Listener error' : 'Listener not started'}</span>
                      <span>{c.updated_at ? `Updated ${timeAgo(c.updated_at)}` : 'No update yet'}</span>
                      {c.watch_expiration ? <span>{`Renews by ${new Date(c.watch_expiration).toLocaleString()}`}</span> : null}
                      <span>{c.last_sync_at ? `Synced ${timeAgo(c.last_sync_at)}` : 'Sync not started'}</span>
                      <span>{`${c.support_message_count || 0} emails captured`}</span>
                    </div>
                    {isAdmin && !isDrillIn && c.status === 'connected' ? (
                      <div className="connection-actions">
                        <button className="btn sm" onClick={() => onStartWatch(c.id)} disabled={busy || !configured} data-admin-only>
                          <Radio size={13} />
                          {c.watch_status === 'active' ? 'Renew listener' : 'Start listener'}
                        </button>
                        <button className="btn sm" onClick={() => onDisconnect(c.id)} disabled={busy} data-admin-only>
                          <Unplug size={13} />
                          Disconnect
                        </button>
                      </div>
                    ) : null}
                    {c.watch_error ? <div className="connection-error"><AlertTriangle size={13} />{c.watch_error}</div> : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="support-empty">
                <h4>No Gmail mailbox connected</h4>
                <p>Connect a support or provider mailbox to start the email intake pipeline.</p>
                {isAdmin && !isDrillIn ? (
                  <button className="btn primary support-connect" onClick={onConnect} disabled={busy || loading || !configured} data-admin-only>
                    <GmailMark size={15} />
                    Connect Gmail
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </section>

        <section className="integration-panel">
          <div className="integration-icon whatsapp">
            <WhatsAppMark size={26} />
          </div>
          <div className="integration-main">
            <div className="integration-top">
              <div>
                <h2>WhatsApp intake</h2>
                <p>Provider and member chat queue</p>
              </div>
              <span className="pill pending"><span className="dot" />Soon</span>
            </div>
            <div className="support-empty">
              <h4>WhatsApp connection is coming soon</h4>
              <p>We will use this for provider requests, eligibility checks, and member support conversations.</p>
              {isAdmin && !isDrillIn ? (
                <button className="btn support-connect" type="button" onClick={() => setSoonMessage('WhatsApp intake is coming soon.') } data-admin-only>
                  <WhatsAppMark size={15} />
                  Connect WhatsApp
                </button>
              ) : null}
            </div>
          </div>
        </section>
      </div>

      <SupportInbox
        data={messagesData}
        loading={messagesLoading}
        error={messagesError}
        selected={selectedMessage}
        onSelect={onSelectMessage}
        onRefresh={onRefreshMessages}
      />
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
const IconRefresh = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
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
            <h1 style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 500, margin: '2px 0 0' }}>Operations</h1>
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
        {/* <span className="eyebrow" style={{ textAlign: 'center' }}>Backend: {API_BASE_URL}</span> */}
      </form>
    </main>
  );
}

function Register({ onRegistered }) {
  const params = new URLSearchParams(window.location.search);
  const invitedEmail = params.get('email') || '';
  const inviteToken = params.get('token') || '';
  const [form, setForm] = useState({
    email: invitedEmail,
    name: '',
    password: '',
    confirmPassword: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    if (!inviteToken) {
      setError('Invite token is missing. Please use the full invite link.');
      return;
    }
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      await publicApiRequest('/auth/register', {
        method: 'POST',
        body: {
          invite_token: inviteToken,
          email: form.email.trim(),
          name: form.name.trim(),
          password: form.password,
        },
      });
      const login = await publicApiRequest('/auth/login', {
        method: 'POST',
        body: { email: form.email.trim(), password: form.password },
      });
      replaceBrowserPath('/');
      onRegistered(login);
    } catch (err) {
      setError(err.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg-2)', padding: 24 }}>
      <form onSubmit={submit} style={{ width: 'min(420px, 100%)', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-card)', padding: '34px 30px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img src="/saaspro-mark.png" alt="SaaSPro Labs" style={{ width: 40, height: 40, borderRadius: 9, display: 'block' }} />
          <div>
            <p className="eyebrow" style={{ margin: 0 }}>Invite registration</p>
            <h1 style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 500, margin: '2px 0 0' }}>Create dashboard account</h1>
          </div>
        </div>
        <label style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          Email
          <div className="search">
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              readOnly={!!invitedEmail}
              placeholder="admin@example.com"
              autoComplete="email"
              required
            />
          </div>
        </label>
        <label style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          Name
          <div className="search"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Full name" autoComplete="name" required autoFocus /></div>
        </label>
        <label style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          Password
          <div className="search"><input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Create password" autoComplete="new-password" required /></div>
        </label>
        <label style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          Confirm password
          <div className="search"><input type="password" value={form.confirmPassword} onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })} placeholder="Repeat password" autoComplete="new-password" required /></div>
        </label>
        {error ? <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--bad-ink)', background: 'var(--bad-bg)', border: '1px solid var(--bad-line)', borderRadius: 8, padding: '8px 12px' }}>{error}</div> : null}
        <button className="btn indigo" type="submit" disabled={loading} style={{ justifyContent: 'center' }}>{loading ? 'Creating account...' : 'Create account'}</button>
        <span className="eyebrow" style={{ textAlign: 'center' }}>You will continue to the Saaspro dashboard</span>
      </form>
    </main>
  );
}

/* ============================================================
   App
   ============================================================ */
export default function App() {
  return (
    <ToastHost>
      <AppInner />
    </ToastHost>
  );
}

function AppInner() {
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
  const [retryingRequests, setRetryingRequests] = useState(() => new Set());
  const [retryAllBusy, setRetryAllBusy] = useState(false);
  const [retryNotice, setRetryNotice] = useState('');
  const [retryError, setRetryError] = useState('');
  const [activeNav, setActiveNav] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('nav') || 'intake'; }
    catch { return 'intake'; }
  });
  // Patients page state — list + detail share this single view, switched by
  // ?patient= in the URL.
  const [patients, setPatients] = useState(null);
  const [patientsLoading, setPatientsLoading] = useState(false);
  const [patientsError, setPatientsError] = useState('');
  const [patientsQuery, setPatientsQuery] = useState('');
  const [patientsSort, setPatientsSort] = useState('latest');
  const [patientsOutcome, setPatientsOutcome] = useState('all');
  const [patientsPage, setPatientsPage] = useState(1);
  const [selectedPatientId, setSelectedPatientId] = useState(() => {
    try { return new URLSearchParams(window.location.search).get('patient') || ''; }
    catch { return ''; }
  });
  const [patientDetail, setPatientDetail] = useState(null); // { patient_id, requests }
  const [patientDetailLoading, setPatientDetailLoading] = useState(false);
  const [patientDetailError, setPatientDetailError] = useState('');
  const [openedPaIds, setOpenedPaIds] = useState(() => new Set()); // which PA rows in detail view are expanded
  const [activeTab, setActiveTab] = useState('dashboard');
  const [role, setRole] = useState('admin');
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('saaspro-sidebar-collapsed') === '1'; } catch { return false; } });
  const toggleSidebar = () => setCollapsed((c) => { const n = !c; try { localStorage.setItem('saaspro-sidebar-collapsed', n ? '1' : '0'); } catch (e) { /* ignore */ } return n; });
  const [lastLoaded, setLastLoaded] = useState(null);
  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthError, setHealthError] = useState('');
  const [healthDateFrom, setHealthDateFrom] = useState(() => todayDateInputValue());
  const [healthDateTo, setHealthDateTo] = useState(() => todayDateInputValue());
  const [healthStatus, setHealthStatus] = useState('all');
  const [healthLimit, setHealthLimit] = useState(100);
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
  const [keyName, setKeyName] = useState('');
  const [gmailIntegration, setGmailIntegration] = useState(null);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailError, setGmailError] = useState('');
  const [gmailNotice, setGmailNotice] = useState('');
  const [gmailBusy, setGmailBusy] = useState(false);
  const [supportMessages, setSupportMessages] = useState(null);
  const [supportMessagesLoading, setSupportMessagesLoading] = useState(false);
  const [supportMessagesError, setSupportMessagesError] = useState('');
  const [selectedSupportMessage, setSelectedSupportMessage] = useState(null);
  const [orgs, setOrgs] = useState(null);
  const [orgsLoading, setOrgsLoading] = useState(false);
  const [orgsError, setOrgsError] = useState('');
  const [newOrgName, setNewOrgName] = useState('');
  const [newOrgAdminEmail, setNewOrgAdminEmail] = useState('');
  const [creatingOrg, setCreatingOrg] = useState(false);
  const [createdOrg, setCreatedOrg] = useState(null);
  const [createOrgError, setCreateOrgError] = useState('');
  const [viewOrgId, setViewOrgId] = useState(null); // { id, name } when a platform admin is drilled into another org
  const [switchingOrg, setSwitchingOrg] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 25;
  const [dateFrom, setDateFrom] = useState(() => todayDateInputValue());
  const [dateTo, setDateTo] = useState(() => todayDateInputValue());
  // Debounced copy of the search box so we don't fire one fetch per keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  // Full patient history for the currently-open drawer. Fetched on demand so
  // siblings show across pages, not just within the visible 25.
  const [patientHistory, setPatientHistory] = useState({ patient_id: null, requests: [] });
  // PA event timeline for the currently-open drawer (origin/main feature).
  // Fetched from /auth/preauth-events when the drawer opens.
  const [paEvents, setPaEvents] = useState({ checkin_id: null, events: [], loading: false, error: '' });

  useEffect(() => { document.body.dataset.layout = 'report'; return () => { delete document.body.dataset.layout; }; }, []);
  useEffect(() => { document.body.classList.toggle('role-member', role === 'member'); }, [role]);
  useEffect(() => { if (session && isInviteRegistrationRoute()) replaceBrowserPath('/'); }, [session]);
  // Platform-admin drill-in is view-only. When the active org context differs from
  // the user's own org, hide write actions and surface a banner so they can't
  // accidentally mutate the client's data through their own-org write endpoints.
  useEffect(() => {
    const drilled = !!(viewOrgId && session && viewOrgId.name !== session.org_name);
    document.body.classList.toggle('drill-in-view', drilled);
    return () => document.body.classList.remove('drill-in-view');
  }, [viewOrgId, session]);
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

  function acceptSession(data) {
    const next = { token: data.token, role: data.role, name: data.name, org_name: data.org_name };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSession(next);
    setRole(next.role || 'admin');
  }

  async function handleLogin(event) {
    event.preventDefault();
    setLoginError('');
    setLoginLoading(true);
    try {
      const data = await apiRequest('/auth/login', { method: 'POST', body: { email, password } });
      acceptSession(data);
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
      const qs = new URLSearchParams();
      if (viewOrgId) qs.set('org_id', String(viewOrgId.id));
      if (dateFrom) qs.set('date_from', dateFrom);
      if (dateTo) qs.set('date_to', dateTo);
      if (debouncedQuery && debouncedQuery.trim()) qs.set('q', debouncedQuery.trim());
      qs.set('page', String(currentPage));
      qs.set('page_size', String(PAGE_SIZE));
      const data = await apiRequest('/auth/preauth-dashboard?' + qs.toString());
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
      if (!silent) setSwitchingOrg(false);
    }
  }

  async function retryPreauthRequest(requestId) {
    if (!session?.token || !requestId) return;
    setRetryNotice('');
    setRetryError('');
    setRetryingRequests((current) => new Set([...current, requestId]));
    try {
      await apiRequest('/auth/preauth/retry', {
        method: 'POST',
        body: {
          request_id: requestId,
          ...(viewOrgId ? { org_id: viewOrgId.id } : {}),
        },
      });
      setRetryNotice(`Retry queued for ${requestId}`);
      await loadDashboard({ silent: true });
    } catch (err) {
      setRetryError(err.message || 'Could not retry request');
    } finally {
      setRetryingRequests((current) => {
        const next = new Set(current);
        next.delete(requestId);
        return next;
      });
    }
  }

  async function retryAllPendingPreauths() {
    if (!session?.token) return;
    setRetryNotice('');
    setRetryError('');
    setRetryAllBusy(true);
    try {
      const res = await apiRequest('/auth/preauth/retry-pending', {
        method: 'POST',
        body: {
          ...(viewOrgId ? { org_id: viewOrgId.id } : {}),
          date_from: dateFrom || null,
          date_to: dateTo || null,
          q: (debouncedQuery || query || '').trim() || null,
          limit: 20,
        },
      });
      setRetryNotice(`${res.queued_count || 0} pending request${res.queued_count === 1 ? '' : 's'} queued for retry. Run another batch if more remain.`);
      await loadDashboard({ silent: true });
    } catch (err) {
      setRetryError(err.message || 'Could not retry pending requests');
    } finally {
      setRetryAllBusy(false);
    }
  }

  async function loadHealth() {
    if (!session?.token) return;
    setHealthLoading(true);
    setHealthError('');
    try {
      const qs = new URLSearchParams();
      if (viewOrgId) qs.set('org_id', String(viewOrgId.id));
      if (healthDateFrom) qs.set('date_from', healthDateFrom);
      if (healthDateTo) qs.set('date_to', healthDateTo);
      if (healthStatus) qs.set('status', healthStatus);
      qs.set('limit', String(healthLimit));
      const data = await apiRequest('/auth/webhook-delivery-logs?' + qs.toString());
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
      if (viewOrgId) params.set('org_id', String(viewOrgId.id));
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
      const body = { name: (keyName || '').trim() || null };
      const res = await apiRequest('/auth/api-key/generate', { method: 'POST', body });
      setRevealedKey(res.api_key || '');
      setApikeyNotice(`Key "${res.name || 'new'}" generated`);
      setKeyName('');
      await loadApiKey();
    } catch (err) { setApikeyError(err.message || 'Generate failed'); }
    finally { setApikeyBusy(false); }
  }
  async function revokeKey(keyId, keyDisplayName) {
    if (!window.confirm(`Revoke key "${keyDisplayName || 'this key'}"? This cannot be undone.`)) return;
    setApikeyBusy(true); setApikeyError(''); setApikeyNotice('');
    try {
      await apiRequest(`/auth/api-key/${keyId}`, { method: 'DELETE' });
      setApikeyNotice(`Key "${keyDisplayName || 'key'}" revoked`);
      await loadApiKey();
    } catch (err) { setApikeyError(err.message || 'Revoke failed'); }
    finally { setApikeyBusy(false); }
  }
  function sameGmailIntegration(a, b) {
    const compact = (value) => (value?.connections || []).map((c) => ({
      id: c.id,
      email: c.email,
      status: c.status,
      watch_status: c.watch_status,
      watch_expiration: c.watch_expiration,
      last_sync_at: c.last_sync_at,
      support_message_count: c.support_message_count,
    }));
    return JSON.stringify(compact(a)) === JSON.stringify(compact(b));
  }
  function sameSupportMessages(a, b) {
    const compact = (value) => ({
      total: value?.pagination?.total || 0,
      messages: (value?.messages || []).map((m) => ({
        id: m.id,
        status: m.status,
        subject: m.subject,
        snippet: m.snippet,
        received_at: m.received_at,
        updated_at: m.updated_at,
      })),
    });
    return JSON.stringify(compact(a)) === JSON.stringify(compact(b));
  }
  async function loadGmailIntegration({ silent = false } = {}) {
    if (!session?.token) return;
    if (!silent) setGmailLoading(true);
    if (!silent) setGmailError('');
    try {
      const qs = new URLSearchParams();
      if (viewOrgId) qs.set('org_id', String(viewOrgId.id));
      const suffix = qs.toString() ? `?${qs.toString()}` : '';
      const data = await apiRequest(`/auth/integrations/gmail${suffix}`);
      setGmailIntegration((current) => (silent && sameGmailIntegration(current, data) ? current : data));
    } catch (err) {
      if (!silent) setGmailError(err.message || 'Could not load Gmail connection');
    } finally {
      if (!silent) setGmailLoading(false);
    }
  }
  async function loadSupportMessages({ silent = false } = {}) {
    if (!session?.token) return;
    if (!silent) setSupportMessagesLoading(true);
    if (!silent) setSupportMessagesError('');
    try {
      const qs = new URLSearchParams();
      if (viewOrgId) qs.set('org_id', String(viewOrgId.id));
      qs.set('page', '1');
      qs.set('page_size', '25');
      const data = await apiRequest('/auth/support/messages?' + qs.toString());
      setSupportMessages((current) => (silent && sameSupportMessages(current, data) ? current : data));
      setSelectedSupportMessage((current) => {
        if (!current) return null;
        const next = (data.messages || []).find((m) => m.id === current.id) || null;
        if (!next) return null;
        return silent && JSON.stringify(next) === JSON.stringify(current) ? current : next;
      });
    } catch (err) {
      if (!silent) setSupportMessagesError(err.message || 'Could not load support messages');
    } finally {
      if (!silent) setSupportMessagesLoading(false);
    }
  }
  async function refreshSupport({ silent = false } = {}) {
    await Promise.all([loadGmailIntegration({ silent }), loadSupportMessages({ silent })]);
  }
  async function connectGmail() {
    if (!session?.token) return;
    setGmailBusy(true);
    setGmailError('');
    setGmailNotice('');
    try {
      const data = await apiRequest('/auth/integrations/gmail/connect');
      if (!data.auth_url) throw new Error('Google connection URL was not returned');
      window.location.href = data.auth_url;
    } catch (err) {
      setGmailError(err.message || 'Could not start Gmail connection');
      setGmailBusy(false);
    }
  }
  async function disconnectGmail(connectionId) {
    if (!session?.token || !connectionId) return;
    if (!window.confirm('Disconnect this Gmail mailbox? Email history will stay, but new sync will stop.')) return;
    setGmailBusy(true);
    setGmailError('');
    setGmailNotice('');
    try {
      const res = await apiRequest('/auth/integrations/gmail/disconnect', {
        method: 'POST',
        body: { connection_id: connectionId },
      });
      setGmailNotice(res.message || 'Gmail disconnected');
      await loadGmailIntegration();
    } catch (err) {
      setGmailError(err.message || 'Could not disconnect Gmail');
    } finally {
      setGmailBusy(false);
    }
  }
  async function startGmailWatch(connectionId) {
    if (!session?.token || !connectionId) return;
    setGmailBusy(true);
    setGmailError('');
    setGmailNotice('');
    try {
      const body = { connection_id: connectionId };
      if (viewOrgId) body.org_id = viewOrgId.id;
      const res = await apiRequest('/auth/integrations/gmail/watch/start', {
        method: 'POST',
        body,
      });
      setGmailNotice(res.message || 'Gmail realtime listener started');
      await refreshSupport();
    } catch (err) {
      setGmailError(err.message || 'Could not start Gmail listener');
    } finally {
      setGmailBusy(false);
    }
  }

  async function loadOrgs() {
    if (!session?.token) return;
    setOrgsLoading(true);
    setOrgsError('');
    try { setOrgs(await apiRequest('/auth/onboarding/orgs')); }
    catch (err) { setOrgsError(err.message || 'Could not load organizations'); }
    finally { setOrgsLoading(false); }
  }
  async function loadPatients() {
    if (!session?.token) return;
    setPatientsLoading(true);
    setPatientsError('');
    try {
      const qs = new URLSearchParams();
      if (viewOrgId) qs.set('org_id', String(viewOrgId.id));
      if (patientsQuery.trim()) qs.set('q', patientsQuery.trim());
      if (patientsSort && patientsSort !== 'latest') qs.set('sort', patientsSort);
      if (patientsOutcome && patientsOutcome !== 'all') qs.set('outcome', patientsOutcome);
      qs.set('page', String(patientsPage));
      qs.set('page_size', '25');
      setPatients(await apiRequest('/auth/patients?' + qs.toString()));
    } catch (err) { setPatientsError(err.message || 'Could not load patients'); }
    finally { setPatientsLoading(false); }
  }
  async function loadPatientDetail(pid) {
    if (!session?.token || !pid) return;
    setPatientDetailLoading(true);
    setPatientDetailError('');
    try {
      const qs = new URLSearchParams();
      qs.set('patient_id', pid);
      if (viewOrgId) qs.set('org_id', String(viewOrgId.id));
      const data = await apiRequest('/auth/patient-history?' + qs.toString());
      const requests = data.requests || [];
      setPatientDetail({ patient_id: data.patient_id || pid, requests });
      // Default-expand every PA row so the operator sees all decisions at once
      // (their explicit ask). They can collapse individual rows from there.
      setOpenedPaIds(new Set(requests.map((r) => r.request_id)));
    } catch (err) {
      setPatientDetail({ patient_id: pid, requests: [] });
      setPatientDetailError(err.message || 'Could not load patient');
    } finally { setPatientDetailLoading(false); }
  }
  async function downloadPatientPdf() {
    if (!patientDetail || !patientDetail.patient_id) return;
    // 1. Record the export to the server-side audit trail (non-blocking — if
    //    it fails we still let the operator print, but they'll see a toast).
    try {
      await apiRequest('/auth/audit/log-event', {
        method: 'POST',
        body: {
          event_type: 'pdf_download',
          target_kind: 'patient',
          target_id: patientDetail.patient_id,
          metadata: { pa_count: (patientDetail.requests || []).length },
        },
      });
    } catch (_e) { /* non-blocking */ }
    // 2. Make sure every PA row is expanded so the printout includes all detail.
    setOpenedPaIds(new Set((patientDetail.requests || []).map((r) => r.request_id)));
    // 3. Set document.title to drive the "Save as PDF" filename. Browsers use
    //    document.title as the suggested name in the print → save dialog. We
    //    want PatientName_OrgName — and the org is the *patient's* org (the
    //    HMO the PAs belong to), never SaaSPro even when a platform admin is
    //    drilled in.
    // Take the first request that actually has a patient_name. Some rows
    // come from the queue without the enrollee name populated, so we don't
    // want to fall back to the raw patient_id if there's a real name elsewhere
    // in the history.
    const namedReq = (patientDetail.requests || []).find((r) => r && r.patient_name && r.patient_name.trim());
    const rawName = (namedReq && namedReq.patient_name) || patientDetail.patient_id || 'patient';
    // The patient belongs to whichever org the platform admin is drilled
    // into; if no drill-in then it's the operator's own org. Either way it's
    // the patient's HMO, not the platform.
    const rawOrg = viewOrgId?.name || session.org_name || 'org';
    const sanitize = (s) => String(s)
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')   // strip accents
      .replace(/[^A-Za-z0-9 _-]+/g, '')                    // drop punctuation
      .trim().replace(/\s+/g, '_')                          // spaces → _
      .slice(0, 80) || 'untitled';
    const filename = `${sanitize(rawName)}_${sanitize(rawOrg)}`;
    const originalTitle = document.title;
    document.title = filename;
    const restoreTitle = () => {
      document.title = originalTitle;
      window.removeEventListener('afterprint', restoreTitle);
    };
    window.addEventListener('afterprint', restoreTitle);
    // Belt-and-braces: also restore after a delay in case afterprint never
    // fires (some browsers / cancelled dialogs swallow it).
    setTimeout(restoreTitle, 30_000);
    // 4. Wait for the render to settle, then trigger the browser print dialog.
    await new Promise((r) => setTimeout(r, 200));
    window.print();
  }
  function navigateTo({ nav, patient_id }) {
    const params = new URLSearchParams(window.location.search);
    if (nav != null) {
      if (nav === 'intake') params.delete('nav'); else params.set('nav', nav);
    }
    if (patient_id != null) {
      if (patient_id) params.set('patient', patient_id); else params.delete('patient');
    }
    const qs = params.toString();
    const next = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    if (next !== window.location.pathname + window.location.search) {
      window.history.pushState({}, '', next);
    }
    if (nav != null) setActiveNav(nav);
    if (patient_id != null) {
      setSelectedPatientId(patient_id);
      setOpenedPaIds(new Set()); // reset expanded rows when switching patients
    }
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
  async function renameOrg(o) {
    const next = window.prompt(`Rename "${o.name}" to:`, o.name);
    if (next === null) return;
    const name = next.trim();
    if (!name || name === o.name) return;
    try {
      await apiRequest(`/auth/onboarding/orgs/${o.id}`, { method: 'PATCH', body: { name } });
      await loadOrgs();
    } catch (err) {
      window.alert('Rename failed: ' + (err.message || 'unknown error'));
    }
  }
  async function setOrgActive(o, active) {
    const verb = active ? 'Reactivate' : 'Deactivate';
    if (!window.confirm(`${verb} "${o.name}"?`)) return;
    try {
      await apiRequest(`/auth/onboarding/orgs/${o.id}`, { method: 'PATCH', body: { is_active: active } });
      await loadOrgs();
    } catch (err) {
      window.alert(`${verb} failed: ` + (err.message || 'unknown error'));
    }
  }

  function signOut() {
    localStorage.removeItem(STORAGE_KEY);
    setSession(null);
    setDashboard(null);
    setSelectedId('');
    setDrawerOpen(false);
    setViewOrgId(null);
  }
  // URL ⇄ viewOrgId helpers. The drill-in target lives in `?org=N` so a
  // hard reload, copy/paste URL, or browser back/forward restores it.
  function urlSetOrg(orgId) {
    const params = new URLSearchParams(window.location.search);
    if (orgId == null) params.delete('org'); else params.set('org', String(orgId));
    const qs = params.toString();
    const next = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    if (next !== window.location.pathname + window.location.search) {
      window.history.pushState({}, '', next);
    }
  }
  function enterDrillIn(org) {
    setSwitchingOrg(true);
    setViewOrgId({ id: org.id, name: org.name });
    setActiveNav('intake');
    setSelectedId('');
    setCurrentPage(1);
    setPatientsPage(1);
    setPatientDetail(null);
    setPaEvents({ checkin_id: null, events: [], loading: false, error: '' });
    setDrawerOpen(false);
    setDashboard(null);
    urlSetOrg(org.id);
  }
  function clearOrgSelection() {
    setSwitchingOrg(true);
    setViewOrgId(null);
    setSelectedId('');
    setCurrentPage(1);
    setPatientsPage(1);
    setPatientDetail(null);
    setPaEvents({ checkin_id: null, events: [], loading: false, error: '' });
    setDrawerOpen(false);
    setDashboard(null);
    urlSetOrg(null);
  }
  function exitViewAs() {
    clearOrgSelection();
    setActiveNav('onboarding');
  }

  // After login: parse ?org= and restore drill-in. Non-platform-admins ignore it.
  // The org name is resolved from the loaded orgs list, or shows '…' until
  // the list lands. Also fires loadOrgs if the list isn't loaded yet.
  useEffect(() => {
    if (!session?.token) return;
    const isSuper = (session.role === 'admin') && ((session.org_name || '').toUpperCase() === 'SAASPRO');
    if (isSuper && !orgs && !orgsLoading) loadOrgs();
    if (!isSuper) {
      if (viewOrgId) { setSwitchingOrg(true); setViewOrgId(null); urlSetOrg(null); }
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const want = params.get('org');
    if (!want) {
      if (viewOrgId) { setSwitchingOrg(true); setViewOrgId(null); }
      return;
    }
    const wantId = Number(want);
    if (!Number.isFinite(wantId)) return;
    const list = (orgs && Array.isArray(orgs.orgs)) ? orgs.orgs : (Array.isArray(orgs) ? orgs : []);
    const match = list.find((o) => o.id === wantId);
    if (match) {
      if (!viewOrgId || viewOrgId.id !== wantId || viewOrgId.name !== match.name) {
        setSwitchingOrg(true);
        setViewOrgId({ id: wantId, name: match.name });
      }
    } else {
      if (!viewOrgId || viewOrgId.id !== wantId) { setSwitchingOrg(true); setViewOrgId({ id: wantId, name: '…' }); }
      if (!orgs && !orgsLoading) loadOrgs();
    }
    // eslint-disable-next-line
  }, [session?.token, session?.role, session?.org_name, orgs]);

  // Browser back/forward: re-sync drill-in from the URL.
  useEffect(() => {
    if (!session?.token) return undefined;
    const isSuper = (session.role === 'admin') && ((session.org_name || '').toUpperCase() === 'SAASPRO');
    if (!isSuper) return undefined;
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      const want = params.get('org');
      if (!want) { setSwitchingOrg(true); setViewOrgId(null); return; }
      const wantId = Number(want);
      if (!Number.isFinite(wantId)) return;
      const list = (orgs && Array.isArray(orgs.orgs)) ? orgs.orgs : (Array.isArray(orgs) ? orgs : []);
      const match = list.find((o) => o.id === wantId);
      setSwitchingOrg(true);
      setViewOrgId({ id: wantId, name: match ? match.name : '…' });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
    // eslint-disable-next-line
  }, [session?.token, session?.role, session?.org_name, orgs]);

  useEffect(() => { if (session?.token) loadDashboard(); /* eslint-disable-next-line */ }, [session?.token, viewOrgId, currentPage, dateFrom, dateTo, debouncedQuery]);
  // Debounce the search box: wait 300ms after last keystroke before fetching.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);
  // When the effective search changes, jump back to page 1.
  useEffect(() => { setCurrentPage(1); }, [debouncedQuery]);
  useEffect(() => {
    if (!session?.token) return undefined;
    const t = setInterval(() => loadDashboard({ silent: true }), 15000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [session?.token, viewOrgId, currentPage, dateFrom, dateTo, debouncedQuery]);

  useEffect(() => {
    if (!session?.token) return;
    if (activeNav === 'audit') loadAudit('');
    if (activeNav === 'team' && !team) loadTeam();
    if (activeNav === 'apikey' && !apikey) loadApiKey();
    if (activeNav === 'onboarding' && !orgs) loadOrgs();
    if (activeNav === 'patients' && !patients) loadPatients();
    if (activeNav === 'support') refreshSupport();
    // eslint-disable-next-line
  }, [session?.token, activeNav, viewOrgId]);

  useEffect(() => {
    if (!session?.token || activeNav !== 'support') return undefined;
    const id = window.setInterval(() => {
      refreshSupport({ silent: true });
    }, 10000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line
  }, [session?.token, activeNav, viewOrgId]);

  useEffect(() => {
    if (!session?.token) return;
    const params = new URLSearchParams(window.location.search);
    const gmailStatus = params.get('gmail');
    if (!gmailStatus) return;
    const detail = params.get('detail');
    setActiveNav('support');
    if (gmailStatus === 'connected') {
      setGmailNotice(detail ? `Gmail connected: ${detail}` : 'Gmail connected');
    } else if (gmailStatus === 'error') {
      setGmailError(detail || 'Gmail connection failed');
    }
    params.delete('gmail');
    params.delete('detail');
    params.set('nav', 'support');
    const qs = params.toString();
    window.history.replaceState({}, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
    // eslint-disable-next-line
  }, [session?.token]);

  useEffect(() => {
    if (!session?.token || activeNav !== 'health') return;
    loadHealth();
    // eslint-disable-next-line
  }, [session?.token, activeNav, viewOrgId, healthDateFrom, healthDateTo, healthStatus, healthLimit]);

  // Refetch the patients list when the active filters change.
  useEffect(() => {
    if (!session?.token || activeNav !== 'patients') return;
    loadPatients();
    // eslint-disable-next-line
  }, [session?.token, viewOrgId, patientsQuery, patientsSort, patientsOutcome, patientsPage]);

  // Fetch the selected patient's detail when ?patient= is set.
  useEffect(() => {
    if (!session?.token || activeNav !== 'patients' || !selectedPatientId) {
      if (!selectedPatientId && patientDetail) setPatientDetail(null);
      return;
    }
    if (patientDetail?.patient_id === selectedPatientId) return;
    loadPatientDetail(selectedPatientId);
    // eslint-disable-next-line
  }, [session?.token, activeNav, selectedPatientId, viewOrgId]);

  // Browser back/forward — re-sync nav + patient from the URL.
  useEffect(() => {
    if (!session?.token) return undefined;
    const onPop = () => {
      const params = new URLSearchParams(window.location.search);
      const nextNav = params.get('nav') || 'intake';
      const nextPatient = params.get('patient') || '';
      setActiveNav(nextNav);
      setSelectedPatientId(nextPatient);
      if (!nextPatient) setOpenedPaIds(new Set());
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [session?.token]);

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

  // Resolve `selected` from the current page first; fall back to the loaded
  // patient history so clicking a sibling whose row sits on another page still
  // opens the right record without forcing a queue refetch.
  const selected = requests.find((r) => r.request_id === selectedId)
    || (patientHistory.requests || []).find((r) => r.request_id === selectedId)
    || null;
  const siblings = (selected && patientHistory.patient_id === selected.patient_id)
    ? patientHistory.requests.filter((r) => r.request_id !== selected.request_id)
    : [];
  const eventsForSelected = (selected && paEvents.checkin_id === (selected.display_request_id || selected.request_id))
    ? paEvents.events : [];

  // Fetch the PA event timeline for the drawer's selected request. Keyed on
  // the check-in id (or request_id fallback) — what kalycoding's endpoint
  // expects. Resets when the selection changes or the drawer closes.
  useEffect(() => {
    if (!selected) {
      setPaEvents({ checkin_id: null, events: [], loading: false, error: '' });
      return undefined;
    }
    const checkin = selected.display_request_id || selected.request_id;
    if (paEvents.checkin_id === checkin) return undefined;
    let cancelled = false;
    setPaEvents((s) => ({ ...s, loading: true, error: '' }));
    (async () => {
      try {
        const qs = new URLSearchParams();
        qs.set('checkin_id', checkin);
        qs.set('include_payload', 'true');
        qs.set('limit', '25');
        if (viewOrgId) qs.set('org_id', String(viewOrgId.id));
        const data = await apiRequest('/auth/preauth-events?' + qs.toString());
        const events = asArr(data?.events).sort((a, b) => (_evtNum(a.event_sequence) || 0) - (_evtNum(b.event_sequence) || 0));
        if (!cancelled) setPaEvents({ checkin_id: checkin, events, loading: false, error: '' });
      } catch (err) {
        if (!cancelled) setPaEvents({ checkin_id: checkin, events: [], loading: false, error: err?.message || 'Could not load event history' });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [selected?.request_id, viewOrgId]);

  // Fetch the full PA history for the patient whose drawer is open. Skips bare
  // 'unknown' / '—' so we don't try to lump unrelated parse-failure rows.
  useEffect(() => {
    const pid = selected?.patient_id || '';
    if (!selected || !pid || pid === '—' || pid.toLowerCase() === 'unknown') {
      setPatientHistory({ patient_id: null, requests: [] });
      return undefined;
    }
    if (patientHistory.patient_id === pid) return undefined; // already loaded
    let cancelled = false;
    (async () => {
      try {
        const qs = new URLSearchParams();
        qs.set('patient_id', pid);
        if (viewOrgId) qs.set('org_id', String(viewOrgId.id));
        const data = await apiRequest('/auth/patient-history?' + qs.toString());
        if (!cancelled) setPatientHistory({ patient_id: data.patient_id || pid, requests: data.requests || [] });
      } catch (_e) {
        if (!cancelled) setPatientHistory({ patient_id: pid, requests: [] });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line
  }, [selected?.patient_id, viewOrgId]);

  function openRequest(id) { setSelectedId(id); setDrawerOpen(true); }

  if (!session) {
    if (isInviteRegistrationRoute()) {
      return <Register onRegistered={acceptSession} />;
    }
    return <Login email={email} setEmail={setEmail} password={password} setPassword={setPassword} onSubmit={handleLogin} error={loginError} loading={loginLoading} />;
  }

  const refreshedLabel = loading ? 'Refreshing…' : (lastLoaded ? `Refreshed ${timeAgo(new Date(lastLoaded).toISOString())}` : 'Connecting…');
  // Platform admin = admin of the SaaSPro platform org. There's no separate
  // role tier — this is just "admin + org is SAASPRO". An admin of any other
  // org (e.g. AMAN) is just an admin of that org.
  const isPlatformAdmin = (session.role === 'admin') && ((session.org_name || '').toUpperCase() === 'SAASPRO');
  const isDrillIn = !!(viewOrgId && viewOrgId.name !== session.org_name);
  const canRetryRequests = session.role === 'admin';
  const statusFilters = ['all', 'approve', 'deny', 'escalate', 'processing', 'pending', 'received', 'error'];

  // chart inputs from the real daily series + summary
  const periodRequestCount = summary.total ?? requests.length;
  const dayLabels = series.map((d) => d.day.slice(5));
  const dayTooltipLabels = series.map((d) => d.day);
  const recvSeries = series.map((d) => d.received);
  const latSeries = series.map((d) => d.avg_latency);
  const paValueReceived = Number(summary.intake_value ?? summary.current_snapshot_value ?? 0);
  const paValueApproved = Number(summary.total_amount_approved ?? 0);
  const paLineItems = summary.added_line_items ?? summary.current_snapshot_line_items ?? 0;
  const decided = (summary.approved || 0) + (summary.denied || 0) + (summary.escalated || 0);
  const approvalRate = decided ? Math.round((summary.approved / decided) * 100) : 0;
  const visibleRetryableCount = filtered.filter((r) => RETRYABLE_REQUEST_STATUSES.has(r.status)).length;
  const retryableSummaryCount = (summary.pending || 0) + (summary.processing || 0) + (summary.errors || 0);
  const outcomeSplit = [
    { k: 'Approved', v: summary.approved || 0, c: 'var(--ok)' },
    { k: 'Denied', v: summary.denied || 0, c: 'var(--bad)' },
    { k: 'Escalated', v: summary.escalated || 0, c: 'var(--warn)' },
    { k: 'Pending', v: (summary.pending || 0) + (summary.processing || 0), c: 'var(--ink-4)' },
  ];
  const avgLatTxt = summary.avg_processing_seconds != null ? Number(summary.avg_processing_seconds).toFixed(1) : '—';

  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      <StatusBar
        session={session}
        role={role}
        onRole={setRole}
        refreshedLabel={refreshedLabel}
        isPlatformAdmin={isPlatformAdmin}
        orgs={orgs}
        orgsLoading={orgsLoading}
        orgsError={orgsError}
        viewOrgId={viewOrgId}
        onSelectOrg={enterDrillIn}
        onClearOrg={clearOrgSelection}
        onLoadOrgs={loadOrgs}
      />
      <Sidebar
        active={activeNav}
        onNav={(id) => {
          // Switching to a different top-level nav drops any open drawer +
          // patient-detail selection. Patients page keeps its own ?patient= state.
          navigateTo({ nav: id, patient_id: id === 'patients' ? undefined : '' });
          setDrawerOpen(false);
          setRevealedKey('');
          setApikeyNotice('');
          setTeamNotice('');
        }}
        session={session}
        intakeCount={summary.received_24h ?? 0}
        collapsed={collapsed}
        onToggleCollapse={toggleSidebar}
        isPlatformAdmin={isPlatformAdmin}
        onSignOut={signOut}
      />

      <main className="main">
        {isDrillIn ? (
          <div className="ro-banner" style={{ display: 'flex', alignItems: 'center', marginBottom: 14, background: 'var(--tint)', borderColor: 'var(--indigo-soft)', color: 'var(--indigo)' }}>
            <span className="led" style={{ background: 'var(--indigo)' }} />
            <span>
              Viewing as platform admin · scoped to <b>{viewOrgId.name}</b>
              <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                Read-only drill-in — changes you make would land in <b>{session.org_name}</b>, so write actions are hidden. Switch back to manage <b>{viewOrgId.name}</b>'s team, keys or org settings via their own admin.
              </span>
            </span>
            <button className="btn sm" onClick={exitViewAs} style={{ marginLeft: 'auto' }} data-tip="Returns to your own org (SaaSPro). Drops the ?org= param from the URL." data-tip-pos="below" data-tip-align="right">← Back to platform view</button>
          </div>
        ) : null}
        {activeNav === 'intake' ? (
          <section id="view-intake">
            <div className="ro-banner"><span className="led" style={{ background: 'var(--recv)' }} /> Read-only view — you're signed in as a member. Operational data is visible; actions are disabled.</div>

            <div className="page-head">
              <div>
                <h1 className="page-title">Pre-Authorization</h1>
                <p className="page-sub">
                  <span className="cal" aria-hidden="true"><IconCal /></span>
                  {(() => {
                    const fmt = (iso) => {
                      if (!iso) return null;
                      const d = new Date(iso);
                      return isNaN(d) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                    };
                    const dw = dashboard?.meta?.data_window || {};
                    const haveFilter = !!(dateFrom || dateTo);
                    const fromStr = haveFilter ? (fmt(dateFrom) || 'start') : fmt(dw.earliest);
                    const toStr = haveFilter ? (fmt(dateTo) || 'today') : fmt(dw.latest);
                    const periodLabel = (fromStr && toStr)
                      ? `${fromStr} → ${toStr}`
                      : (fromStr || toStr || 'No data yet');
                    return (
                      <>
                        <span data-tip="Earliest and latest received_at of PAs in this org. Active filters override this window.">{periodLabel}</span>
                        {haveFilter ? <span className="muted" style={{ marginLeft: 6 }} data-tip="A toolbar date filter is active. Clear it to see the full data window.">(filtered)</span> : null}
                        <span style={{ margin: '0 8px', opacity: 0.4 }}>·</span>
                        <span data-tip="Auto-refreshes every 15s.">Live</span> · {summary.total ?? requests.length} requests
                      </>
                    );
                  })()}
                </p>
              </div>
              <div className="page-actions">
                {canRetryRequests ? (
                  <button
                    className="btn"
                    disabled={retryAllBusy || loading || (retryableSummaryCount === 0 && visibleRetryableCount === 0)}
                    onClick={retryAllPendingPreauths}
                    data-tip="Safely re-run up to 20 pending, processing, received, and error PAs in the current date/search window."
                    data-tip-pos="below"
                  >
                    {retryAllBusy ? 'Retrying batch…' : 'Retry pending batch'}
                  </button>
                ) : null}
                <button className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => loadDashboard()}><IconRefresh /></button>
                <button className="btn primary" data-admin-only="">Export report <IconExport /></button>
              </div>
            </div>

            <div className="tabs">
              <button className={activeTab === 'dashboard' ? 'on' : ''} onClick={() => setActiveTab('dashboard')}>Dashboard</button>
              <button className={activeTab === 'chat' ? 'on' : ''} onClick={() => setActiveTab('chat')}>Chat</button>
            </div>

            {activeTab === 'dashboard' ? (
              <div id="tab-dashboard" className="loading-host dashboard-loading-host">
                <LoadingOverlay show={loading} label={switchingOrg ? 'Switching organization' : (dashboard ? 'Updating dashboard' : 'Loading dashboard')} />
                {retryNotice ? <div className="ro-banner" style={{ display: 'flex', marginTop: 18, background: 'var(--ok-bg)', borderColor: 'var(--ok-line)', color: 'var(--ok-ink)' }}><span className="led" style={{ background: 'var(--ok)' }} /> {retryNotice}</div> : null}
                {retryError ? <div className="ro-banner" style={{ display: 'flex', marginTop: 18, background: 'var(--bad-bg)', borderColor: 'var(--bad-line)', color: 'var(--bad-ink)' }}><span className="led" style={{ background: 'var(--bad)' }} /> {retryError}</div> : null}
                <div className="section-gap" style={{ marginTop: 24 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
                    <h2 style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 500, margin: 0 }}>Queue filters</h2>
                    <span className="muted mono" style={{ fontSize: 12 }}>{filtered.length} request{filtered.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="toolbar" style={{ marginBottom: 0, flexWrap: 'wrap' }}>
                    <div className="search" style={{ minWidth: 240, flex: '1 1 240px' }}>
                      <IconSearch />
                      <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search reference, patient, provider, plan, item, facility…"
                        data-tip="Searches patient ID, request ID, decision, and the full webhook payload (names, facilities, plans, item descriptions). Server-side, across all pages."
                        data-tip-pos="below"
                        data-tip-align="left"
                      />
                    </div>
                    <DateRangeFilter dateFrom={dateFrom} dateTo={dateTo} setDateFrom={setDateFrom} setDateTo={setDateTo} onChange={() => setCurrentPage(1)} loading={loading} />
                    {statusFilters.map((s) => (
                      <button
                        key={s}
                        className={`statbtn ${statusFilter === s ? 'on' : ''}`}
                        onClick={() => setStatusFilter(s)}
                        data-tip={s === 'all' ? 'Show requests of every status.' : (STATUS_META[s]?.help || undefined)}
                        data-tip-pos="below"
                      >{s === 'all' ? 'All' : (STATUS_META[s]?.label || s)}</button>
                    ))}
                  </div>
                </div>

                <div className="grid-2 section-gap" style={{ marginTop: 24 }}>
                  <MetricCard
                    title="Requests received"
                    tip="Inbound webhook count over the period. Includes parse-failed deliveries that never made it to a PA."
                    desc="Inbound pre-auth volume across the period"
                    big={`${periodRequestCount} <small>this period</small>`}
                    chartHtml={chartBars(recvSeries, { accent: 'var(--ink-3)', labels: dayLabels, tooltipLabels: dayTooltipLabels, suffix: ' requests' })}
                    moveH="Inbound volume"
                    moveP={`${periodRequestCount} requests this period. ${summary.processing ?? 0} processing and ${summary.pending ?? 0} pending a first decision.`}
                  />
                  <ValuePairMetricCard
                    received={paValueReceived}
                    approved={paValueApproved}
                    lineItems={paLineItems}
                    eventCount={summary.event_count ?? 0}
                  />
                  <MetricCard
                    title="Decision outcomes"
                    tip="Distribution of final decisions for this period: Approve, Deny, Escalate."
                    desc="How the AI pipeline resolved this period's requests"
                    chartHtml={chartDonut(outcomeSplit)}
                    moveH={`${approvalRate}% approval rate`}
                    moveP={`${(summary.approved ?? 0).toLocaleString()} approved, ${summary.denied ?? 0} denied, ${summary.escalated ?? 0} escalated for human review.`}
                  />
                  <MetricCard
                    title="Decision latency"
                    tip="Average seconds from when a PA was received to when the agent finished deciding. Excludes still-processing PAs."
                    desc="Time from received → decided"
                    big={`${avgLatTxt}<small>s avg</small>`}
                    chartHtml={chartLine(latSeries, { accent: 'var(--indigo)', labels: dayLabels, tooltipLabels: dayTooltipLabels, suffix: 's' })}
                    moveH="Seconds, not minutes"
                    moveP={`Average decision latency is ${avgLatTxt}s versus a ~30-minute manual baseline.`}
                  />
                </div>

                <div className="section-gap" style={{ marginTop: 34 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
                    <h2 style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 500, margin: 0 }}>Request queue</h2>
                    <span className="muted mono" style={{ fontSize: 12 }}>{filtered.length} request{filtered.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="queue loading-host">
                    <LoadingOverlay show={loading && !!requests.length} label="Loading pre-auths" />
                    <QueueHead />
                    <div>
                      {filtered.map((r) => (
                        <QueueRow
                          key={r.request_id}
                          r={r}
                          selected={selected?.request_id === r.request_id && drawerOpen}
                          onSelect={openRequest}
                          onOpenPatient={(pid) => navigateTo({ nav: 'patients', patient_id: pid })}
                          canRetry={canRetryRequests}
                          retrying={retryingRequests.has(r.request_id)}
                          onRetry={retryPreauthRequest}
                        />
                      ))}
                      {!filtered.length && (
                        <div className="stub-empty" style={{ padding: '60px 24px' }}>
                          <div className="ph">▤</div><h4>No requests</h4>
                          <p>{error ? error : 'Incoming webhook requests will appear here after processing.'}</p>
                        </div>
                      )}
                    </div>
                    {(dashboard?.pagination?.total_pages || 0) > 1 ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, padding: '14px 16px', borderTop: '1px solid var(--line)', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--ink-3)' }}>
                        <span>Page {currentPage} of {dashboard.pagination.total_pages} · {dashboard.pagination.total.toLocaleString()} requests</span>
                        <button className="btn sm" disabled={loading || currentPage <= 1} onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}>‹ Prev</button>
                        <button className="btn sm" disabled={loading || currentPage >= dashboard.pagination.total_pages} onClick={() => setCurrentPage((p) => p + 1)}>Next ›</button>
                      </div>
                    ) : null}
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
            {activeNav === 'health' ? (
              <HealthView
                data={health}
                loading={healthLoading}
                error={healthError}
                org={viewOrgId?.name || session.org_name}
                dateFrom={healthDateFrom}
                dateTo={healthDateTo}
                setDateFrom={setHealthDateFrom}
                setDateTo={setHealthDateTo}
                status={healthStatus}
                setStatus={setHealthStatus}
                limit={healthLimit}
                setLimit={setHealthLimit}
              />
            )
              : activeNav === 'patients' ? (
                selectedPatientId
                  ? <PatientDetail
                    patient={patientDetail}
                    loading={patientDetailLoading}
                    error={patientDetailError}
                    openedIds={openedPaIds}
                    toggleRow={(id) => setOpenedPaIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; })}
                    onBack={() => navigateTo({ patient_id: '' })}
                    onDownloadPdf={downloadPatientPdf}
                    session={session}
                    orgName={viewOrgId?.name || session.org_name}
                  />
                  : <PatientsIndex data={patients} loading={patientsLoading} error={patientsError} q={patientsQuery} setQ={setPatientsQuery} sort={patientsSort} setSort={setPatientsSort} outcome={patientsOutcome} setOutcome={setPatientsOutcome} page={patientsPage} setPage={setPatientsPage} onOpenPatient={(pid) => navigateTo({ patient_id: pid })} onBack={() => navigateTo({ nav: 'intake', patient_id: '' })} />
              )
                : activeNav === 'audit' ? <AuditView data={audit} loading={auditLoading} error={auditError} query={auditQuery} setQuery={setAuditQuery} onTrace={() => loadAudit()} />
                  : activeNav === 'team' ? <TeamView data={team} loading={teamLoading} error={teamError} notice={teamNotice} isAdmin={role === 'admin'} org={session.org_name} inviteEmail={inviteEmail} setInviteEmail={setInviteEmail} inviting={inviting} onInvite={inviteMember} onRemove={removeMember} />
                    : activeNav === 'apikey' ? <ApiKeyView data={apikey} error={apikeyError} notice={apikeyNotice} isAdmin={role === 'admin'} org={session.org_name} revealed={revealedKey} busy={apikeyBusy} onGenerate={generateKey} onRevoke={revokeKey} keyName={keyName} setKeyName={setKeyName} />
                      : activeNav === 'onboarding' ? <OnboardingView data={orgs} loading={orgsLoading} error={orgsError} isPlatformAdmin={isPlatformAdmin} orgName={newOrgName} setOrgName={setNewOrgName} adminEmail={newOrgAdminEmail} setAdminEmail={setNewOrgAdminEmail} onCreate={createOrg} creating={creatingOrg} created={createdOrg} createError={createOrgError} onResetCreate={resetCreateOrg} onSelectOrg={enterDrillIn} onRenameOrg={renameOrg} onToggleActive={setOrgActive} />
                        : activeNav === 'support' ? <SupportView data={gmailIntegration} messagesData={supportMessages} messagesLoading={supportMessagesLoading} messagesError={supportMessagesError} selectedMessage={selectedSupportMessage} onSelectMessage={setSelectedSupportMessage} loading={gmailLoading} error={gmailError} notice={gmailNotice} isAdmin={role === 'admin'} isDrillIn={isDrillIn} org={viewOrgId?.name || session.org_name} busy={gmailBusy} onRefresh={refreshSupport} onRefreshMessages={loadSupportMessages} onConnect={connectGmail} onDisconnect={disconnectGmail} onStartWatch={startGmailWatch} />
                          : <StubView id={activeNav} session={session} />}
          </section>
        )}
      </main>

      <AskBar context={activeNav === 'intake' ? 'this queue' : 'this view'} />
      <Drawer
        request={selected}
        siblings={siblings}
        onSelectSibling={openRequest}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        paEvents={eventsForSelected}
        paEventsLoading={paEvents.loading}
        paEventsError={paEvents.error}
        onOpenPatient={(pid) => { setDrawerOpen(false); navigateTo({ nav: 'patients', patient_id: pid }); }}
      />
    </div>
  );
}
