# 🏸 Mera Sports Backend — Full Codebase Analysis

> **Prepared by:** Backend Developer (6 YOE)  
> **Date:** February 25, 2026  
> **Stack:** Node.js · Express.js v5 · Supabase (PostgreSQL) · JWT · Nodemailer · 2Factor.in (SMS OTP)

---

## 📁 Project Structure Overview

```
mera-sports-backend/
├── server.js                   # Express app entry point
├── .env                        # Environment variables
├── package.json                # Dependencies & scripts
├── config/
│   └── supabaseClient.js       # Supabase admin client (service-role key)
├── middleware/
│   ├── authMiddleware.js       # Generic JWT auth (any valid token)
│   ├── rbacMiddleware.js       # Role-based: verifyAdmin / verifyPlayer
│   └── bracketValidation.js   # Bracket integrity + mode-lock validation
├── routes/                     # 17 route files (includes instituteRoutes.js)
├── controllers/                # 20+ controller files (includes instituteController.js)
│   └── bracket/               # 8 sub-controllers for bracket management
├── services/
│   ├── notificationService.js  # In-app notification creation helper
│   └── otpService.js           # SMS + Email OTP via 2Factor.in & Supabase
├── utils/
│   ├── mailer.js               # Nodemailer (Gmail SMTP) email sender
│   └── uploadHelper.js         # Base64 → Supabase Storage helper
└── data/
    └── *.xlsx                  # Pre-listed apartments data (Excel)
```

---

## ⚙️ Server Entrypoint — `server.js`

- Uses **Express 5.x** (latest, with async error handling improvements).
- Applies **CORS** globally with default settings (⚠️ no origin whitelist — any client can call).
- Body parser limit: **15MB** (required for base64 image uploads).
- All routes are prefixed under `/api/`:

| Mount Prefix             | Route File                  | Purpose                          |
|--------------------------|-----------------------------|----------------------------------|
| `/api/player`            | playerDashboardroutes.js    | Player dashboard & profile       |
| `/api/contact`           | contactRoutes.js            | Contact messages                 |
| `/api/auth`              | authRoutes.js               | Auth (OTP, register, login)      |
| `/api/auth`              | googleSyncRoutes.js         | Google OAuth sync                |
| `/api/events`            | eventRoutes.js              | Event CRUD                       |
| `/api/payment`           | paymentRoutes.js            | Manual payment submission        |
| `/api/admin/matches`     | matchRoutes.js              | Scoreboard match management      |
| `/api/admin`             | bracketRoutes.js            | Bracket management (priority)    |
| `/api/admin`             | adminRoutes.js              | Admin management & dashboard     |
| `/api/admin`             | leagueRoutes.js             | League (round-robin) config      |
| `/api/advertisements`    | advertisementRoutes.js      | Ad management                    |
| `/api/apartments`        | apartmentRoutes.js          | Apartment list management        |
| `/api/institute`         | instituteRoutes.js          | Bulk import & institute endpoints|
| `/api/teams`             | teamRoutes.js               | Team CRUD for doubles            |
| `/api/notifications`     | notificationRoutes.js       | In-app notifications             |
| `/api/public`            | publicRoutes.js             | Public settings (no auth)        |
| `/api/seed`              | tempSeedRoutes.js           | Dev seed route (⚠️ DEV ONLY)     |

---

## 🔐 Authentication & Authorization

### JWT Strategy
- **Single JWT secret**: `process.env.JWT_SECRET` used for ALL tokens.
- **Three roles**: `player` (7-day token), `institutehead` (30-day token), and `admin`/`superadmin` (30-day token).
- Token payload: `{ id, role }`.

### Middleware Guards

| Middleware         | File                      | Checks                                           |
|--------------------|---------------------------|--------------------------------------------------|
| `authenticateUser` | `authMiddleware.js`       | Valid Bearer JWT (any role)                      |
| `verifyAdmin`      | `rbacMiddleware.js`       | Valid JWT + role must be `admin` or `superadmin` |
| `verifyPlayer`     | `rbacMiddleware.js`       | Valid JWT + role must be `player`                |
| `verifyInstitute`  | `rbacMiddleware.js`       | Valid JWT + role must be `institutehead`         |

