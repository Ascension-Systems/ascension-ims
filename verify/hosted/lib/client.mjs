/**
 * The hosted channel. HTTPS ONLY.
 *
 * ------------------------------------------------------------------------------------
 * WHAT THIS CAN AND CANNOT REACH, AND WHY IT DRIVES THE WHOLE CLASSIFICATION
 * ------------------------------------------------------------------------------------
 * A Supabase direct or pooler connection string embeds the database password, and the
 * credential rule forbids accepting a password. So there is no SUPABASE_DB_URL, no
 * DATABASE_URL, and no `pg` client anywhere on this path. The entire surface is:
 *
 *   PostgREST  /rest/v1/...       table reads, filtered writes, refusal SQLSTATEs
 *   PostgREST  /rest/v1/rpc/...   record_commitment, apply_inventory_sync
 *   GoTrue     /auth/v1/...       admin user creation, magic links, OTP exchange, real JWTs
 *   the app    over plain HTTP    only when PORTAL_BASE_URL is set
 *
 * Three consequences, none of them negotiable:
 *
 *   1. EACH REQUEST IS ITS OWN TRANSACTION. No BEGIN, no lock held across statements, no
 *      SET LOCAL ROLE. Any assertion that needs a transaction to stay open is unreachable
 *      and is reported NOT EXECUTED, never approximated.
 *   2. pg_catalog IS NOT EXPOSED. pg_class, pg_locks, pg_stat_activity, pg_blocking_pids
 *      and pg_get_functiondef are all unreachable.
 *   3. THERE IS NO ROLLBACK. Every request commits. This is why the harness confines its
 *      writes to the KYV namespace (see fixtures.mjs) instead of porting the local
 *      attacks' destructive statements literally onto a client's live project.
 *
 * IDENTITY: one header set per identity, built once, never mutated. `setSession` on a
 * shared client is deliberately not used — a misattributed request must be structurally
 * impossible, not merely avoided.
 */

/* ==================================================================== *
 * Identities
 * ==================================================================== */

/**
 * Builds the four header sets.
 *
 * `service` sends the service-role key as both apikey and bearer. That value never leaves
 * this process: it is not logged, not echoed, not written to disk, and not passed to the
 * application under test.
 */
export function buildIdentities(cfg, { repAccessToken = null, adminAccessToken = null } = {}) {
  const anonKey = cfg.anonKey
  const serviceKey = cfg.serviceKey

  const identities = {
    anon: { name: 'anon', headers: { apikey: anonKey } },
    service: {
      name: 'service_role',
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
    },
  }
  if (repAccessToken) {
    identities.rep = {
      name: 'rep',
      headers: { apikey: anonKey, authorization: `Bearer ${repAccessToken}` },
    }
  }
  if (adminAccessToken) {
    identities.admin = {
      name: 'admin',
      headers: { apikey: anonKey, authorization: `Bearer ${adminAccessToken}` },
    }
  }
  return identities
}

/* ==================================================================== *
 * PostgREST
 * ==================================================================== */

const jsonOrNull = async (res) => {
  const text = await res.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

/**
 * One PostgREST request.
 *
 * Returns a uniform outcome so an assertion can branch on the SQLSTATE the way the
 * application does — NEVER on message text:
 *
 *   { ok, status, rows, rowCount, body, code, message, details, hint }
 *
 * `code` is PostgREST's `code` field, which carries the Postgres SQLSTATE for a database
 * error (42501, KY001, KY003, KY006 …) and PostgREST's own codes for transport-level
 * problems (PGRST205 for a missing table, which is how "schema not applied" is detected).
 */
export async function rest(cfg, identity, method, path, { query = '', body, prefer, headers = {} } = {}) {
  const url = `${cfg.restUrl}${path}${query ? `?${query}` : ''}`
  const init = {
    method,
    headers: {
      ...identity.headers,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(prefer ? { prefer } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }

  let res
  try {
    res = await fetch(url, init)
  } catch (err) {
    return {
      ok: false,
      status: 0,
      rows: [],
      rowCount: 0,
      body: null,
      code: 'ENETWORK',
      message: err?.message ?? String(err),
      details: null,
      hint: null,
    }
  }

  const parsed = await jsonOrNull(res)

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      rows: [],
      rowCount: 0,
      body: parsed,
      code: parsed?.code ?? `HTTP_${res.status}`,
      message: parsed?.message ?? `HTTP ${res.status}`,
      details: parsed?.details ?? null,
      hint: parsed?.hint ?? null,
    }
  }

  const rows = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed]
  return {
    ok: true,
    status: res.status,
    rows,
    rowCount: rows.length,
    body: parsed,
    code: null,
    message: null,
    details: null,
    hint: null,
  }
}

