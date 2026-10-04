# Questions for Levon (Ascension IT)

Running list of decisions that need the client, kept so nothing gets lost between sessions.
Nothing here blocks the demo — every item has a working assumption already built in, chosen
so a different answer is cheap to change.

**Legend** — 🔴 changes architecture · 🟡 changes scope or cost · 🟢 confirms an assumption

---

## Highest value: ask these first

### 🔴 1. Do the ~120 reps have Microsoft 365 or Google Workspace accounts?
The consultation notes the end client already pays for Office 365. **If the reps have accounts
on it**, "Sign in with Microsoft" is strictly better than anything else we can build: no
emails, no passwords, one tap on a phone, individual identity preserved, and offboarding
handled centrally by their IT the moment someone leaves.

If they are genuinely external reps using their own addresses, we stay with the enrollment
flow. Worth one question because it removes a whole category of work.

*Currently assumed:* external reps with their own email addresses.

### 🔴 2. Is QuickBooks' inventory trustworthy today, or does someone hand-correct it?
If staff routinely correct numbers QuickBooks gets wrong, **their corrections are the real
data** and the admin override layer is the permanent product, not a stopgap awaiting the
integration. That changes what we're selling and what phase 2 is worth.

*Currently assumed:* the override layer is permanent and first-class. Built that way.

### 🔴 3. Sales Orders or Invoices — and when are they actually entered?
Determines whether `available` can be derived from QuickBooks at all, and how wrong `on_hand`
currently is. This is the single biggest unknown in the integration estimate; **do not quote a
fixed price for the QuickBooks work before this is answered.**

**DECIDED (3 Oct 2026):** committed is taken from QuickBooks — the quantity on open sales
orders — and nothing else. Reps no longer record commitments in the portal; the portal's delta
ledger was removed in migration 0025. Available = on hand − committed in QuickBooks.

*Consequence the client must accept:* stock promised before a sales order exists in QuickBooks
is not shown as committed, so another rep can see it as available. The client must enter sales
orders promptly. The schema still stores the components separately, so the figures can be
re-derived if this changes.

### 🔴 4. Multi-location inventory?
If they run Enterprise with Advanced Inventory across warehouses, quantity is per-site and both
the schema and the UI change materially.

*Currently assumed:* single location. Every row carries `location = 'default'` and the column
exists from day one, so adding real sites is data plus UI, not a migration.

---

## Needed before real users

### 🟡 5. Who is the operational admin, and who offboards a rep?
Someone must own inventory corrections, running the sync, and removing a rep who leaves. Right
now there is exactly one admin account (yours). A rep who leaves keeps a valid session for
~400 days unless someone deletes them.

### 🟡 6. Can we get the rep email list?
Needed to bulk-import the allowlist so reps can self-enroll. Without it, accounts must be
created one at a time.

### 🟢 7. Which email domain should magic links come from?
Needed for custom SMTP. Supabase's built-in mailer is rate-capped and will not serve 120
people — this is a real deployment prerequisite, not a nicety.

### 🟡 8. Real product names, or a sample of the Monday spreadsheet?
The seed catalogue is synthetic and deliberately generic. Real names make the demo land
harder, and confirm our category taxonomy matches how they actually think about stock.

---

## Scope and commercial

### 🟡 9. Is this a pilot or production from day one?
A working authenticated app invites "can we start Monday?" Worth deciding *before* the demo
rather than under pressure in the room.

### 🟡 10. Branding — Kyrie, Ascension, or neutral?
Currently neutral by decision: no logo, no company name, warm/professional. If it should carry
Ascension's identity, we need assets — we will not invent them.

### 🟡 11. Does the honest recommendation include SharePoint?
The client already pays for Office 365, and the consultation flagged a preference for using it.
The document-library half of the original brief may genuinely belong in SharePoint, with this
app owning the inventory view and corrections (committed stock comes from QuickBooks). Saying so builds trust and narrows scope to what we do
best.

### 🟢 12. Do they need work-order numbers, labour time, costs, or purchase approvals?
*Currently assumed:* not in v1. Out of scope and out of the estimate.

---

## Smaller confirmations

- **13.** ~~🟢 Should every rep see all commitments, or only their own?~~ *Obsolete (3 Oct 2026):
  reps no longer record commitments in the portal (item 3). The historical `commitments` rows
  remain visible own-only to reps and in full to admins, enforced in the database.*
- **14.** 🟢 What counts as "stale" inventory? *Assumed: 6 hours. One settings row to change.*
- **15.** 🟢 Low-stock threshold? *Assumed: 5 units, per-product overridable.*
- **16.** 🟡 What does "automate reaching out" mean concretely — notify staff, auto-assign, or
  email a vendor? *Assumed: prepare and suggest, human confirms. Nothing sends by itself.*
- **17.** 🟡 Data retention — is maintenance/commitment history kept indefinitely? *Assumed:
  retained, never auto-deleted. The pre-0025 commitment ledger is kept read-only as history.*

---

*Last updated 2026-10-03. Add to this rather than starting a new list.*
