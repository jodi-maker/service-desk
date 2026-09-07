// Generic API client for the Respovia backend.
//
// Wraps fetch() with:
//   - automatic Bearer-token header from sessionStorage
//   - JSON encode/decode on request + response
//   - error normalisation (ApiError with status + body)
//
// API base defaults to http://localhost:3001 for local dev. In production
// (or any other deployment), set `window.RESPOVIA_API_BASE` in index.html
// BEFORE this module is imported, and we'll pick it up.
//
// Token lives in sessionStorage under JWT_KEY — survives a tab refresh,
// gone when the tab closes. Use signOut() in auth-client to clear it.

export const API_BASE          = (typeof window !== 'undefined' && window.RESPOVIA_API_BASE) || 'http://localhost:3001';
export const JWT_KEY           = 'maestro_jwt';
export const WORKSPACE_ID_KEY  = 'maestro_workspace_id';
// Maestro brand context (X-Brand-Id) — the brand the agent picked after a
// Maestro sign-in. Sent only on calls that opt in with { brand: true } (the
// player-lookup endpoints); the platform enforces the agent's brand perms.
export const BRAND_ID_KEY      = 'maestro_brand_id';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function getJwt() {
  return sessionStorage.getItem(JWT_KEY);
}

export function setJwt(jwt) {
  if (jwt) sessionStorage.setItem(JWT_KEY, jwt);
  else     sessionStorage.removeItem(JWT_KEY);
}

export function getWorkspaceId() {
  return sessionStorage.getItem(WORKSPACE_ID_KEY);
}

export function setWorkspaceId(id) {
  if (id) sessionStorage.setItem(WORKSPACE_ID_KEY, id);
  else    sessionStorage.removeItem(WORKSPACE_ID_KEY);
}

export function getBrandId() {
  return sessionStorage.getItem(BRAND_ID_KEY);
}

export function setBrandId(id) {
  if (id) sessionStorage.setItem(BRAND_ID_KEY, id);
  else    sessionStorage.removeItem(BRAND_ID_KEY);
}

/**
 * Low-level call. path is "/api/v1/..."; method defaults to GET; body is
 * JSON-encoded automatically. Throws ApiError on non-2xx.
 *
 * Options:
 *   { auth: false }      — skip the Authorization header (for /config + /health)
 *   { workspace: false } — skip the X-Workspace-Id header (for /whoami + god routes)
 *   { brand: true }      — add the X-Brand-Id header (for Maestro player lookups)
 */
export async function apiCall(path, { method = 'GET', body, auth = true, workspace = true, brand = false, form } = {}) {
  // NOTE: `workspace: true` means "attach the X-Workspace-Id header IF one is
  // active", not "this endpoint requires a workspace" — plenty of default-
  // options callers (god panel, push settings, whoami-class endpoints) are
  // legitimately workspace-less. Don't add a client-side missing-workspace
  // guard here: the server's auth middleware is the authority, and its 400
  // now arrives as a readable JSON {error}.
  // A multipart upload must NOT carry an explicit Content-Type: the browser
  // sets it, including the boundary it generated.
  const headers = form ? {} : { 'Content-Type': 'application/json' };
  if (auth) {
    const jwt = getJwt();
    if (jwt) headers.Authorization = `Bearer ${jwt}`;
  }
  if (workspace) {
    const wsId = getWorkspaceId();
    if (wsId) headers['X-Workspace-Id'] = wsId;
  }
  if (brand) {
    const brandId = getBrandId();
    if (brandId) headers['X-Brand-Id'] = brandId;
  }
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: form ?? (body == null ? undefined : JSON.stringify(body)),
    });
  } catch {
    // fetch() rejects (TypeError "Failed to fetch") when the request never
    // reached a server at all — backend down, wrong API_BASE, offline, or a
    // CORS rejection. The raw message is opaque to users; normalise it to
    // something actionable. status 0 means "no HTTP response", so callers can
    // tell a connectivity failure apart from a 4xx/5xx the server returned.
    throw new ApiError(
      `Can't reach the Respovia server at ${API_BASE}. Check that the API is running and that you're online.`,
      0,
      null,
    );
  }
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; }
  catch { parsed = text; }
  if (!res.ok) {
    // Short plain-text bodies count as a message too — HTTP/2 has no status
    // text, so without this a text-bodied 4xx surfaces as a bare "HTTP 400".
    // Length + no-markup guards keep proxy/CDN HTML error pages out, and the
    // sub-500 gate keeps server-internal 5xx text (old API builds, proxies)
    // from being promoted to user-facing copy.
    const textMsg = (res.status < 500 && typeof parsed === 'string' && parsed.trim() && parsed.length <= 200 && !parsed.includes('<'))
      ? parsed.trim() : '';
    const msg = (parsed && parsed.error) || textMsg || res.statusText || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, parsed);
  }
  return parsed;
}

export const apiGet    = (path, opts)        => apiCall(path, { ...opts, method: 'GET' });
export const apiPost   = (path, body, opts)  => apiCall(path, { ...opts, method: 'POST', body });
export const apiPut    = (path, body, opts)  => apiCall(path, { ...opts, method: 'PUT', body });
export const apiPatch  = (path, body, opts)  => apiCall(path, { ...opts, method: 'PATCH', body });
export const apiDelete = (path, opts)        => apiCall(path, { ...opts, method: 'DELETE' });
/** Multipart upload (attachments). `form` is a FormData; same auth/headers. */
export const apiUpload = (path, form, opts)  => apiCall(path, { ...opts, method: 'POST', form });