### Admin Verification Workflow (Two-stage)
1. Admin registers → `verification: 'pending'`.
2. SuperAdmin approves → `verification: 'verified'`.
3. Rejected admins get `verification: 'rejected'` status and can reapply.
4. Google OAuth admins go through same verification flow.

### Institute Verification Workflow (Two-stage)
1. Institute registers → `verification: 'pending'`.
2. SuperAdmin approves → `verification: 'verified'` (via `PUT /api/admin/institutes/:id/approve`).
3. Only verified institutes can fully login and use the dashboard.
4. Google OAuth admins go through same verification flow.

---

## 🗄️ Supabase Configuration — `config/supabaseClient.js`

- Uses **Service Role Key** → bypasses Postgres Row Level Security (RLS).
- Exports single `supabaseAdmin` client used throughout all controllers.
- Auto-detects if wrong key (anon vs service) is configured at startup.
- `autoRefreshToken: false`, `persistSession: false` (pure server-side usage).

---

## 📬 External Services

### Email — `utils/mailer.js`
- **Provider:** Gmail SMTP via Nodemailer.
- **Functions:**
  - `sendRegistrationEmail()` — Confirms event registration with details.
  - `sendRegistrationSuccessEmail()` — Welcome email with `playerId` and password.
- Password = player's DOB in `DDMMYYYY` format (noted in email too — ⚠️ security concern).

### OTP — `services/otpService.js`
- **SMS OTP:** Uses `2Factor.in` API to send a 6-digit OTP via GET request.
- **Email OTP:** Uses Supabase `signInWithOtp()` (magic-link flow adapted for OTPs).
- **Verification OTP:** On success, generates a short-lived JWT (5 min) of type `verification` that must be passed in `x-verification-token` header for sensitive operations like profile/password update.

### Notifications — `services/notificationService.js`
- `createNotification(userId, title, message, type, link)` → inserts into `notifications` table.
- Types: `info`, `success`, `warning`, `error`.
- Used internally by: `authController`, `adminEventController`, `broadcastController`.

### File Upload — `utils/uploadHelper.js`
- `uploadBase64(base64Data, bucket, folder)` → parses data URI, extracts mime type, uploads binary to Supabase Storage.
- Supported formats: JPEG, PNG, WebP, PDF.
- Returns public URL or `null` on failure.
- If `base64Data` is already a URL (not base64), it returns it unchanged.

---

## 📦 Database Tables (Inferred from Queries)

| Table                    | Purpose                                            |
|--------------------------|----------------------------------------------------|
| `users`                  | All users (players, admins, superadmins)           |
| `events`                 | Sports events with categories (JSONB)              |
| `event_registrations`    | Player/team registrations per event                |
| `event_brackets`         | Bracket draw data (MEDIA or BRACKET mode)          |
| `event_news`             | News/announcements per event                       |
| `matches`                | Individual match rows for scoreboard               |
| `leagues`                | League (round-robin) configuration table           |
| `transactions`           | Payment transaction records                        |
| `notifications`          | In-app notifications per user                      |
| `player_school_details`  | School details for player profiles                 |
| `player_teams`           | Teams for doubles/team sports                      |
| `family_members`         | Player's family members                            |
| `apartments`             | Pre-listed apartment names for registration        |
| `advertisements`         | Banner/ad management                               |
| `contact_messages`       | Contact form submissions                           |
| `platform_settings`      | Single-row platform settings (id = 1)              |
| `broadcast_logs`         | Log of admin broadcasts                            |
| `institute_approvals`    | Manages bulk student import approvals by Institute |

> **Note:** `event_brackets.category_id` is **UUID** type, while `leagues.category_id` is **TEXT** — this causes category matching complexity in matchController.

---

## 🧩 Controller Deep-Dive

---

### 1. `authController.js` — Authentication

#### Player Registration (`POST /api/auth/register-player`)
1. Required fields: `firstName, lastName, mobile, email, dob`.
2. Calculates age from DOB.
3. **Password = `DDMMYYYY` format of DOB** (plaintext in DB ⚠️).
4. Duplicate check: by `mobile OR aadhaar OR email`.
5. Uploads profile photo via `uploadBase64`.
6. Calls Supabase RPC `get_next_player_id()` for sequential Player ID.
7. Inserts into `users` table.
8. Inserts `schoolDetails` and `familyMembers` separately.
9. Generates JWT (7d), sends welcome email.