export const selectRows = (cfg, identity, table, query) =>
  rest(cfg, identity, 'GET', `/${table}`, { query })

export const insertRows = (cfg, identity, table, body, prefer = 'return=representation') =>
  rest(cfg, identity, 'POST', `/${table}`, { body, prefer })

export const upsertRows = (cfg, identity, table, body) =>
  rest(cfg, identity, 'POST', `/${table}`, {
    body,
    prefer: 'return=representation,resolution=merge-duplicates',
  })

/**
 * PATCH with `return=representation`, so `rowCount` is the number of rows the statement
 * actually affected. That distinction is the whole point of the RLS write assertions: an
 * UPDATE an RLS USING clause filters out raises nothing and affects 0 rows, and "no error
 * and 0 rows" is not accepted on its own anywhere in this harness.
 */
export const updateRows = (cfg, identity, table, query, body) =>
  rest(cfg, identity, 'PATCH', `/${table}`, { query, body, prefer: 'return=representation' })

export const deleteRows = (cfg, identity, table, query) =>
  rest(cfg, identity, 'DELETE', `/${table}`, { query, prefer: 'return=representation' })

/** RPC. The returned value is in `.body` (a scalar, object or array, per the function). */
export const rpc = (cfg, identity, fn, args) =>
  rest(cfg, identity, 'POST', `/rpc/${fn}`, { body: args })

/** count=exact without transferring rows. Returns { ok, count, code, message }. */
export async function countRows(cfg, identity, table, query = '') {
  const url = `${cfg.restUrl}/${table}${query ? `?${query}` : ''}`
  let res
  try {
    res = await fetch(url, {
      method: 'HEAD',
      headers: { ...identity.headers, prefer: 'count=exact', range: '0-0' },
    })
  } catch (err) {
    return { ok: false, count: null, code: 'ENETWORK', message: err?.message ?? String(err) }
  }
  if (!res.ok) {
    return { ok: false, count: null, code: `HTTP_${res.status}`, message: `HTTP ${res.status}` }
  }
  const range = res.headers.get('content-range') // e.g. "0-0/97"
  const total = range && range.includes('/') ? range.split('/')[1] : null
  const n = total === null || total === '*' ? null : Number(total)
  return { ok: Number.isInteger(n), count: n, code: null, message: null }
}

/* ==================================================================== *
 * GoTrue reachability
 * ==================================================================== */

