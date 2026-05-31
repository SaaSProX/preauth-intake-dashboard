# SaaSPro Pre-Auth Operations Console

The operations dashboard for SaaSPro's AI pre-authorization service. Operators (HMO admins + their teams, SaaSPro super-admins) sign in here to triage incoming pre-auth requests, audit agent decisions, manage their team + API keys, and — for super-admins — onboard new HMO clients.

Connects to the backend at [`SaaSProX/preauth`](https://github.com/SaaSProX/preauth).

```
[HMO webhook] → [SaaSProX/preauth backend] → [Postgres]
                                                  ↑
                                       [this dashboard reads]
```

---

## Stack

- **React 18** + **Vite** (no TypeScript)
- Vanilla CSS — design tokens in `src/App.css`
- JetBrains Mono + Inter fonts
- Single `src/App.jsx` for the whole app (deliberate — easier to grep, easier to ship)

No external state library, no router. Drill-in state lives in `?org=` in the URL via `history.pushState`.

---

## What's in the dashboard

### Queue (Pre-Auth Intake)
- Paginated table of PAs (25/page), sorted newest first.
- Toolbar: server-side **search** across patient/request/decision/payload, **date range**, **plan filter**, **status chips**.
- Each row shows reference, patient (+ "N× PAs" pill when the patient has more than one PA), plan tag, item summary, requested amount, decision pill, latency, time ago.
- The displayed date window in the page header reflects the real DB span or the active filter.

### Detail drawer (click a row)
Five sections:

1. **Request details** — enrollee, plan, diagnosis, requested item, facility, provider, timestamps.
2. **Requested items** — each line item with a covered/denied pill (the AI's Agent 2 verdict) and an expandable detail panel showing unit cost, approved cost, item status, pricing source, IDs, flags, plus raw item JSON.
3. **Other requests from this patient** — full PA history for that enrollee fetched on demand, across pages. Click a sibling to swap the drawer.
4. **PA event timeline** — the chronological list of intake-webhook deliveries for this check-in (first capture + later additions, with items + value per delivery, raw event JSON).
5. **Agent reasoning timeline** — all 4 agents (Eligibility, Coverage, Limits, Final Decision), each with its reason text, structured highlights (eligibility checks as pills, coverage counts, utilization bars, final decision summary), and raw stage JSON behind a fold.

Every JSON dump has a **Copy** button that writes to the clipboard and pops a toast.

### Other pages
- **Integration Health** — every inbound webhook delivery (failed and successful), so an operator can spot when something never made it to a PA.
- **Audit Trail** — type a `request_id` / `checkin_id` / `event_id` and replay it across the full pipeline.
- **Team** — invite admins/members, remove members. Admin-only.
- **API Keys** — generate named keys (e.g. "Aman prod webhook"), list with masked key + last-used timestamp, revoke individually. Admin-only.
- **Onboarding** — super-admin only. Create new client orgs, invite their first admin, rename or deactivate existing orgs. The org list is also the entry point to **drill into another org's view** (read-only).

### Roles + drill-in
- **Admins** see write actions (invite, revoke, etc.).
- **Members** see the same data, read-only. Write buttons are hidden via a global `body.role-member` CSS class.
- **Super-admins** (admins of the platform org named `SAASPRO`) get the Onboarding nav item plus the ability to drill into any client org. When drilled in, the URL becomes `?org=<id>` and write actions hide (CSS class `body.drill-in-view`) — drill-in is view-only by design, with a banner explaining why.

---

## Multi-tenancy + auth flow

```
Login (email + password)
   ↓  JWT in localStorage (HS256, 7-day expiry)
   ↓  every fetch sends Authorization: Bearer <token>
Backend reads org_id from the JWT
   ↓
WHERE org_id = $1   (every query)
```

There is no concept of "see all orgs" except the explicit super-admin `?org_id=` drill-in, and that's gated server-side. If you're a regular HMO admin, you literally cannot see another HMO's data through this app.

---

## Local development

### Prerequisites
- Node 18+
- The backend running locally at `http://localhost:8000` ([setup guide](https://github.com/SaaSProX/preauth))

### Setup

```bash
git clone https://github.com/SaaSProX/preauth-intake-dashboard.git
cd preauth-intake-dashboard
npm install
```

### Configure

Create `.env`:

```env
VITE_API_BASE_URL=http://localhost:8000
```

(omit the var entirely and it defaults to `http://localhost:8000`)

### Run

```bash
npm run dev
# http://localhost:5173
```

### Test accounts (against the local seeded test DB)

The backend's `migrate.sql` plus the seeded test DB give you these accounts (password `test1234` unless changed):

| Email | Role | Org |
|---|---|---|
| `admin2@test.local` | admin (super-admin) | SAASPRO |
| `admin@test.local` | admin | AMAN |
| `member@test.local` | member | AMAN |

---

## Project structure

```
src/
├── App.jsx     # everything — components, helpers, screens, state
├── App.css     # design tokens + every rule
├── main.jsx    # React root mount
└── index.css   # minimal global resets
public/
├── saaspro-mark.png    # logo used in login + sidebar brand
└── …
```

`App.jsx` is intentionally one file — easier to grep, easier to ship; we'll split when it stops being easier.

---

## Conventions

- **Inline styles** are used for one-offs; design tokens (`var(--ink)`, `var(--indigo)`, etc.) come from `App.css`.
- **`data-admin-only`** on a write-action element hides it for members AND for super-admins drilled into another org. Use it for any new write button.
- **`useToast()`** is available everywhere — `const { show } = useToast(); show('Saved!'); show('Error', 'bad');`. Use it for confirmations instead of bespoke banners.
- **Drill-in state** is read from `?org=` on mount and on `popstate`; never read directly from `viewOrgId` outside the App-level handlers.

---

## Deployment

Static SPA. Build:

```bash
npm run build
# → dist/
```

Serve `dist/` from anywhere (Cloudflare Pages, Vercel, S3 + CloudFront, plain nginx). The only runtime config is `VITE_API_BASE_URL` (baked in at build time — pass it as a build-time env var).

Make sure the backend's `CORS_ORIGINS` allows the dashboard's deployed origin.

---

## License

Proprietary — Saaspro Labs