#### Player Login (`POST /api/auth/login`)
- Supports login by: `player_id (P...)`, `mobile`, or `aadhaar`.
- **Plain text password comparison** (⚠️ no hashing).
- Role check: only `player` role can login here.

#### Admin Registration (`POST /api/auth/register-admin`)
- Stores admin with `verification: 'pending'`.
- Password stored in plaintext ⚠️.

#### Admin Login (`POST /api/auth/login-admin`)
- Validates role = `admin` or `superadmin`.
- Checks `verification === 'verified'` (blocks pending/rejected admins).
- Token: 30-day expiry.
- Creates welcome-back notification.

#### Institute Registration (`POST /api/auth/register-institute`)
- Inserts new user with `role: 'institutehead'`, `verification: 'pending'`.
- Handles proper 503 Supabase outage error catching.

#### Institute Login (`POST /api/auth/login-institute`)
- Validates role = `institutehead`.
- Emits `status: 'pending' | 'verified' | 'rejected'` back to frontend.
- Pending triggers 200 OK so frontend can display "waiting for approval" UI.

#### OTP Flows
- `send-verification-otp` + `verify-verification-otp`: 2-step for sensitive profile edits.
- `send-otp` + `verify-otp`: Email OTP for registration.
- `send-mobile-otp` + `verify-mobile-otp`: SMS OTP via 2Factor.in.
- `check-conflict`: Checks if mobile/email/aadhaar already exists.

---

### 2. `googleSyncRoutes.js` — Google OAuth Sync (`/api/auth/sync`)

1. Receives Supabase session token from frontend OAuth callback.
2. Calls `supabaseAdmin.auth.getUser(token)` to get Google user data.
3. If user exists and is a **player**, blocks access (strict role separation).
4. If admin exists: updates only Google fields (name, photo, google_id). **Never overwrites role.**
5. If new user: inserts with `role: 'admin'`, `verification: 'pending'`, dummy address fields.
6. Blocks if not verified (pending/rejected).
7. Returns our backend JWT (30-day), not the Supabase session token.

> **Key decision:** Backend JWT is generated fresh every Google OAuth sync — it's independent of Supabase session lifecycle.

---

### 3. `adminController.js` — Admin Management

| Function           | Endpoint                                | Notes                                               |
|--------------------|-----------------------------------------|-----------------------------------------------------|
| `listAdmins`       | `GET /api/admin/list-admins`            | Lists `admin` + `superadmin` roles                  |
| `getPendingInstitutes` | `GET /api/admin/institutes/pending`| Lists `institutehead` users pending approval        |
| `getVerifiedInstitutes`| `GET /api/admin/institutes/verified`| Lists `institutehead` users verified                |
| `approveInstitute` | `PUT /api/admin/institutes/:id/approve` | Sets `verification = 'verified'`                    |
| `rejectInstitute`  | `PUT /api/admin/institutes/:id/reject`  | Sets `verification = 'rejected'`                    |
| `approveAdmin`     | `POST /api/admin/approve-admin/:id`     | Sets `verification = 'verified'`                    |
| `rejectAdmin`      | `POST /api/admin/reject-admin/:id`      | Sets `verification = 'rejected'`                    |
| `deleteAdmin`      | `DELETE /api/admin/delete-admin/:id`    | Transfers events to superadmin, then deletes        |
| `updateAdminRole`  | `POST /api/admin/update-admin-role/:id` | Only superadmin can change roles; cannot self-demote|
| `getDashboardStats`| `GET /api/admin/dashboard-stats`        | Player counts, revenue, recent/rejected lists       |
| `uploadAsset`      | `POST /api/admin/upload`               | Generic base64 upload to `admin-assets` bucket      |

#### Dashboard Stats Logic
- Counts `players` by `verification` status (total, verified, pending, rejected).
- Revenue = sum of `amount_paid` from `event_registrations` where `status = 'verified'`.
- Returns 6 most recent players, 5 most recent rejected players, 5 rejected registrations.

---

### 4. `playerController.js` — Player Dashboard

