# Palm Sporting Club CRM — Project Context

## Owner
Andrea Mora Millan (andrea.mora.millan@gmail.com)
Business: **Palm Sporting Club** — Lagree fitness studio + restaurant (Palm Kitchen) in Marbella, Spain

## Repository
GitHub: `andrea545/palm-crm`
Deployed on: **Railway** (auto-deploys from GitHub pushes)

## Tech Stack
- **Backend**: Node.js / Express (`index.js`, ~2800 lines)
- **Frontend**: Vanilla JS single-page app (`index.html`, ~3700 lines) + `login.html`
- **APIs**: MindBody Public API v6, SendGrid (email), Square (restaurant POS)
- **No database** — all data comes from MindBody/Square APIs in real-time

## Architecture Overview
Single `index.js` serves the Express API and static files. No build step, no bundler. Deploy by pushing to GitHub — Railway auto-deploys.

### Key Files
| File | Purpose |
|------|---------|
| `index.js` | Full backend — auth, MindBody proxy, analytics, email automation, webhooks, Square/Kitchen integration |
| `index.html` | Full frontend SPA — dashboard, analytics, email management, client views, restaurant tab |
| `login.html` | Login page |

## Environment Variables (Railway)
- `MB_API_KEY` — MindBody API key
- `MB_SITE_ID` — MindBody site ID
- `MB_SOURCE_NAME` / `MB_SOURCE_PWD` — MindBody source credentials
- `MB_USERNAME` / `MB_PASSWORD` — MindBody user credentials (for token auth)
- `MB_WEBHOOK_SECRET` — Webhook signature verification
- `SENDGRID_API_KEY` — SendGrid for transactional emails
- `FROM_EMAIL` / `FROM_NAME` — Sender identity (hello@palmsportingclub.com / Palm Sporting Club)
- `SQUARE_ACCESS_TOKEN` / `SQUARE_LOCATION_ID` — Square POS for Palm Kitchen
- `PORT` — Server port (default 3000)

## MindBody API — Critical Knowledge

### Endpoints Used
| Endpoint | Purpose | Notes |
|----------|---------|-------|
| `client/clients` | Client profiles | `Active` flag is UNRELIABLE — MindBody marks ALL 3500+ clients as Active |
| `client/clientservices?clientId=X` | Credit-based services (class packs, intro packs) | **Requires `clientId`** — cannot bulk-fetch |
| `client/activeclientmemberships?clientId=X` | Recurring memberships | **Requires `clientId`** — cannot bulk-fetch. This is the ONLY reliable way to check if someone has an active membership |
| `sale/contracts?Limit=200` | Site-wide contracts/memberships | Does NOT require clientId. Used for aggregate membership stats in analytics |
| `sale/sales` | Transaction data | Used for revenue calculations |
| `class/classes` | Class schedule & attendance | Filter with `IsCanceled` to exclude old classes |

### Important Gotchas
1. **`Active` flag is useless**: MindBody sets `Active=true` on virtually all clients regardless of activity. We define "active" as having a purchase or booking in the last 90 days.
2. **`clientservices` vs `activeclientmemberships`**: These are SEPARATE endpoints. `clientservices` = credit packs (finite count). `activeclientmemberships` = recurring memberships (ongoing). Both require a `clientId` parameter.
3. **`sale/contracts`**: Site-wide endpoint that doesn't require clientId. Returns `Contracts` array. Used for analytics overview membership stats.
4. **Cancelled classes**: Old cancelled classes show up in `class/classes` results. Always filter with `IsCanceled` and exclude zero-booking classes.
5. **Pagination**: MindBody limits responses. For large datasets (3500+ clients), pagination is needed and can be slow (45s+ timeout needed).

## Email Automation System

### How It Works
The automation runs on a timer and processes clients based on MindBody webhook events and periodic checks.

### Last Credit Email Logic (CRITICAL)
When a client's class pack reaches 0 remaining credits, we check:
1. Are ALL their credit-based services (`clientservices`) at 0 remaining?
2. Does `activeclientmemberships` return EMPTY (no active recurring membership)?
3. Only if BOTH conditions are true → send "last credit" email

**Why**: Clients with recurring memberships were incorrectly receiving "last credit" emails when their bonus credit packs ran out, even though their membership still gives them access.

### Debug Endpoint
`GET /api/debug-client-services?clientId=XXXX` — Shows both `clientservices` and `activeclientmemberships` data with categorization summary. Use this to verify the logic for any specific client.

## Analytics System

