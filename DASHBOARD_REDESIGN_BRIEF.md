# SaaSPro Labs — Pre-Auth Operations Dashboard — Redesign Brief

## How to read this document

This is a **functional and data specification** for redesigning the dashboard UI from scratch. It describes *what the product does, what data it has, what the API exposes, and what users need to accomplish* — so the design can be driven by real requirements.

**It deliberately contains no visual direction.** No colors, typography, spacing, layout systems, component libraries, iconography, or stylistic tone. Those decisions are entirely yours. Where the "current UI" is described, it is reference material for understanding *behavior and information*, not a layout to copy.

Your job: design the best possible interface to satisfy the data, jobs-to-be-done, and capabilities below.

---

## 1. What this product is

SaaSPro Labs operates an **AI-driven pre-authorization (PA) system** for health insurers (HMOs). This dashboard is the **operations console** for that system.

**Domain in one paragraph:** When a hospital/clinic wants to treat an insured patient (a lab test, drugs, surgery, admission), it must get the insurer's approval *first* — a "pre-authorization." Traditionally a human reviews this (can take ~30 min). SaaSPro's system receives each PA request automatically, runs an AI pipeline that checks it against the plan's rules, and returns a decision (**approve / deny / escalate**) in seconds. This dashboard is where operators watch those requests flow in, see the decisions and the reasoning behind them, monitor the integration's health, and manage their team.

**The data lifecycle the dashboard reflects:**
```
HMO submits PA  ──▶  webhook receives + stores it  ──▶  AI agent decides (4 stages)  ──▶  decision saved
                                              │
                                              └────────▶  this dashboard reads + displays everything
```

**"Advisory mode":** decisions are currently *recommendations*, not hard gates on care. The UI should treat a decision as an authoritative recommendation with full reasoning, not as something that has physically blocked treatment.

---

## 2. Users, roles, and multi-tenancy

- **Organizations (tenants).** Every record belongs to an organization. Today there are two: an internal SaaSPro org and a client HMO org. The system is designed to onboard many client orgs.
- **Users (clients).** Each user belongs to one organization and has a **role**: `admin` or `member`.
- **Authentication.** Email + password login returns a **JWT bearer token** (7-day expiry). The token encodes: user id, email, `org_id`, and `role`. The frontend stores the session and sends `Authorization: Bearer <token>` on every request.
- **Tenancy rule (critical):** all data is scoped by `org_id`. **A user must only ever see their own organization's data.** A redesign should make per-organization scoping a first-class, obvious concept (e.g., the current org is always clear).
- **Role rule:** today, all data views are **admin-only** (members are blocked). A redesign should account for both roles — at minimum decide what a `member` sees (a read-only view is a reasonable target).
- **Onboarding model:** SaaSPro invites an organization's first admin; that admin invites their own members. Invites are token-based links; the invitee sets a password to register.

> ⚠️ **Known issue to design *out*:** the current backend has demo shortcuts that hardcode a specific user's email to a specific org, and let one specific email "see all orgs." The redesign should assume clean, role-and-org-driven access with no per-email special cases.

---

## 3. Core domain objects (the data the UI works with)

### 3.1 PA Request — the central object
This is what the dashboard is mostly about. Each request the API returns includes:

| Field | Meaning |
|---|---|
| `request_id` | Internal unique id for the request |
| `display_request_id` | Human-facing reference — the facility's check-in id (e.g. `AH/2026/05/25/0014042`) |
| `patient_id` | The enrollee's insurance number |
| `patient_name` | Enrollee name (may be empty) |
| `status` | `pending` · `processing` · `approve` · `deny` · `escalate` · `error` |
| `decision` | Final verdict: `APPROVE` · `DENY` · `ESCALATE` (may be null if not yet decided) |
| `agent_step` | Where it is in the pipeline: `eligibility` · `coverage` · `utilization` · `decision` · `completed` |
| `received_at` | When the request arrived |
| `processed_at` | When the decision finished (may be null) |
| `processing_seconds` | Latency from received → decided (derived; may be null) |
| `plan` | Insurance plan tier (Bronze · Silver · Gold · Platinum · Platinum Plus, or a custom variant) |
| `item_type` | Category of the requested item(s) |
| `item_description` | A single item name, or "N requested items" when multiple |
| `line_item_count` | Number of requested items |
| `estimated_cost` / `requested_amount` | Total requested value (currency: **NGN, Nigerian Naira**) |
| `amount_approved` | Approved value when applicable (may be null) |
| `facility` | Submitting hospital/clinic |
| `requesting_provider` | Who submitted (name/role/email) |
| `reason` | Plain-language rationale for the decision |
| `confidence` | `HIGH` · `MEDIUM` · `LOW` |
| `error_message` | Present if processing errored |
| `raw_payload` | The full original nested JSON from the HMO (see 3.2) |
| `extracted_fields` | A normalized/flattened version of the request |
| `agent_result` | The final decision object (see 3.3) |
| `agent_logs` | Per-stage pipeline log (see 3.4) |