#### `getPlayerDashboard` (`GET /api/player/dashboard`)
Complex team detection logic:
1. Find teams where user is `captain_id`.
2. Find teams where user's mobile is in `members` JSON array.
3. Find teams where `player_id` appears in `members` JSON objects.
4. De-duplicate team IDs, then fetch registrations for player OR any of their teams.
5. Join transactions and team details for each registration.
6. Returns: player profile, school details, registrations (with events), family members.

#### `updateProfile` — Sensitive Change Protection
- If email or mobile is changing: requires `x-verification-token` header (short-lived JWT from OTP verification).
- Conflicts checked against other users (excluding self).
- Handles base64 photo upload.

#### `changePassword`
- Requires `x-verification-token` for verification.
- Plain text comparison and storage ⚠️.

#### `deleteAccount`
- Cascades: deletes school details, registrations, transactions, teams where captain.
- Does NOT delete `family_members` (potential orphan data ⚠️).

---

### 5. `eventController.js` — Event Management

| Function           | Description                                                             |
|--------------------|-------------------------------------------------------------------------|
| `listEvents`       | Lists all events with registration counts. Filterable by `admin_id`.   |
| `getEventDetails`  | Single event with news, assigned admin, registration category counts.   |
| `createEvent`      | Uploads banner, doc, payment QR, sponsor logos. Generates QR code.     |
| `updateEvent`      | Updates event. Handles image/doc re-upload. Cleans sentinel fields.    |
| `deleteEvent`      | Cascades: registrations, news, brackets. Then deletes event.           |
| `getEventBrackets` | Returns published brackets only. Supports `BRACKET` and `MEDIA` modes. |
| `getEventSponsors` | Returns sponsors array from event row.                                 |

#### Category Registration Counts
Counts registrations per category using flexible key extraction (handles `cat.id`, `cat.name`, `cat.category` — covers different historical formats).

---

### 6. `adminEventController.js` — Registration & Transaction Management

| Function                | Description                                                         |
|-------------------------|---------------------------------------------------------------------|
| `getAllCategories`       | Aggregates unique categories from all events.                       |
| `getRegistrations`      | All registrations with joins to events, users, teams.               |
| `getTransactions`       | Registrations with payment details. Filterable by `admin_id`.       |
| `verifyTransaction`     | Sets status = `verified`, sends notification to player.             |
| `rejectTransaction`     | Sets status = `rejected`, sends notification to player.             |
| `bulkUpdateTransactions`| Batch verify/reject multiple registrations. Sends notifications.    |
| `saveBracket`           | Upsert bracket with image upload support (single or multi-image).   |
| `deleteBracket`         | Deletes bracket + associated matches.                               |
| `getEventNews / CRUD`   | Full CRUD for event announcements.                                  |

---

### 7. `paymentController.js` — Manual Payment

`POST /api/payment/submit-manual-payment` flow:
1. Blocks admin users from registering.
2. Uploads payment screenshot to Supabase Storage.
3. Optionally uploads identity document.
4. Creates `transactions` record with `MANUAL_${timestamp}` order ID.
5. Creates `event_registrations` with `status: 'pending_verification'`.
6. Sends confirmation email asynchronously (fire-and-forget).
7. Returns `transactionId` and `registrationNo`.

> Atomic rollback: if registration insert fails, deletes the transaction record.

---

### 8. `matchController.js` — Scoreboard & Match Management (2,414 lines)

#### `generateMatchesFromBracket` (`POST /api/admin/matches/generate/:eventId/:categoryId`)
- Reads `event_brackets` with `mode = 'BRACKET'`.
- **Idempotent**: uses `upsert` on `(bracket_id, bracket_match_id)` conflict key.
- Handles BYE detection (one player, no opponent = `status: 'BYE'`).
- Optionally stores `selectedSets` in `bracket_data.rounds[n].setsConfig`.

#### `generateLeagueMatches` (`POST /api/admin/matches/generate-league/:eventId/:categoryId`)
- Reads participants from `leagues` table.
- Generates all unique pairs: n*(n-1)/2 matches per group.
- Supports group-based round-robin (group A, B, etc.).
- **Idempotent**: tracks existing pairs via in-memory Set.
- Creates/reuses a `LEAGUE_PLACEHOLDER` bracket for FK constraint.
- Smart category matching: 4-strategy fallback (exact ID → exact label → normalized → partial).

