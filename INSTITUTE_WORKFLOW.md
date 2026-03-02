# 🏢 Institute Bulk Registration & Approval Flow

**Date:** February 26, 2026  
**Author:** Backend Team  
**System:** Mera Sports Backend

---

## 🎯 Architectural Overview
The Institute Bulk Import feature solves the problem of securely onboarding hundreds of players via Excel sheets. To prevent malicious or unchecked mass-insertions into the `users` database, we implemented a **3-Phase Delegated Approval Workflow**.

This document outlines the entire flow, the new database tables, and the API endpoints across the `auth`, `institute`, and `admin` domains.

---

## 🗄️ Database Changes (Supabase)

### New Table: `institute_approvals`
This table acts as a ledger/ticketing system for bulk upload requests.

```sql
CREATE TABLE public.institute_approvals (
  id uuid not null default gen_random_uuid (),
  institute_id uuid not null,                    -- Linked to users table
  institute_name text not null,
  student_count integer not null,                -- Size of the Excel sheet
  is_approved boolean not null default false,    -- Controlled by Superadmin
  created_at timestamp with time zone null default now(),
  constraint institute_approvals_pkey primary key (id),
  constraint institute_approvals_institute_id_fkey foreign key (institute_id) references users (id) on delete cascade
);
```

---

## 🔄 The 3-Phase Interactive Workflow

### Phase 1: The Import Request (Institute Portal)
When an Institute Head uploads an Excel sheet, the frontend parses the rows, saves the data to `localStorage` (to survive browser refreshes without holding onto a 5MB base64 string), and immediately asks the backend for permission to insert the records.

👉 **`POST /api/institute/request-bulk-approval`**
- **Trigger:** Clicking "Confirm & Import Data" on the frontend.
- **Actor:** Institute Head (`verifyInstitute` middleware).
- **Body:** `{ "student_count": 45 }`
- **Backend Action:** Extracts `institute_id` securely from the JWT token and creates a standard `is_approved = false` row in `institute_approvals`.
- **Frontend Action:** UI locks to an "⌛ Awaiting Approval" state and begins polling Phase 1B every 5 seconds.

👉 **`GET /api/institute/approval-status`** (Polling)
- **Trigger:** 5-second interval while waiting.
- **Backend Action:** Checks the latest `institute_approvals` row for that JWT user and returns `is_approved: true/false`.

---

### Phase 2: The Superadmin Authorization (Admin Portal)
The Superadmin logs into their separate dashboard, sees exactly which institutes are trying to upload exactly how many students, and manually grants database insert rights.

👉 **`GET /api/admin/institutes/imports/pending`**
- **Actor:** Superadmin (`verifyAdmin` middleware).
- **Backend Action:** Returns all rows from `institute_approvals` where `is_approved = false`. Used to populate the Admin's "Pending Approvals" table.

👉 **`PUT /api/admin/institutes/imports/:id/approve`**
- **Trigger:** Admin clicks "Approve" on a specific request ticket.
- **Backend Action:** Flips `is_approved = true` in the ledger. It **does not** touch the `users` table yet.

---

### Phase 3: The Final Execution (Institute Portal)
Because of Phase 1B polling, the Institute Head's frontend detects that `is_approved` is now `true`. The UI unlocks the final "Complete Registration" button.

👉 **`POST /api/institute/bulk-import-finalize`**
- **Trigger:** Institute Head clicks the unlocked "Approve" (Complete) button.
- **Body:** `{ "excelBase64": "data:application/vnd.openxmlformats-..." }`
- **Backend Action (CRITICAL SECURITY):**
  1. Verifies the `institute_approvals` ledger still says `is_approved = true` for this exact JWT. Blocks immediately (`403 Forbidden`) if false.
  2. Parses the raw Base64 Excel sheet natively using `xlsx`, cleanly serializing dates and strings.
  3. Iterates through the rows and maps them to User objects (`role: 'player'`, `verification: 'verified'`).
  4. Attempts insertion **one by one** to catch `23505 Duplicate Key` conflicts (mobile/email/aadhaar clashing with existing accounts).
  5. Dynamically flags exactly which column caused the failure via the `errorField` property.
  6. **Deletes** the approval ticket from `institute_approvals` so it cannot be reused.
- **Response Structure (Smart Error Reporting):**
  ```json
  {
    "success": true, // Always 200 OK so frontend can parse results
    "message": "Import finished. Some records require correction.",
    "results": {
      "successful": [ { "first_name": "Rohan", ... } ],
      "failed": [
        {
          "row": { "first_name": "Ajay", "email": "duplicate@example.com" },
          "errorField": "email",
          "reason": "Email already exists in the users table."
        }
      ]
    }
  }
  ```

---

## 🛡️ Key Security Measures Employed

1. **Implicit Token Trust:** APIs never explicitly trust an `institute_id` passed in a JSON body. The ID is always extracted natively via `req.user.id` from the deeply validated JWT payload.
2. **Role Fencing via `rbacMiddleware.js`:** Introduced `verifyInstitute` to explicitly block `player` tokens from impersonating Institute actions.
3. **Outage Resilience:** Auth controllers now cleanly catch `TypeError: fetch failed` during Supabase network outages and emit a graceful `503 Service Unavailable`, preventing silent `401 Unauthorized` misreports.
4. **Idempotent Ticket Destruction:** Reusing an approved ticket is impossible because the `bulk-import-finalize` route explicitly deletes the ticket row the millisecond the insertion finishes seamlessly.
