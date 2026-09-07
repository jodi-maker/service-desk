// Runtime API-base selection. No bundler/build step, so we pick the API host at
// runtime by hostname. Loaded as a CLASSIC script (not a module) in the <head>
// of both index.html (agent SPA) and portal.html (public portal), BEFORE the
// app entry, so window.RESPOVIA_API_BASE is set before anything reads it.
//
// Extracted from the pages' formerly-inline <script> blocks so the SPA can ship
// a strict Content-Security-Policy (script-src 'self', no 'unsafe-inline').
//
// Known prod/staging hosts point at their deployed API; Vercel PR previews
// (branch/hashed hostnames under this team's *.vercel.app namespace) point at
// the STAGING API so features are verifiable from the preview link — never at
// production. Anything else (localhost dev, unknown hosts) leaves the value
// unset, so each page's `window.RESPOVIA_API_BASE || 'http://localhost:3001'`
// fallback still applies. A workspace self-hosting the portal under its own
// domain may set the global before this runs — the guard below won't clobber it.
//
// KEEP IN SYNC: every API host mapped below must also appear in the connect-src
// of the Content-Security-Policy in BOTH web/vercel.json and web/nginx.conf
// (byte-identical duplicates; scripts/header-sync-check.mjs gates drift), or
// the browser CSP will block API calls from that host. (connect-src
// additionally lists api.anthropic.com for the direct-from-browser AI calls
// in js/ai/client.js, and tagline.cipiti.ai for the Tagline What's-New SDK
// in js/tagline-sdk/.)
//
// The same hostname branches also set window.RESPOVIA_ENV
// ('production' | 'staging' | 'dev') — the single client-side environment
// discriminator, currently consumed by js/tagline-sdk/index.js so each
// deployment reports its own environment code to Tagline.
(function () {
  // Back-compat: honor the pre-rename global if a self-hosted page still
  // sets it (documented legacy integration hook).
  if (!window.RESPOVIA_API_BASE && window.MAESTRO_API_BASE) {
    window.RESPOVIA_API_BASE = window.MAESTRO_API_BASE;
  }
  if (window.RESPOVIA_API_BASE) return;
  // The staging API also backs every PR-preview SPA (one API deploy per
  // `staging` branch push). KEEP IN SYNC with api/src/lib/env.ts's
  // PREVIEW_SPA_ORIGIN_RE — that server regex must accept exactly the preview
  // hosts this branch captures, or previews get CORS-blocked.
  var STAGING_API = 'https://maestro-desk-zjkl-git-staging-jodi-1420s-projects.vercel.app';
  var h = location.hostname;
  if (/^(app\.|www\.)?respovia\.com$/.test(h)) {
    // Production. app.respovia.com is the ONLY fully working host: the API's
    // CORS/trusted-origin allowlist is APP_BASE_URL alone, so on the apex/www
    // the SPA renders but sign-in is origin-blocked. Those hosts are mapped
    // anyway so they fail toward the real API rather than localhost, but the
    // Vercel 308 redirect apex/www -> app is REQUIRED, not cosmetic.
    window.RESPOVIA_API_BASE = 'https://api.respovia.com';
    window.RESPOVIA_ENV = 'production';
  } else if (/^maestro-desk-git-(?!main-)[a-z0-9-]+-jodi-1420s-projects\.vercel\.app$/.test(h)) {
    // STAGING (`git-staging`) and every PR-preview branch deploy → the staging
    // API + staging DB, never prod. The `git-` marker is REQUIRED and `git-main`
    // excluded so PRODUCTION deployment URLs don't match: Vercel also gives prod
    // a `maestro-desk-<hash>-…` deployment URL and a `git-main` alias, and
    // matching those would silently point production UI at staging. The staging
    // API runs the `staging` branch, so PRs that change API code still need
    // local verification; SPA-only PRs are fully verifiable on the preview link.
    window.RESPOVIA_API_BASE = STAGING_API;
    window.RESPOVIA_ENV = 'staging';
  } else {
    // localhost dev / unknown hosts (the API base is left unset above so the
    // consumers' localhost:3001 fallback applies).
    window.RESPOVIA_ENV = 'dev';
  }
})();