#### `updateMatchScore` (`PUT /api/admin/matches/:matchId/score`)
- Updates `score`, `winner`, `status`.
- Propagates winner to next bracket match via `winnerTo` / `winnerToSlot` fields.

#### `getMatches` (`GET /api/admin/matches/:eventId`)
- Returns all matches for an event, filtered optionally by `categoryId`.

#### `getPublicMatches` (`GET /api/events/:id/matches`)
- Returns all published bracket matches for public scoreboard view.

---

### 9. `bracketController.js` (~139KB) — Bracket Structure Engine

Organized into sub-controllers in `controllers/bracket/`:

| Sub-Controller                   | Responsibility                                              |
|----------------------------------|-------------------------------------------------------------|
| `bracketStructureController.js`  | Create full bracket structure (all rounds + empty matches)  |
| `byeController.js`               | BYE assignment, randomization, finalization                 |
| `matchPlacementController.js`    | Manual match placement in bracket                           |
| `normalSeedingController.js`     | Seed players (no ranking, random or sequential)             |
| `rankSeedingController.js`       | Seed players based on ranking                               |
| `propagationController.js`       | Propagate winners through bracket rounds                    |
| `scoreboardController.js`        | Scoreboard view logic                                       |
| `bracketHelpers.js`              | Shared utilities (UUID check, shuffle, seed helpers)        |

#### Key Bracket Concepts
- **Mode BRACKET:** Full interactive bracket with rounds and match propagation.
- **Mode MEDIA:** Simple image/PDF upload for draw display.
- **BYE Handling:** Players with no opponents auto-advance. Ranked players get priority BYEs.
- **`winnerTo` / `winnerToSlot`:** Match-level references for winner propagation chain.
- **`published` flag:** Controls visibility in public `getEventBrackets` endpoint.

---

### 10. `leagueController.js` — League (Round-Robin)

| Function          | Description                                                           |
|-------------------|-----------------------------------------------------------------------|
| `getLeagueConfig` | GET league config from `leagues` table. Returns defaults if not found.|
| `saveLeagueConfig`| Upsert league config. Deduplicates participants by ID. Cleans rules.  |
| `deleteLeague`    | Deletes league + optional in-memory-filtered match deletion.          |

- Default scoring: Win=3, Loss=0, Draw=1.
- Supports **groups** within a league (Group A, B, etc.).
- Participants stored as `[{id, name, group?}]` JSONB array.
- `category_id` in `leagues` is TEXT (accepts both UUIDs and numeric strings).

---

### 11. `teamController.js` — Team Management

| Function       | Description                                                         |
|----------------|---------------------------------------------------------------------|
| `getMyTeams`   | Teams where `captain_id = req.user.id`                             |
| `lookupPlayer` | Lookup player by `player_id` for team member addition              |
| `createTeam`   | Creates team, auto-populates captain info from `users` table       |
| `updateTeam`   | Updates team (captain-only gate)                                   |
| `deleteTeam`   | Deletes team (captain-only gate)                                   |

---

### 12. `notificationController.js`
- `GET /api/notifications` → last 50 notifications + unread count.
- `POST /api/notifications/mark-read` → mark single or all as read.
- Auth: any valid JWT (both player and admin).

---

### 13. `broadcastController.js` — Admin Broadcast
- Sends in-app notifications to a list of users.
- Processes in **chunks of 50** to avoid blocking.
- Logs broadcast to `broadcast_logs` table.
- Returns stats: `{ total, success, failed }`.

---

### 14. `advertisementController.js`
- Full CRUD for banner ads.
- `getAdvertisements` is **public** (no auth).
- `placement` field for ad positioning (defaults to `'general'`).
- `is_active` toggle via `PATCH /:id/toggle`.

---

### 15. `apartmentController.js`
- Reads apartments from an Excel file (`data/*.xlsx`).
- `migrateApartments`: Parse Excel → deduplicate → upsert to `apartments` table.
- Full CRUD API for apartments.
- `addApartment`: Case-insensitive duplicate check.

---

