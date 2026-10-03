# IMS Security Checklist

Daniel Sweeten's 63-question questionnaire (8 Sep 2026), mapped to this repository — the
Plantation Prestige Inventory Management System — as the first project under the proposed
Ascension Systems development process (response of 24 Sep 2026).

**Draft, 3 Oct 2026.** Status reflects what was observed in this repository on that date,
not what is planned. Owners are proposed and need agreement.

## Scope that shapes every answer

- **The IMS has no AI features at runtime.** No model is called by the deployed app. AI is used
  in *development* only (Claude Code / Codex via the claudex loop). Questions about runtime
  LLM tool use and prompt injection (1.9–1.12, 4.6) apply to the development process, not the
  product — say so explicitly rather than leaving them blank.
- **One integration, read-only.** The only external system is QuickBooks Desktop, read through
  a single adapter (`lib/inventory-source.ts`). No PSA, RMM, Microsoft 365 or Entra access.
  After workstream WS2 the app writes nothing to QuickBooks and records no commitments of its
  own; `committed` comes from QuickBooks sales orders.
- **Single tenant.** One client, one Supabase project (`rakslwwxduovcqnuercz`), one Netlify site.
- **Data:** product catalogue, inventory quantities, rep/admin accounts (name, email), product
  images and documents. No PHI, CUI or payment data.

## Status legend

| Status | Meaning |
|---|---|
| ✅ Done | Implemented and evidenced in this repo |
| 🟡 Partial | Some implementation or evidence exists; gap noted |
| 🔴 Gap | Not implemented |
| ⚪ N/A (IMS) | Does not apply to this system; state why in the response |
| 📄 Org/Legal | Organisational, contractual or insurance item, not code |

## Workstreams

| ID | Workstream | Delivered as |
|---|---|---|
| WS0 | Repo governance: private repo, `main` ruleset, CODEOWNERS, deploy only from `main` | GitHub settings (human) |
| WS1 | CI security baseline: Semgrep, Gitleaks, npm audit, typecheck/lint, `check:all`, SBOM | PR |
| WS2 | QuickBooks-sourced commitments: remove portal commitment write path | PR (claudex loop) |
| WS3 | QuickBooks adapter contract: QB field mapping, fixture source, sync audit | PR (claudex loop) |
| WS4 | Access-control/RLS tests running in CI against local Supabase | PR (claudex loop) |
| WS5 | IMS evidence pack: threat model, data map, integration register, AI inventory | PR (docs) |
| WS6 | Operations: audit log, backups/restore test, incident response, monitoring | PR + decisions |

---

## 1. AI development and review

| # | Question (short) | Status | IMS action | WS | Owner |
|---|---|---|---|---|---|
| 1.1 | Human review of every AI change before merge | 🔴 Gap | ~124 commits pushed directly to `main`, 0 PRs. All changes from now via PR with human approval. | WS0 | Caleb / John |
| 1.2 | Reviewer roles and qualifications | 📄 Org | Document John's scope (every production change), qualifications, backup reviewer. | — | Hoke / John |
| 1.3 | Branch protection enforcing it | 🔴 Gap | No rulesets on this repo. Mirror tooling ruleset 23903960: PR, 1 approval, stale-dismiss, last-push approval, conversation resolution, required CI check, no force-push/delete, no bypass. Add CODEOWNERS. | WS0 | Repo admin |
| 1.4 | Sample PR with full trail | 🔴 Gap | The WS2 PR becomes the sample: loop run record, cross-model review, CI results, human approval, Netlify deploy record. | WS2 | Caleb |
| 1.5 | Client data in AI tools | 🟡 Partial | Policy drafted in tooling repo. For IMS: seed/catalogue data is Plantation's public catalogue; no QuickBooks exports or customer records in prompts. State this in `AI-DATA-USE` for IMS. | WS5 | Caleb |
| 1.6 | AI plan/API and retention settings | 🟡 Partial | Record actual Claude Enterprise / ChatGPT Business / Codex settings used for this repo's runs. | WS5 | Caleb |
| 1.7 | AI tool/model inventory | 🟡 Partial | Loop run records capture model per run. Add IMS `AI-SYSTEM-INVENTORY.md` (dev-only; none at runtime). | WS5 | Caleb |
| 1.8 | Model/prompt/agent change control | 🟡 Partial | Pin claudex loop commit used for IMS runs; record it in each PR. | WS5 | Hoke |
| 1.9 | "AI cannot write" — enforced? | ⚪ N/A (IMS runtime) | No runtime AI. In development, agents commit to branches only; `main` writes blocked by ruleset (WS0). | WS0 | — |
| 1.10 | Demonstrate denied unauthorized write | 🟡 Partial | No AI/PSA path exists. Demonstrate instead: (a) ruleset rejects direct push to `main`; (b) rep account denied admin RPCs (`verify/04`). | WS0, WS4 | Caleb |
| 1.11 | Can an LLM invoke write tools | ⚪ N/A (IMS runtime) | No LLM in the product. | — | — |
| 1.12 | Prompt-injection defence | ⚪ N/A (IMS runtime) | No LLM consumes app data. Dev-time: QuickBooks payloads never fed to agents. | — | — |