export async function authHealth(cfg) {
  try {
    const res = await fetch(`${cfg.authUrl}/health`, { headers: { apikey: cfg.anonKey } })
    return { ok: res.ok, status: res.status, message: res.ok ? null : `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, status: 0, message: err?.message ?? String(err) }
  }
}

/** The PostgREST OpenAPI root. Used to prove an RPC is exposed before calling it. */
export async function openApiRoot(cfg, identity) {
  try {
    const res = await fetch(`${cfg.restUrl}/`, {
      headers: { ...identity.headers, accept: 'application/openapi+json, application/json' },
    })
    if (!res.ok) return { ok: false, paths: [], message: `HTTP ${res.status}` }
    const doc = await res.json()
    return { ok: true, paths: Object.keys(doc?.paths ?? {}), message: null }
  } catch (err) {
    return { ok: false, paths: [], message: err?.message ?? String(err) }
  }
}

/* ==================================================================== *
 * The v_inventory oracle
 * ==================================================================== */

/**
 * 0012_grants.sql line 13 revokes table privileges from `anon` and `authenticated` ONLY, and
 * line 27 grants SELECT on v_inventory to `authenticated` only. `service_role` is neither
 * granted explicitly nor revoked, so whether it can read the view depends on the platform's
 * default privileges rather than on anything in this repository.
 *
 * Rather than assume either way: probe, and fall back to the admin session. The chosen
 * oracle is PRINTED in the run banner, because which one answered changes nothing about the
 * assertions but everything about reproducing them.
 */
export async function resolveInventoryOracle(cfg, identities) {
  const probe = await selectRows(cfg, identities.service, 'v_inventory', 'select=sku&limit=1')
  if (probe.ok) {
    return {
      identity: identities.service,
      label: 'service_role (Supabase default privileges on v_inventory are in force)',
    }
  }
  if (!identities.admin) {
    return {
      identity: null,
      label: `unavailable — service_role was refused (${probe.code}: ${probe.message}) and no admin session exists`,
      error: probe,
    }
  }
  const fallback = await selectRows(cfg, identities.admin, 'v_inventory', 'select=sku&limit=1')
  if (fallback.ok) {
    return {
      identity: identities.admin,
      label: `admin session (service_role was refused: ${probe.code} — 0012 grants SELECT on v_inventory to authenticated only)`,
    }
  }
  return {
    identity: null,
    label: `unavailable — service_role refused (${probe.code}) and admin refused (${fallback.code})`,
    error: fallback,
  }
}

/** Reads one v_inventory row through whichever oracle was resolved. */
export async function inventoryRow(cfg, oracle, sku, location) {
  if (!oracle?.identity) return null
  const res = await selectRows(
    cfg,
    oracle.identity,
    'v_inventory',
    `select=*&sku=eq.${encodeURIComponent(sku)}&location=eq.${encodeURIComponent(location)}`,
  )
  return res.ok ? (res.rows[0] ?? null) : null
}

/* ==================================================================== *
 * HTTP against the application under test
 * ==================================================================== */

/**
 * A request to the running Next.js app.
 *
 * `redirect: 'manual'` is deliberate and load-bearing. `middleware.ts` matches /api/* and
 * redirects an unauthenticated request to /login before the route handler is reached; with
 * the default redirect-following that surfaces as whatever /login answers, which would be
 * read as a broken assertion rather than as the refusal it is.
 */
export async function appFetch(baseUrl, path, { method = 'POST', cookie, body } = {}) {
  const headers = {}
  if (cookie) headers.cookie = cookie
  if (body !== undefined) headers['content-type'] = 'application/json'

  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      redirect: 'manual',
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const parsed = await jsonOrNull(res)
    return {
      ok: true,
      status: res.status,
      location: res.headers.get('location'),
      body: parsed ?? {},
      error: null,
    }
  } catch (err) {
    return { ok: false, status: 0, location: null, body: {}, error: err?.message ?? String(err) }
  }
}

/**
 * A request carrying NO cookie header at all — constructed from a bare fetch with no
 * headers object inherited from anywhere. Deleting a key from a shared object is not the
 * same thing and is exactly how this assertion gets silently weakened.
 */
export async function appFetchNoSession(baseUrl, path, { method = 'POST' } = {}) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, { method, redirect: 'manual' })
    const parsed = await jsonOrNull(res)
    return {
      ok: true,
      status: res.status,
      location: res.headers.get('location'),
      body: parsed ?? {},
      error: null,
    }
  } catch (err) {
    return { ok: false, status: 0, location: null, body: {}, error: err?.message ?? String(err) }
  }
}

/** True when a response is the middleware's unauthenticated redirect to /login. */
export function isLoginRedirect(res) {
  if (!res || res.status < 300 || res.status >= 400) return false
  const loc = res.location ?? ''
  try {
    return new URL(loc, 'http://placeholder.invalid').pathname === '/login'
  } catch {
    return loc.includes('/login')
  }
}