### Studio Analytics (`/api/analytics/overview`)
Returns: revenue, class stats, fill rates, client health, attendance, heatmap, instructor stats, membership stats.

**Client Health Logic**:
- "Active" = purchase or booking in last 90 days (NOT MindBody's Active flag)
- "At-risk" = active in last 6 months but no visit in 14+ days
- "Retention" = % of previous-period clients still active this period
- `getLastActivity()` returns `null` (not `CreationDate`) for clients with no visit data

### Advanced Analytics (5 separate endpoints)
- `/api/analytics/retention` — Retention curves
- `/api/analytics/clv` — Client lifetime value
- `/api/analytics/cohorts` — Monthly cohort analysis
- `/api/analytics/churn-risk` — Churn prediction
- `/api/analytics/first-visit-conversion` — First visit → member conversion

These are slow (paginate all clients) — frontend has 45s timeout with progress indicator.

### Kitchen/Restaurant Analytics (`/api/kitchen/overview`)
Uses Square API for Palm Kitchen POS data.

## Frontend Field Name Mapping
The backend and frontend must use matching field names. Here are the correct mappings (these were previously mismatched and fixed):

| Backend returns | Frontend accesses |
|----------------|-------------------|
| `revenueGrowth` | `d.revenueGrowth` |
| `totalClasses` | `d.totalClasses` |
| `fillRateGrowth` | `d.fillRateGrowth` |
| `membershipGrowth` | `d.membershipGrowth` |
| `newClients` | `d.newClients` |
| `visitsGrowth` | `d.visitsGrowth` |
| `classesByName` | `d.classesByName` |
| `instructorStats` | `d.instructorStats` |
| `revenueBySvc` | `d.revenueBySvc` |
| `hourlyHeatmap` | `d.hourlyHeatmap` |
| `atRiskClients` | `d.atRiskClients` (array) |

### Heatmap
Backend sends day names as short format ("Sun", "Mon", etc.). Frontend handles both short and long formats.

## Common Issues & Solutions

### "Loading..." stuck on advanced analytics
Cause: 45s timeout may not be enough if MindBody is slow. Check Railway logs for pagination progress.

### Blank analytics sections
Cause: Field name mismatch between backend response and frontend rendering. Compare the field name mapping table above.

### Wrong client counts (e.g., 3500 "active")
Cause: Using MindBody's `Active` flag instead of activity-based definition. "Active" must be based on last 90 days of bookings/purchases.

### Deploy crash with "MissingRequiredFields"
Cause: Calling `client/clientservices` or `client/activeclientmemberships` without `clientId` parameter. These endpoints REQUIRE a client ID. For bulk stats, use `sale/contracts` instead.

### Email sent to members about "last credit"
Cause: Not checking `activeclientmemberships` endpoint. The fix checks both credit services AND memberships before sending.

## Users / Auth
- `andrea` (owner role) — Password: Hello999
- `staff1` (staff role) — Password: Hello999
- Sessions stored in-memory (Map), 8-hour expiry
- Auth via `x-session-token` header

## Deployment
```bash
# Push to GitHub triggers Railway auto-deploy
git add index.js index.html
git commit -m "description of changes"
git push origin main
```

## API Endpoints Quick Reference

### Auth
- `POST /auth/login` — Login
- `POST /auth/logout` — Logout
- `GET /auth/me` — Current session

### Email
- `GET /api/email/log` — Email send history
- `POST /api/email/send` — Send email
- `GET /api/email-queue` — Pending automated emails
- `POST /api/email-queue/send` — Process email queue

### Analytics
- `GET /api/analytics/overview` — Main studio analytics
- `GET /api/analytics/retention` — Retention curves
- `GET /api/analytics/clv` — Client lifetime value
- `GET /api/analytics/cohorts` — Cohort analysis
- `GET /api/analytics/churn-risk` — Churn prediction
- `GET /api/analytics/first-visit-conversion` — Conversion tracking
- `GET /api/analytics/no-shows` — Class utilization & no-shows

### Kitchen
- `GET /api/kitchen/overview` — Restaurant analytics (Square)
- `GET /api/kitchen/health` — Square API health check

### Debug
- `GET /api/debug-client-services?clientId=X` — Debug client services + memberships
- `GET /api/mb-debug` — MindBody connection debug
- `GET /api/health` — Server health check

### Webhooks
- `POST /webhooks/mindbody` — MindBody webhook receiver
- `GET /api/webhooks/subscriptions` — List webhook subscriptions
- `POST /api/webhooks/setup` — Configure webhooks