## 2. Secure development and testing

| # | Question (short) | Status | IMS action | WS | Owner |
|---|---|---|---|---|---|
| 2.1 | Named SAST/SCA/secret/IaC/DAST tools | 🟡 Partial | Local `check:secrets`, `check:sql`, `check:routes` exist; no CI. Add Semgrep (JS/TS + local rules), Gitleaks, `npm audit`. DAST (e.g. OWASP ZAP baseline) against deploy preview — decide. No containers/IaC in this repo. | WS1 | Caleb |
| 2.2 | When they run | 🔴 Gap | No `.github/workflows`. Run on every PR and push to `main`; weekly scheduled rescan. | WS1 | Caleb |
| 2.3 | Blocking thresholds | 🔴 Gap | Block on any Critical/High, any secret, any failed check. Medium/Low need a recorded disposition. | WS1 | Caleb |
| 2.4 | Remediation SLA | 📄 Org | Propose Critical 7 days / High 30 days for IMS; needs agreed owner. | — | Hoke |
| 2.5 | SBOM | 🔴 Gap | Generate CycloneDX via `npm sbom` in CI; attach to each release candidate. | WS1 | Caleb |
| 2.6 | Signed commits, pinning, provenance | 🟡 Partial | `package-lock.json` present; Supabase and Next pinned; several `^` ranges (Capacitor, framer-motion). Use `npm ci`, SHA-pin Actions, consider required signed commits. | WS1 | Caleb |
| 2.7 | Supply-chain protection | 🟡 Partial | Lockfile only. Add npm audit gate, Dependabot alerts, review of dependency diffs in PRs. | WS1 | Caleb |
| 2.8 | Threat modelling | 🔴 Gap | Write IMS threat model before WS2/WS3 merge (QuickBooks sync path, admin import, documents storage, push). | WS5 | Hoke |
| 2.9 | Security tests mandatory | 🟡 Partial | `verify/` has RLS-bypass, concurrency, stale-baseline and role-enforcement attacks, but run manually against hosted. Make them a required CI check. | WS4 | Caleb |
| 2.10 | Corrective control for zero-test / stale-RLS gaps | 🔴 Gap | CI job applies all migrations to a fresh local Supabase and runs RLS/role tests on every PR that touches `supabase/`. | WS4 | Caleb |

## 3. Integrations and access model

| # | Question (short) | Status | IMS action | WS | Owner |
|---|---|---|---|---|---|
| 3.1 | Exact scopes/endpoints per integration | 🔴 Gap | Integration register: QuickBooks Desktop via Conductor/Web Connector, read-only item queries (QuantityOnHand, QuantityOnSalesOrder, QuantityOnOrder). Supabase, Netlify, APNs listed as platform services. | WS3, WS5 | Hoke |
| 3.2 | Read-only by default | 🟡 Partial | Adapter interface is read-only (`fetchInventory`). After WS2 there is no write path at all. Confirm the Conductor credential is query-only. | WS2, WS3 | Hoke |
| 3.3 | Separate credential per integration | 🟡 Partial | Single client; one dedicated QuickBooks connector credential, stored only in Netlify env. | WS3 | Hoke |
| 3.4 | Can it create/change/delete records in client systems | ✅ After WS2 | No writes to QuickBooks. Remove `record_commitment` write path. App writes only its own tables (overrides, documents, accounts). | WS2 | Caleb |
| 3.5 | Human approval gate for writes | ⚪ N/A (external) | No external writes. Internal admin actions (sync, overrides, import) are admin-only and audited (WS6). | WS6 | — |
| 3.6 | Token compromise / revocation | 🔴 Gap | Runbook: rotate Conductor key, Supabase service-role key, `PUSH_CRON_SECRET`; time it once. | WS6 | Caleb |

## 4. Tenant isolation, data protection, access

| # | Question (short) | Status | IMS action | WS | Owner |
|---|---|---|---|---|---|
| 4.1 | Single or multi-tenant | ✅ Done | Single tenant: dedicated Supabase project and Netlify site. | WS5 | — |
| 4.2 | RLS the only separation | ✅ Done | Tenant separation is by project; RLS separates rep vs admin within it. | WS5 | — |
| 4.3 | Cross-tenant / IDOR / escalation tests | 🟡 Partial | `verify/01`, `verify/04`, `escalation`, `takeover` exist; run in CI and record results per release. | WS4 | Caleb |
| 4.4 | Data collected / sent to AI | 🟡 Partial | Data map (see Scope). Nothing sent to AI at runtime. | WS5 | Caleb |
| 4.5 | Where each data category lives | 🔴 Gap | Record Supabase region, storage buckets (documents, product images), Netlify logs, backups, APNs. | WS5 | Caleb |
| 4.6 | Sensitive data excluded from AI prompts | ⚪ N/A (IMS runtime) | No runtime AI. Dev-time rule in 1.5. | — | — |
| 4.7 | Encryption and keys | 🟡 Partial | TLS in transit, Supabase/Netlify-managed encryption at rest. Customer-managed keys not offered; document this. | WS5 | Hoke |
| 4.8 | Privileged support access | 🔴 Gap | Named list of Supabase/Netlify/GitHub admins, MFA required, quarterly access review. | WS6 | Hoke |
| 4.9 | MFA / SSO / RBAC | 🟡 Partial | App: email+password, per-email lockout (0019), rep/admin RBAC. No MFA or SSO for app users. Decide: Entra/M365 SSO (client already uses Office 365) or TOTP MFA for admins. | WS6 | Hoke |