### 16. `settingsController.js` & `publicController.js`
- `platform_settings` table has single row with `id = 1`.
- Admin: full read/write. Public: read-only subset (no auth).
- Fields: `platform_name`, `logo_url`, `support_email`, `support_phone`, `logo_size`, `registration_config`.

---

### 17. `seedController.js` — Dev Data Seeder
- `GET /api/seed/seed-data` → Creates 32 dummy players, 1 event, registers them.
- ⚠️ **NO AUTH GUARD** — must be disabled in production!
- Creates real Supabase Auth users via `auth.admin.createUser`.

---

### 18. `adminPlayerController.js`
- `listPlayers`: All users with `role = 'player'`, ordered by `created_at DESC`.
- `getPlayerDetails`: Player profile + school details + event participation history.

---

### 19. `contactController.js`
- `sendMessage`: Public endpoint — stores contact form submission.
- `getMessages`: Admin view of all contact messages.
- `updateMessageStatus`: Allowed values: `cleared`, `ticket`, `pending`.

---

### 20. `instituteController.js` — Institute Feature
- `bulkImportStudents` (`POST /api/institute/bulk-import`):
  - Extracts `institute_id` securely from token (ignores body payloads to prevent impersonation).
  - Normalizes array of parsed Excel rows.
  - Generates UUIDs and inserts rows into `users` table (`role: 'player'`, `verification: 'pending'`, `institute_name: resolvedInstituteName`).
  - Checks for uniqueness conflicts (`23505 duplicate key`) and rejects batch completely.
  - Inserts log row to `institute_approvals` table linking the institute via foreign key.

---

## 🔒 Security Analysis

### ✅ Strengths
- Service Role Key stored server-side only (never exposed to client).
- Role-based access control enforced at middleware level.
- Short-lived (5-min) verification tokens for sensitive operations.
- Admin account requires 2-step verification (register + approve by superadmin).
- Google OAuth players cannot access admin routes (strict role separation).
- Admin cannot demote themselves.
- Admins cannot submit payments (role guard in paymentController).

### ⚠️ Issues Found

| Issue                                          | Location                          | Severity |
|------------------------------------------------|-----------------------------------|----------|
| **Plaintext passwords stored in DB**           | authController, playerController  | 🔴 HIGH  |
| **No CORS origin restriction**                 | server.js (`app.use(cors())`)     | 🟡 MED   |
| **Seed route has no auth guard**               | tempSeedRoutes → seedController   | 🟡 MED   |
| **2Factor API key hardcoded as fallback**      | otpService.js (line 5)            | 🟡 MED   |
| **No rate limiting on OTP endpoints**          | authRoutes.js                     | 🟡 MED   |
| **deleteAccount doesn't delete family_members**| playerController                  | 🟠 LOW   |
| **Password hint in welcome email** (DOB format)| mailer.js                         | 🟠 LOW   |
| **SUPABASE_PUBLIC_KEY and RECEIVER_EMAIL unused**| .env                            | 🟠 LOW   |
| **Redundant SUPABASE_SERVICE env var**         | .env                              | 🟠 LOW   |

---

## 🔄 Data Flow Examples

### Player Registration Flow
```
Frontend → POST /api/auth/check-conflict
        → POST /api/auth/send-otp (email OTP)
        → POST /api/auth/verify-otp
        → POST /api/auth/send-mobile-otp
        → POST /api/auth/verify-mobile-otp
        → POST /api/auth/register-player
              ↓ uploadBase64 → Supabase Storage
              ↓ get_next_player_id() RPC
              ↓ INSERT users
              ↓ INSERT player_school_details
              ↓ INSERT family_members
              ↓ jwt.sign (7d token)
              ↓ sendRegistrationSuccessEmail
        ← { success, token, playerId }
```

### Event Registration (Payment) Flow
```
Player → POST /api/payment/submit-manual-payment
           ↓ uploadBase64(screenshot) → Supabase Storage
           ↓ uploadBase64(document) → Supabase Storage
           ↓ INSERT transactions { status: pending... }
           ↓ INSERT event_registrations { status: 'pending_verification' }
           ↓ sendRegistrationEmail (async/fire-and-forget)
         ← { transactionId, registrationNo }

Admin  → PUT /api/admin/transactions/:id/verify
           ↓ UPDATE event_registrations { status: 'verified' }
           ↓ createNotification(player, "Registration Verified")
```

