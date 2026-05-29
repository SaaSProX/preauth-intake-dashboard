import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Banknote,
  CalendarDays,
  ChevronRight,
  ClipboardList,
  Clock3,
  FileJson,
  Filter,
  Headphones,
  Inbox,
  LogOut,
  MessageSquare,
  RefreshCw,
  Search,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';

const STORAGE_KEY = 'saaspro-preauth-dashboard-session';
const API_BASE_URL = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000');

function normalizeApiBaseUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return 'http://localhost:8000';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

function parseApiDate(value) {
  if (!value || value instanceof Date) return value;
  const text = String(value);
  return /(?:z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
}

function formatDate(value) {
  if (!value) return 'Not processed';
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(parseApiDate(value)));
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return 'Pending';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function formatMoney(value) {
  if (value === null || value === undefined || value === '') return 'Not set';
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return String(value);
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(numeric);
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(parseApiDate(value));
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isToday(value) {
  return value && localDateKey(value) === localDateKey(new Date());
}

function itemRequestedCost(item) {
  if (!item || typeof item !== 'object') return 0;

  const directAmount =
    toNumber(item.requested_cost) ??
    toNumber(item.estimated_cost) ??
    toNumber(item.cost) ??
    toNumber(item.amount);

  if (directAmount !== null) return directAmount;

  const unitCost = toNumber(item.unit_cost);
  const quantity = toNumber(item.quantity) ?? 1;
  return unitCost !== null ? unitCost * quantity : 0;
}

function requestItemsFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return [];

  const paItems = asArray(payload.pa_items);
  if (paItems.length) return paItems;

  const submittedItems = asArray(payload.submission?.items_added);
  if (submittedItems.length) return submittedItems;

  const requestedItems = asArray(payload.requested_items);
  if (requestedItems.length) return requestedItems;

  const items = asArray(payload.items);
  if (items.length) return items;

  return asArray(payload.line_items);
}

function requestedAmountFromRequest(request) {
  const payload = request?.raw_payload && typeof request.raw_payload === 'object' ? request.raw_payload : {};
  const items = requestItemsFromPayload(payload);
  const itemTotal = items.reduce((sum, item) => sum + itemRequestedCost(item), 0);

  return (
    itemTotal ||
    toNumber(payload.total_requested_cost) ||
    toNumber(request?.estimated_cost) ||
    0
  );
}

function providerLabel(value) {
  if (!value) return '';
  if (typeof value === 'object') {
    return value.name || value.role || value.email || JSON.stringify(value);
  }
  return String(value);
}

function enrichRequest(request) {
  const payload = request?.raw_payload && typeof request.raw_payload === 'object' ? request.raw_payload : {};
  const encounter = payload.encounter || {};
  const policy = payload.policy || {};
  const enrollee = payload.enrollee || {};
  const items = requestItemsFromPayload(payload);
  const firstItem = items[0] || {};
  const patientName = [enrollee.first_name, enrollee.surname].filter(Boolean).join(' ');
  const requestedAmount = requestedAmountFromRequest(request);
  const itemLabel =
    items.length > 1
      ? `${items.length} requested items`
      : firstItem.item_name || firstItem.description || request.item_description;

  return {
    ...request,
    display_request_id: encounter.checkin_id || request.request_id,
    patient_id: enrollee.insurance_no || request.patient_id,
    patient_name: patientName,
    plan: policy.plan_name || policy.insurance_package || request.plan,
    item_description: itemLabel,
    estimated_cost: requestedAmount || request.estimated_cost,
    requested_amount: requestedAmount,
    line_item_count: items.length,
    facility: encounter.facility_name || request.facility,
    requesting_provider: providerLabel(request.requesting_provider) || providerLabel(payload.submission?.submitted_by),
  };
}

function normalizeStatus(value) {
  return String(value || 'pending').toLowerCase();
}

function statusClass(value) {
  const status = normalizeStatus(value);
  if (['approve', 'approved', 'pass'].includes(status)) return 'status success';
  if (['deny', 'denied', 'reject', 'rejected', 'fail', 'error'].includes(status)) return 'status danger';
  if (['escalate', 'escalated'].includes(status)) return 'status warning';
  if (status === 'processing') return 'status info';
  return 'status neutral';
}

function prettyStatus(value) {
  const status = normalizeStatus(value);
  if (status === 'approve') return 'Approved';
  if (status === 'deny') return 'Denied';
  if (status === 'escalate') return 'Escalated';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function isLiveAmanPayload(request) {
  return request?.raw_payload?.event_type === 'pa.submitted';
}

function requestStatusLabel(request) {
  return isLiveAmanPayload(request) ? 'Received' : prettyStatus(request?.status);
}

function requestStatusClass(request) {
  return isLiveAmanPayload(request) ? 'status info' : statusClass(request?.status);
}

function eventValue(event) {
  return toNumber(event?.items_added_total) ?? toNumber(event?.total_requested_cost) ?? 0;
}

function eventItemCount(event) {
  return toNumber(event?.items_added_count) ?? toNumber(event?.item_count) ?? 0;
}

function closeNumberMatch(left, right) {
  const leftNumber = toNumber(left);
  const rightNumber = toNumber(right);
  return leftNumber !== null && rightNumber !== null && Math.abs(leftNumber - rightNumber) < 0.01;
}

function itemsAddedFromEvent(event) {
  const payload = event?.raw_payload && typeof event.raw_payload === 'object' ? event.raw_payload : {};
  const addedItems = asArray(payload.submission?.items_added);
  const paItems = asArray(payload.pa_items);
  const usedItemKeys = new Set();

  if (addedItems.length) {
    return addedItems.map((item, index) => {
      const id = item?.id;
      const candidates = paItems
        .map((paItem, paIndex) => ({ paItem, paIndex }))
        .filter(({ paItem, paIndex }) => {
          const key = paItem?.claim_item_id || `${paItem?.facility_tariff_item_id || 'item'}-${paIndex}`;
          if (usedItemKeys.has(key)) return false;
          return (
            String(paItem?.facility_tariff_item_id || '') === String(id || '') ||
            String(paItem?.claim_item_id || '') === String(id || '')
          );
        })
        .sort((left, right) => {
          const score = ({ paItem }) => {
            const quantityMatches = closeNumberMatch(paItem?.quantity, item?.quantity);
            const amountMatches = closeNumberMatch(paItem?.requested_cost, item?.requested_cost);
            const isPending = normalizeStatus(paItem?.status) === 'pending';
            if (quantityMatches && amountMatches && isPending) return 0;
            if (quantityMatches && amountMatches) return 1;
            if (isPending) return 2;
            return 3;
          };
          return score(left) - score(right);
        });
      const matchedItem = candidates[0]?.paItem;
      const matchedKey = matchedItem?.claim_item_id || (
        matchedItem ? `${matchedItem?.facility_tariff_item_id || 'item'}-${candidates[0]?.paIndex}` : null
      );
      if (matchedKey) usedItemKeys.add(matchedKey);

      return {
        id: matchedItem?.claim_item_id || `${event?.event_id || 'event'}-${index}-${id || 'item'}`,
        name: matchedItem?.item_name || matchedItem?.description || matchedItem?.name || `Item ${id || index + 1}`,
        quantity: item?.quantity ?? matchedItem?.quantity ?? 1,
        requested_cost: toNumber(item?.requested_cost) ?? itemRequestedCost(matchedItem || item),
      };
    });
  }

  return paItems.map((item, index) => ({
    id: item?.claim_item_id || item?.facility_tariff_item_id || `${event?.event_id || 'event'}-${index}`,
    name: item?.item_name || item?.description || item?.name || `Item ${index + 1}`,
    quantity: item?.quantity ?? 1,
    requested_cost: itemRequestedCost(item),
  }));
}

function resultSummary(result) {
  if (!result || typeof result !== 'object') return 'No structured result captured yet.';
  return (
    result.reasoning ||
    result.reason ||
    result.denial_reason ||
    result.escalation_reason ||
    result.exclusion_detail ||
    result.plan_restriction_detail ||
    'Result captured.'
  );
}

function agentOutcome(log) {
  const result = log?.result;
  if (result && typeof result === 'object') {
    if (result.pass === true) return 'pass';
    if (result.pass === false) return 'fail';
    if (result.decision) return result.decision;
  }
  return log?.status || 'pending';
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function App() {
  const [session, setSession] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
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
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [activeTab, setActiveTab] = useState('preauth');
  const [requestEvents, setRequestEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState('');

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
      const data = await apiRequest('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      const nextSession = {
        token: data.token,
        role: data.role,
        name: data.name,
        org_name: data.org_name,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSession));
      setSession(nextSession);
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
      const params = new URLSearchParams();
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      const queryString = params.toString();
      const data = await apiRequest(`/auth/preauth-dashboard${queryString ? `?${queryString}` : ''}`);
      setDashboard(data);
      const requests = data?.requests || [];
      setSelectedId((current) => {
        if (current && requests.some((request) => request.request_id === current)) return current;
        return requests[0]?.request_id || '';
      });
    } catch (err) {
      if (/token expired/i.test(err.message || '')) {
        signOut();
        setLoginError('Session expired. Please sign in again.');
        return;
      }

      setError(
        err.message === 'Not Found'
          ? 'Dashboard endpoint is not available yet. Restart the backend so the new route is loaded.'
          : err.message || 'Could not load dashboard'
      );
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

  useEffect(() => {
    if (session?.token) {
      loadDashboard();
    }
  }, [session?.token, dateFrom, dateTo]);

  useEffect(() => {
    if (!session?.token || !autoRefresh) return undefined;
    const timer = window.setInterval(() => loadDashboard({ silent: true }), 15000);
    return () => window.clearInterval(timer);
  }, [session?.token, autoRefresh, dateFrom, dateTo]);

  const rawRequests = dashboard?.requests || [];
  const summary = dashboard?.summary || {};
  const requests = useMemo(() => rawRequests.map(enrichRequest), [rawRequests]);
  const todayRequests = useMemo(
    () => requests.filter((request) => isToday(request.received_at)),
    [requests]
  );
  const todaySnapshotAmount = todayRequests.reduce((sum, request) => sum + (request.requested_amount || 0), 0);
  const todaySnapshotLineItems = todayRequests.reduce((sum, request) => sum + (request.line_item_count || 0), 0);
  const hasDateFilter = Boolean(dateFrom || dateTo);
  const displayedRequestCount = hasDateFilter
    ? (toNumber(summary.unique_pa_count) ?? requests.length)
    : (toNumber(summary.today_unique_pa_count) ?? todayRequests.length ?? summary.received_24h ?? 0);
  const displayedPaValue = hasDateFilter
    ? (toNumber(summary.intake_value) ?? todaySnapshotAmount)
    : (toNumber(summary.today_intake_value) ?? todaySnapshotAmount);
  const displayedLineItems = hasDateFilter
    ? (toNumber(summary.added_line_items) ?? todaySnapshotLineItems)
    : (toNumber(summary.today_added_line_items) ?? todaySnapshotLineItems);
  const allTimePaValue = toNumber(summary.all_time_intake_value) ?? toNumber(summary.intake_value) ?? 0;
  const avgDisplayedAmount = displayedRequestCount ? displayedPaValue / displayedRequestCount : 0;

  const filteredRequests = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return requests.filter((request) => {
      const status = normalizeStatus(request.status);
      const matchesStatus = statusFilter === 'all' || status === statusFilter;
      const searchable = [
        request.request_id,
        request.patient_id,
        request.plan,
        request.item_description,
        request.facility,
        providerLabel(request.requesting_provider),
        request.patient_name,
        request.decision,
        request.status,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return matchesStatus && (!needle || searchable.includes(needle));
    });
  }, [requests, query, statusFilter]);

  const selectedRequest = requests.find((request) => request.request_id === selectedId) || filteredRequests[0];

  useEffect(() => {
    if (!session?.token || activeTab !== 'preauth' || !selectedRequest) {
      setRequestEvents([]);
      setEventsError('');
      setEventsLoading(false);
      return undefined;
    }

    let cancelled = false;

    async function loadRequestEvents() {
      setEventsLoading(true);
      setEventsError('');

      try {
        const params = new URLSearchParams();
        params.set('checkin_id', selectedRequest.display_request_id || selectedRequest.request_id);
        params.set('include_payload', 'true');
        params.set('limit', '25');
        const data = await apiRequest(`/auth/preauth-events?${params.toString()}`);
        if (!cancelled) {
          const events = asArray(data?.events).sort(
            (a, b) => (toNumber(a.event_sequence) || 0) - (toNumber(b.event_sequence) || 0)
          );
          setRequestEvents(events);
        }
      } catch (err) {
        if (!cancelled) {
          setRequestEvents([]);
          setEventsError(err.message || 'Could not load PA event history');
        }
      } finally {
        if (!cancelled) setEventsLoading(false);
      }
    }

    loadRequestEvents();
    return () => {
      cancelled = true;
    };
  }, [session?.token, activeTab, selectedRequest?.request_id, selectedRequest?.display_request_id]);

  const moduleTabs = [
    {
      id: 'preauth',
      label: 'Pre-Auth Intake',
      detail: `${displayedRequestCount || 0} ${hasDateFilter ? 'selected' : 'today'}`,
      icon: ClipboardList,
    },
    {
      id: 'eligibility',
      label: 'Eligibility Checks',
      detail: '0 open',
      icon: UserCheck,
    },
    {
      id: 'support',
      label: 'Support',
      detail: '0 open',
      icon: Headphones,
    },
  ];

  const activeModule = moduleTabs.find((tab) => tab.id === activeTab) || moduleTabs[0];

  const metrics = [
    { label: 'Total requests', value: summary.total || 0, icon: ClipboardList, tone: 'plain' },
    {
      label: hasDateFilter ? 'Selected PAs' : 'Received today',
      value: displayedRequestCount || 0,
      icon: Activity,
      tone: 'info',
    },
    {
      label: hasDateFilter ? 'Selected PA value' : "Today's PA value",
      value: formatMoney(displayedPaValue),
      icon: Banknote,
      tone: 'money',
    },
    { label: 'All-time PA value', value: formatMoney(allTimePaValue), icon: Banknote, tone: 'money' },
    { label: hasDateFilter ? 'Selected line items' : 'Line items today', value: displayedLineItems || 0, icon: FileJson, tone: 'plain' },
    { label: 'Avg value / PA', value: formatMoney(avgDisplayedAmount), icon: Banknote, tone: 'money' },
    {
      label: 'Avg time / PA',
      value: formatDuration(summary.avg_processing_seconds ? Math.round(summary.avg_processing_seconds) : null),
      icon: Clock3,
      tone: 'plain',
    },
  ];

  if (!session) {
    return (
      <main className="loginPage">
        <form className="loginPanel" onSubmit={handleLogin}>
          <div className="loginMark">SL</div>
          <div>
            <p className="eyebrow">Saaspro Labs</p>
            <h1>Pre-Auth Operations</h1>
          </div>

          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="admin@example.com"
              autoComplete="email"
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter password"
              autoComplete="current-password"
              required
            />
          </label>

          {loginError && <div className="formError">{loginError}</div>}

          <button className="primaryButton" type="submit" disabled={loginLoading}>
            {loginLoading ? 'Signing in...' : 'Sign in'}
          </button>

          <span className="apiBase">Backend: {API_BASE_URL}</span>
        </form>
      </main>
    );
  }

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="sidebarBrand">
          <div className="brandMark">SL</div>
          <div>
            <p className="eyebrow">Saaspro Labs</p>
            <h1>Operations Dashboard</h1>
            <span>{session.org_name ? `${session.org_name} operations` : 'Insurance operations'}</span>
          </div>
        </div>

        <nav className="sidebarNav" aria-label="Operations modules">
          {moduleTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                className={`sidebarNavItem ${activeTab === tab.id ? 'active' : ''}`}
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="sidebarNavIcon">
                  <Icon size={18} />
                </span>
                <span>{tab.label}</span>
                <small>{tab.detail}</small>
              </button>
            );
          })}
        </nav>

        <div className="sidebarFooter">
          <div className="userBlock">
            <strong>{session.name}</strong>
            <span>{session.role}</span>
          </div>
          <button className="iconButton fullWidth" type="button" onClick={() => loadDashboard()} title="Refresh dashboard">
            <RefreshCw size={17} />
            Refresh
          </button>
          <button className="iconButton muted fullWidth" type="button" onClick={signOut} title="Sign out">
            <LogOut size={17} />
            Sign out
          </button>
        </div>
      </aside>

      <main className="dashboardMain">
        {error && <div className="bannerError">{error}</div>}

        <section className="moduleSummary">
          <div>
            <span className="smallLabel">Active module</span>
            <h2>{activeModule.label}</h2>
          </div>
          <span>
            {activeTab === 'preauth'
              ? `${formatMoney(displayedPaValue)} ${hasDateFilter ? 'selected' : 'today'}`
              : activeModule.detail}
          </span>
        </section>

        {activeTab === 'preauth' && (
          <>
            <section className="metricsGrid" aria-label="Pre-auth metrics">
              {metrics.map((metric) => {
                const Icon = metric.icon;
                return (
                    <div className={`metricCard ${metric.tone}`} key={metric.label}>
                      <div className="metricIcon">
                        <Icon size={18} />
                      </div>
                      <span>{metric.label}</span>
                      <strong>{metric.value}</strong>
                    </div>
                  );
                })}
            </section>

            <section className="toolbar">
              <div className="searchBox">
                <Search size={17} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search request, patient, provider"
                />
              </div>
              <label className="selectControl">
                <Filter size={16} />
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
                  <option value="all">All statuses</option>
                  <option value="pending">Pending</option>
                  <option value="processing">Processing</option>
                  <option value="approve">Approved</option>
                  <option value="deny">Denied</option>
                  <option value="escalate">Escalated</option>
                  <option value="error">Errors</option>
                </select>
              </label>
              <label className="dateControl">
                <CalendarDays size={16} />
                <span>From</span>
                <input
                  type="date"
                  value={dateFrom}
                  max={dateTo || undefined}
                  onChange={(event) => setDateFrom(event.target.value)}
                />
              </label>
              <label className="dateControl">
                <CalendarDays size={16} />
                <span>To</span>
                <input
                  type="date"
                  value={dateTo}
                  min={dateFrom || undefined}
                  onChange={(event) => setDateTo(event.target.value)}
                />
              </label>
              {(dateFrom || dateTo) && (
                <button
                  className="iconButton compact"
                  type="button"
                  onClick={() => {
                    setDateFrom('');
                    setDateTo('');
                  }}
                >
                  Clear dates
                </button>
              )}
              <label className="refreshToggle">
                <input
                  type="checkbox"
                  checked={autoRefresh}
                  onChange={(event) => setAutoRefresh(event.target.checked)}
                />
                Auto-refresh
              </label>
            </section>

            <section className="workbench">
              <div className="requestsPanel">
                <div className="panelHeader">
                  <div>
                    <h2>Requests</h2>
                    <span>{filteredRequests.length} visible</span>
                  </div>
                  {loading && <span className="loadingText">Loading...</span>}
                </div>

                <div className="requestList">
                  {filteredRequests.map((request) => (
                    <button
                      className={`requestRow ${request.request_id === selectedRequest?.request_id ? 'active' : ''}`}
                      key={request.request_id}
                      type="button"
                      onClick={() => setSelectedId(request.request_id)}
                    >
                      <div className="requestMain">
                        <strong>{request.display_request_id || request.request_id}</strong>
                        <span>{request.patient_name || request.patient_id}</span>
                      </div>
                      <div className="requestMeta">
                        <span>{request.plan || 'No plan'}</span>
                        <span>{request.item_description || 'No item'}</span>
                        <strong>{formatMoney(request.requested_amount)}</strong>
                      </div>
                      <div className="requestStatusLine">
                        <span className={requestStatusClass(request)}>{requestStatusLabel(request)}</span>
                        <span className="timeChip">
                          <Clock3 size={13} />
                          {formatDuration(request.processing_seconds)}
                        </span>
                        <span>{formatDate(request.received_at)}</span>
                        <ChevronRight size={16} />
                      </div>
                    </button>
                  ))}

                  {!filteredRequests.length && (
                    <div className="emptyState">
                      <ClipboardList size={24} />
                      <strong>No pre-auth requests yet</strong>
                      <span>Incoming webhook requests will appear here after processing starts.</span>
                    </div>
                  )}
                </div>
              </div>

              <RequestDetail
                request={selectedRequest}
                events={requestEvents}
                eventsLoading={eventsLoading}
                eventsError={eventsError}
              />
            </section>
          </>
        )}

        {activeTab === 'eligibility' && (
          <EmptyModule
            icon={UserCheck}
            title="Eligibility Checks"
            channels={['Email', 'WhatsApp']}
            columns={['Source', 'Provider', 'Enrollee ID', 'Plan', 'Status', 'Received']}
            emptyTitle="No eligibility checks yet"
            emptyText="Provider eligibility requests will appear here."
          />
        )}

        {activeTab === 'support' && (
          <EmptyModule
            icon={MessageSquare}
            title="Support"
            channels={['Email', 'WhatsApp', 'Calls']}
            columns={['Channel', 'Requester', 'Intent', 'Assigned to', 'Status', 'Last activity']}
            emptyTitle="No support conversations yet"
            emptyText="Customer and provider support conversations will appear here."
          />
        )}
      </main>
    </div>
  );
}