### 3.2 `raw_payload` (the HMO's original submission) — notable nested parts
- `encounter` — `checkin_id`, `checkin_type` (inpatient/outpatient), `facility_name`, `diagnosis` (ICD-10 codes)
- `pa_items[]` — the line items to decide (`item_name`, `quantity`, `unit_cost`, `requested_cost`, `category_id`, `status`)
- `enrollee` — `insurance_no`, `first_name`, `surname`, `date_of_birth`, `relationship`
- `policy` — `plan_name`, `corporation_name` (the employer group), `enforcement_mode`
- `consumption` — intended to carry year-to-date usage vs. caps (often empty today)
- `event_type` — e.g. `pa.submitted`

> A live HMO submission is identified by `event_type === "pa.submitted"`. Today the UI shows these as **"Received"** with a note that automated decisioning is paused for live payloads pending mapping validation. The redesign should be able to represent "arrived but not yet auto-decided" as a distinct state.

### 3.3 `agent_result` (the decision the AI produced)
Holds the verdict and the reasoning trail. Keys include: `decision`, `confidence`, `reasoning`, `denial_reason`, `escalation_reason`, `amount_approved`, `flags` (short labels, e.g. "Failed eligibility check"), `no_preauth_required` (true only for the auto-approve express tier), `agent_summary` (pass/fail per stage), and `agent1`/`agent2`/`agent3`/`agent4` (each stage's full output, or null if that stage never ran).

### 3.4 The AI pipeline & `agent_logs` (decision transparency)
The decision is produced by **four sequential agents**, each with one job. Any stage can stop the line (a failure short-circuits the rest, leaving later stages null):

| # | Agent | Question it answers |
|---|---|---|
| 1 | Eligibility | Is the member valid? (active, not expired, age within limit) |
| 2 | Plan & Coverage | Is the item covered, excluded, or in a waiting period? |
| 3 | Utilization & Limits | Does the cost fit under the benefit + annual cap? |
| 4 | Final Decision | Aggregate 1–3 → APPROVE / DENY / ESCALATE |

`agent_logs` is an ordered list, one entry per stage that ran, each with: `agent_num`, `agent_name`, `status` (`pass`/`fail`), `result` (the stage's JSON output), `logged_at`. **This is the audit/explainability trail** — the "why" behind every decision. Surfacing it clearly is a core value of the product.

### 3.5 Webhook delivery log (integration health)
Every inbound delivery attempt is recorded — *including rejected ones* — for observability. Per attempt: `delivery_id`, `provider`, `org_id`, `api_key_hint` (masked), `request_ip`, `event_id`, `correlation_id`, `checkin_id`, `facility_name`, `insurance_no`, `policy_no`, `plan_name`, `auth_status`, `payload_valid`/`payload_status`, `payload_size_bytes`, `db_insert_status`, `http_status_returned`, `final_status`, `error_message`, `processing_time_ms`, `created_at`. This answers "is the HMO actually reaching us, authenticating, and sending valid data?"

### 3.6 Team & access objects
- **Organization** — id, name, active flag.
- **User/Client** — name, email, role, active flag.
- **Invite** — pending team invitations (email, role, used flag).
- **API key** — one active key per user/org, used by the HMO to authenticate its webhook deliveries. Shown masked; generated/revoked on demand.

---

## 4. The API the UI consumes (data contract)

All endpoints are under `/auth` and (except login/register) require the bearer token. Base URL is configurable (`VITE_API_BASE_URL`, defaults to `http://localhost:8000`).

| Method & path | Purpose | Role | Returns (shape) |
|---|---|---|---|
| `POST /auth/login` | Sign in | any | `{ token, role, name, org_name }` |
| `POST /auth/register` | Register via invite token | any | confirmation |
| `GET /auth/me` | Current user info | any | user + org |
| `GET /auth/preauth-dashboard?date_from&date_to` | **Main feed**: summary + recent requests (org-scoped) | admin | `{ summary{…}, requests[…] }` |
| `GET /auth/preauth-payloads` | Recent raw incoming payloads | admin | `{ payloads[…] }` |
| `GET /auth/webhook-delivery-logs?date_from&date_to&failed_only&limit` | Delivery health summary + log rows | admin | `{ summary{…}, logs[…] }` |
| `GET /auth/webhook-audit-trail?event_id&checkin_id&request_id&include_payload` | End-to-end trace: delivery → stored request → agent result | admin | `{ traces[…] }` |
| `GET /auth/team` | Team members + pending invites | admin | `{ members[…] }` |
| `POST /auth/invite-member` | Invite a teammate by email | admin | confirmation |
| `DELETE /auth/team-member/{email}` | Remove member or pending invite | admin | confirmation |
| `GET /auth/api-key` | Whether the user has an API key | any (auth) | `{ has_api_key, masked_api_key, created_at }` |
| `POST /auth/api-key/generate` | Generate/replace API key (shown once) | any (auth) | `{ api_key, … }` |
| `DELETE /auth/api-key` | Revoke API key | any (auth) | confirmation |

**`preauth-dashboard` summary fields** (ready-to-display KPIs): `total`, `pending`, `processing`, `approved`, `denied`, `escalated`, `errors`, `received_24h`, `total_amount_approved`, `avg_processing_seconds`.

**`webhook-delivery-logs` summary fields:** `total_received`, `duplicate_event_attempts`, `repeated_checkin_attempts`, `auth_success`, `auth_failed`, `payload_valid`, `payload_invalid`, `db_saved`, `db_failed`, `http_success`, `http_failed`, `avg_processing_time_ms`, `latest_received_at`.

**Behavioral notes for the UI:**
- Date range (`date_from`/`date_to`) is filtered **server-side**. Search and status filtering are done **client-side** on the returned set.
- The main feed returns up to ~100 most-recent requests.
- A `401 "token expired"` means the session ended — the UI should sign the user out and prompt re-login.

---

## 5. Jobs to be done (functional requirements)

These are the tasks the dashboard must enable. *How* they look is open; *that* they're supported is required.

1. **Monitor the operation at a glance** — see volume and outcomes: total requests, received today / last 24h, approved / denied / escalated / pending / error counts, total & average PA value (NGN), average decision latency.
2. **Browse the request queue** — scan many requests with their key facts (reference id, patient, plan, item, amount, status, latency, time received).
3. **Find a specific request** — free-text search (reference, patient, provider, plan, item, facility) and filter by status and by date range.
4. **Understand a single request deeply** — open one request and see: the request details (patient, plan, items, amount, facility, provider, timing), the decision (verdict, confidence, plain-language reason), the **full agent reasoning timeline** (each of the 4 stages, pass/fail, its rationale, and its raw JSON), and the underlying raw/extracted payload.
5. **Monitor integration health** — is the HMO reaching us? Are deliveries authenticating, valid, and being stored? Surface auth failures, invalid payloads, duplicates, DB failures, HTTP error rates, and latency. *(Backend endpoints exist; not yet surfaced in the current UI.)*
6. **Trace one event end-to-end** — given an event/check-in/request id, follow it from delivery attempt → stored request → agent decision. *(Endpoint exists; not yet surfaced.)*
7. **Manage the team** — list members and pending invites, invite a new member, remove someone. *(Endpoints exist; not yet surfaced in UI.)*
8. **Manage integration credentials** — view (masked), generate, and revoke the API key the HMO uses. *(Endpoints exist; not yet surfaced in UI.)*
9. **Stay current** — near-real-time updates (the data refreshes on an interval today) without disrupting what the operator is reading.
10. **Handle all states gracefully** — loading, empty (no requests yet), error (failed load), and expired-session.

---

## 6. Current UI (reference only — not a layout to keep)

Described so you understand existing behavior and information density. Redesign freely.

- **Login screen.** Email + password; shows the configured backend URL.
- **Persistent shell** with a navigation area listing modules, and a footer showing the signed-in user (name, role) plus refresh and sign-out.
- **Three modules exist in navigation:**
  - **Pre-Auth Intake** — *the only fully built module.* Contains: a row of summary metrics; a toolbar (search, status dropdown, from/to date pickers, clear-dates, auto-refresh toggle); and a two-part work area — a list of requests on one side and a detail panel for the selected request on the other.
    - *Request list item* shows: reference id, patient, plan, item description, requested amount, status, processing time, received time.
    - *Detail panel* shows: a decision block (verdict + confidence + reason); a details grid (patient, plan, requested item, requested value, line items, facility, provider, received, time per PA); an **agent timeline** (per stage: number, name, pass/fail, summary, timestamp, and an expandable raw result JSON); and an expandable extracted/raw payload JSON.
  - **Eligibility Checks** — *placeholder only.* Intended as a future module for provider eligibility requests arriving via channels (noted: Email, WhatsApp). Currently an empty state with column headers (Source, Provider, Enrollee ID, Plan, Status, Received).
  - **Support** — *placeholder only.* Intended as a future module for support conversations across channels (noted: Email, WhatsApp, Calls). Currently an empty state with column headers (Channel, Requester, Intent, Assigned to, Status, Last activity).
- **Auto-refresh** of the main feed runs on a ~15-second interval and can be toggled.

---

## 7. What we want it to become (forward-looking goals)

Beyond rebuilding what exists, these are desired capabilities. Treat them as in-scope for the information architecture even if some backends are partial.

1. **True multi-tenant operation.** Each client organization sees only its own data, cleanly, with the active organization always clear. Remove all per-email/demo special-casing. This is the headline goal — the dashboard is meant to be shared with multiple client HMOs, each seeing only their slice, with easy onboarding of new ones.
2. **Integration Health as a first-class view.** Surface the rich delivery-log and audit-trail data (Section 3.5 / endpoints in Section 4) — the ability to answer "is the pipe healthy?" and "what happened to this exact event?" is currently invisible in the UI despite existing in the API.
3. **End-to-end audit trail view.** One place to trace a single event across delivery → stored request → agent decision.
4. **Team management UI.** Invite, list, and remove members + see pending invites.
5. **API key / integration setup UI.** For onboarding a client's webhook integration (generate/show-once/revoke).
6. **Role-aware experience.** A defined experience for `member` (not just `admin`) — e.g., read-only operational visibility.
7. **Decision transparency front-and-center.** The 4-agent reasoning is the product's differentiator over a black-box approval — make the "why" easy to read and trust.
8. **Realized Eligibility & Support modules.** Currently placeholders; intended to become real operational queues (multi-channel intake). Design them as genuine modules even if data wiring comes later.

---

## 8. Constraints & domain facts to design around

- **Currency is NGN** (Nigerian Naira); amounts can be large (millions).
- **Statuses are a small fixed set:** pending, processing, approve, deny, escalate, error — plus a distinct "received / awaiting auto-decision" state for live HMO payloads.
- **Decisions carry confidence** (HIGH/MEDIUM/LOW) and, when denied/escalated, a specific reason — both should be legible.
- **Some requests have no decision yet** (pending/processing) and some fail on missing/empty data — the UI must represent incomplete and error states as normal, not exceptional.
- **The agent timeline length varies** (1 to 4 stages) because the pipeline short-circuits on failure — the detail view must handle anywhere from one stage to four.
- **Plan tiers** range Bronze → Silver → Gold → Platinum → Platinum Plus, plus per-employer custom variants.
- **Near-real-time:** new requests arrive continuously; the view should update without losing the operator's place/selection.

---

## 9. Explicitly out of scope for this brief

Intentionally **not** specified, so as not to bias the design:
- Color, palette, theming, light/dark.
- Typography, type scale.
- Spacing, grid, layout framework.
- Component library or design system choice.
- Iconography.
- Visual tone, mood, or brand expression.

These are yours to decide. This document defines **what must be shown and what users must be able to do** — not how it should look.