### Bracket Generation Flow
```
Admin → POST /api/admin/events/:id/categories/:catId/bracket/init
      → POST /api/admin/events/:id/categories/:catId/bracket/start
           ↓ Creates event_brackets with bracket_data.rounds[]
      → POST /api/admin/matches/generate/:eventId/:catId
           ↓ UPSERT matches (idempotent on bracket_id + bracket_match_id)
      → PUT /api/admin/matches/:matchId/score
           ↓ Updates score/winner → propagates to next round via winnerTo
      → POST /api/admin/events/:id/categories/:catId/publish
           ↓ Sets event_brackets.published = true
Public → GET /api/events/:id/brackets (only published = true shown)
```

---

## 📝 Key Technical Observations

1. **Category ID type inconsistency**: `event_brackets.category_id` is UUID, `leagues.category_id` is TEXT → root cause of 4-strategy category matching logic in `generateLeagueMatches`.

2. **Massive controller files**: `matchController.js` (~2,400 lines), `bracketController.js` (~139KB) — need splitting. The `bracket/` subfolder was started but `bracketController.js` is still the primary entry point (duplicated logic risk).

3. **No true DB transactions**: Multi-table operations use manual cleanup (e.g., delete transaction if registration fails). True atomicity requires PostgreSQL functions/stored procedures.

4. **Player team lookup inefficiency**: Dashboard uses 3 separate queries + in-memory scan of all teams. A normalized `team_members` join table would be far more efficient.

5. **Critical Supabase RPC dependency**: `get_next_player_id()` — must exist in Supabase DB. If missing, all player registrations break.

6. **Seed route in production**: `/api/seed/seed-data` has NO auth and creates real Supabase Auth users. Must be removed pre-deployment.

7. **Event ID type mismatch**: `getEventBrackets` explicitly converts `eventId` to integer — suggesting `events.id` is `bigint` while other places treat it as string.

8. **Dual bracket mode**: BRACKET (interactive knockout) vs MEDIA (image upload) adds complexity but is well-designed. `published` flag controls public visibility.

9. **`registration_config` in platform_settings**: Stored as JSONB but schema not enforced anywhere — could lead to inconsistencies.

10. **BYE finalization**: Two-step workflow (`randomizeRound1Byes` then `finalizeByes`) must be followed in sequence — no guard preventing out-of-order calls.

---

## 🚀 Available npm Scripts

```bash
npm run dev              # Start with nodemon (dev mode)
npm run start            # Production start
npm run seed:settings    # Seed platform settings
npm run seed:event       # Seed test event
npm run seed:fresh       # Seed fresh test event
npm run seed:multi       # Seed multi-category event
npm run seed:football    # Seed football event
npm run check:db         # Check DB connectivity
```

---

## 🌐 Environment Variables

| Variable                    | Purpose                                                    | Used?  |
|-----------------------------|------------------------------------------------------------|--------|
| `PORT`                      | Server port (default: 5000)                                | ✅     |
| `SUPABASE_URL`              | Supabase project URL                                       | ✅     |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (bypasses RLS)                            | ✅     |
| `SUPABASE_SERVICE`          | Duplicate of service role key                              | ⚠️ Dup |
| `SUPABASE_PUBLIC_KEY`       | Publishable key                                            | ❌     |
| `SUPABASE_JWT_SECRET`       | Supabase JWT secret                                        | ❌     |
| `JWT_SECRET`                | Custom JWT signing secret                                  | ✅     |
| `EMAIL_USER`                | Gmail sender address                                       | ✅     |
| `EMAIL_PASS`                | Gmail App Password                                         | ✅     |
| `RECEIVER_EMAIL`            | Internal notification receiver                             | ❌     |
| `TWO_FACTOR_API_KEY`        | 2Factor.in API key for SMS OTP                             | ✅     |
| `ADMIN_FRONTEND_URL`        | Used in Google OAuth redirect                              | ✅     |
| `FRONTEND_URL`              | Used for QR code link generation                           | ✅     |

---

*This document covers every file, function, and business rule in the current backend codebase. Ready for implementation tasks.*