## 5. Logging, monitoring, backups, incident response

| # | Question (short) | Status | IMS action | WS | Owner |
|---|---|---|---|---|---|
| 5.1 | Audit events logged | 🟡 Partial | `inventory_sync_runs`, override fields (`override_by/at`) exist. Add an append-only audit table for login, role changes, overrides, imports, syncs, document changes. | WS6 | Caleb |
| 5.2 | SIEM export | 🔴 Gap | Decide target SIEM with Ascension IT; Supabase log drains or scheduled export. | WS6 | Ascension IT |
| 5.3 | Log retention | 🔴 Gap | Agree retention; record Supabase/Netlify defaults. | WS6 | Hoke |
| 5.4 | Tamper-evident logs | 🔴 Gap | Audit table insert-only via RLS/grants; no update/delete grants. | WS6 | Caleb |
| 5.5 | Monitoring and alerting | 🔴 Gap | Alerts for repeated lockouts, sync failures, bulk import, role changes. | WS6 | Caleb |
| 5.6 | RPO/RTO, restore test | 🔴 Gap | Confirm Supabase plan backups (PITR?); perform and record one restore into a scratch project. | WS6 | Caleb |
| 5.7 | IR plan / breach playbook | 🟡 Partial | Draft exists in tooling repo; add IMS contacts and key-rotation steps. | WS6 | Hoke |
| 5.8 | Notification timelines | 📄 Org | Contract item. | — | Legal |
| 5.9 | Investigation support | 📄 Org | Contract item. | — | Legal |

## 6. Contract, legal, risk transfer

All 📄 Org/Legal. Not repository work; tracked here so nothing is lost.

| # | Topic | IMS note | Owner |
|---|---|---|---|
| 6.1 | MSA, SOW, DPA, security addendum, subprocessors | Subprocessors for IMS: Supabase, Netlify, GitHub, Apple (APNs), Conductor (when live). | Legal |
| 6.2 | Processor / service-provider role | Ascension Systems LLC per 15 Sep proposal. | Legal |
| 6.3 | BAA | ⚪ N/A — no PHI in IMS. | — |
| 6.4 | CMMC / CUI boundary | ⚪ N/A — no CUI in IMS. | — |
| 6.5 | Reasonable-security warranty | Draft against this checklist. | Legal |
| 6.6 | Indemnity | Negotiation. | Legal |
| 6.7 | Liability cap carve-outs | Negotiation. | Legal |
| 6.8 | Cyber / tech E&O | Cyber endorsement binding and E&O terms still unverified. | Caleb |
| 6.9 | IP ownership | Per 15 Sep proposal; IMS code to Ascension Systems. | Legal |
| 6.10 | Exit, export, deletion | Export: SQL dump + storage bucket copy; deletion: delete Supabase project, Netlify site. Test once. | Caleb |
| 6.11 | Subcontractors / offshore | Caleb and Hoke only; record in register. | Caleb |
| 6.12 | No training on client data | Contract clause + provider settings (1.6). | Legal |

## 7. Production readiness and evidence

| # | Question (short) | Status | IMS action | WS | Owner |
|---|---|---|---|---|---|
| 7.1 | Readiness classification | 🟡 | Current: demo-ready with seed data. Target after WS0–WS6: pilot-ready with real QuickBooks read-only data. | — | Hoke |
| 7.2 | Evidence package for exact build | 🔴 Gap | Release-candidate packet: commit SHA, SBOM, CI run, RLS test results, threat model, data map, known limits, screenshots. | WS5 | Caleb |
| 7.3 | Independent pentest | 🔴 Gap | Scope and fund an external test before production use. | — | Hoke / Ascension |
| 7.4 | Pentest report | 🔴 Gap | Follows 7.3. | — | — |
| 7.5 | Pentest coverage | 🔴 Gap | Authenticated app, API routes, RLS/role escalation, storage buckets, sync endpoint, push cron secret. | — | — |

---

## Immediate findings (3 Oct 2026)

1. **Repository is public.** Source, migrations, scripts and the Supabase project ref are world-readable. Make private before further work (WS0).
2. **No branch protection and no PR history.** Every commit went straight to `main`, which Netlify deploys automatically.
3. **No CI.** Existing checks (`check:all`, `verify/*`) run only when someone runs them by hand.
4. **Hosted database state unknown.** README says no migrations were applied to the hosted project; 24 now exist. Confirm before any evidence is collected from the hosted environment.
5. **`check:encoding` references `../../tools/`**, which is outside this repo, so `npm run check:all` cannot pass from a standalone clone.