function EmptyModule({ icon: Icon, title, channels, columns, emptyTitle, emptyText }) {
  return (
    <section className="emptyModule">
      <div className="moduleHeader">
        <div>
          <span className="smallLabel">Module</span>
          <h2>{title}</h2>
        </div>
        <div className="channelPills">
          {channels.map((channel) => (
            <span key={channel}>{channel}</span>
          ))}
        </div>
      </div>

      <div className="emptyModuleBody">
        <div className="emptyModuleIcon">
          <Icon size={26} />
        </div>
        <strong>{emptyTitle}</strong>
        <span>{emptyText}</span>
      </div>

      <div className="emptyTable">
        <div className="emptyTableHead">
          {columns.map((column) => (
            <span key={column}>{column}</span>
          ))}
        </div>
        <div className="emptyTableRow">
          <Inbox size={18} />
          <span>No records</span>
        </div>
      </div>
    </section>
  );
}

function RequestDetail({ request, events = [], eventsLoading = false, eventsError = '' }) {
  if (!request) {
    return (
      <aside className="detailPanel emptyDetail">
        <ShieldCheck size={28} />
        <strong>Select a request</strong>
        <span>Decision details and agent logs will appear here.</span>
      </aside>
    );
  }

  const agentLogs = request.agent_logs || [];

  return (
    <aside className="detailPanel">
      <div className="detailHeader">
        <div>
          <span className="smallLabel">Selected request</span>
          <h2>{request.display_request_id || request.request_id}</h2>
        </div>
        <span className={requestStatusClass(request)}>{requestStatusLabel(request)}</span>
      </div>

      <div className="decisionBlock">
        <div className="decisionTopline">
          <span>{isLiveAmanPayload(request) ? 'Intake captured' : request.decision || request.agent_step || 'Pending decision'}</span>
          {!isLiveAmanPayload(request) && request.confidence && <strong>{request.confidence} confidence</strong>}
        </div>
        <p>
          {isLiveAmanPayload(request)
            ? 'Live AMAN PA payload received. Decision automation is paused until the real payload mapping is fully validated.'
            : request.reason || 'The agent has not produced a final reason yet.'}
        </p>
      </div>

      <dl className="detailGrid">
        <div>
          <dt>Patient</dt>
          <dd>{request.patient_name ? `${request.patient_name} · ${request.patient_id}` : request.patient_id}</dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd>{request.plan || 'Not provided'}</dd>
        </div>
        <div>
          <dt>Requested item</dt>
          <dd>{request.item_description || 'Not provided'}</dd>
        </div>
        <div>
          <dt>Requested value</dt>
          <dd>{formatMoney(request.requested_amount ?? request.estimated_cost)}</dd>
        </div>
        <div>
          <dt>Line items</dt>
          <dd>{request.line_item_count || 'Not provided'}</dd>
        </div>
        <div>
          <dt>Event history</dt>
          <dd>
            {request.event_count ? `${request.event_count} event${request.event_count === 1 ? '' : 's'}` : 'Not captured'}
          </dd>
        </div>
        <div>
          <dt>Latest addition</dt>
          <dd>{request.latest_items_added_total ? formatMoney(request.latest_items_added_total) : 'None'}</dd>
        </div>
        <div>
          <dt>Facility</dt>
          <dd>{request.facility || 'Not provided'}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{providerLabel(request.requesting_provider) || 'Not provided'}</dd>
        </div>
        <div>
          <dt>Received</dt>
          <dd>{formatDate(request.received_at)}</dd>
        </div>
        <div>
          <dt>Time per PA</dt>
          <dd>{formatDuration(request.processing_seconds)}</dd>
        </div>
      </dl>

      <div className="sectionHeader">
        <div>
          <h3>PA Event Timeline</h3>
          <span>
            {eventsLoading
              ? 'Loading history'
              : `${events.length || request.event_count || 0} event${(events.length || request.event_count || 0) === 1 ? '' : 's'} captured`}
          </span>
        </div>
      </div>

      {eventsError && <div className="eventError">{eventsError}</div>}

      <div className="timeline eventTimeline">
        {events.map((event) => {
          const sequence = toNumber(event.event_sequence) || 0;
          const eventItems = itemsAddedFromEvent(event);
          return (
            <div className="timelineItem" key={event.event_id || event.id}>
              <div className="timelineBadge">{sequence || '?'}</div>
              <div className="timelineBody">
                <div className="timelineTitle">
                  <strong>{sequence <= 1 ? 'First captured event' : 'Additional items'}</strong>
                  <span className="status info">{formatMoney(eventValue(event))}</span>
                </div>
                <div className="eventMetaGrid">
                  <span>{eventItemCount(event)} line item{eventItemCount(event) === 1 ? '' : 's'}</span>
                  <span>Current PA snapshot: {formatMoney(event.total_requested_cost)}</span>
                  <span>{formatDate(event.submitted_at || event.occurred_at || event.created_at)}</span>
                </div>
                <div className="eventItems">
                  {eventItems.map((item) => (
                    <div className="eventItemRow" key={item.id}>
                      <span>{item.name}</span>
                      <small>Qty {item.quantity}</small>
                      <strong>{formatMoney(item.requested_cost)}</strong>
                    </div>
                  ))}
                  {!eventItems.length && <span className="mutedInline">No item details captured for this event.</span>}
                </div>
                <details className="jsonDetails">
                  <summary>
                    <FileJson size={15} />
                    Event JSON
                  </summary>
                  <pre>{safeJson(event.raw_payload || event.payload_summary || event)}</pre>
                </details>
              </div>
            </div>
          );
        })}

        {!events.length && !eventsLoading && !eventsError && (
          <div className="emptyState compact">
            <Clock3 size={22} />
            <strong>No event history yet</strong>
            <span>This request was captured before event tracking or the backend has not returned events.</span>
          </div>
        )}
      </div>

      <div className="sectionHeader">
        <div>
          <h3>Agent Timeline</h3>
          <span>{agentLogs.length} logs captured</span>
        </div>
      </div>

      <div className="timeline">
        {agentLogs.map((log) => {
          const outcome = agentOutcome(log);
          return (
            <div className="timelineItem" key={`${log.agent_num}-${log.logged_at}`}>
              <div className="timelineBadge">{log.agent_num}</div>
              <div className="timelineBody">
                <div className="timelineTitle">
                  <strong>{log.agent_name}</strong>
                  <span className={statusClass(outcome)}>{prettyStatus(outcome)}</span>
                </div>
                <p>{resultSummary(log.result)}</p>
                <span className="timestamp">{formatDate(log.logged_at)}</span>
                <details className="jsonDetails">
                  <summary>
                    <FileJson size={15} />
                    Result JSON
                  </summary>
                  <pre>{safeJson(log.result)}</pre>
                </details>
              </div>
            </div>
          );
        })}

        {!agentLogs.length && (
          <div className="emptyState compact">
            <Clock3 size={22} />
            <strong>No agent logs yet</strong>
            <span>The request may still be pending or processing.</span>
          </div>
        )}
      </div>

      <details className="payloadDetails">
        <summary>
          <FileJson size={16} />
          Extracted payload
        </summary>
        <pre>{safeJson(request.extracted_fields || request.raw_payload)}</pre>
      </details>
    </aside>
  );
}
