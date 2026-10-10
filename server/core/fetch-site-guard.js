/**
 * RaPiSys — cross-site request guard for /api
 * -------------------------------------------
 * The session cookie is SameSite=Lax, so a browser still attaches it to a
 * top-level GET navigation started by another site. Several privileged actions
 * run as GET event streams (apt upgrade, package remove, Pi-hole install, ...),
 * so a link on any page could start them for a signed-in admin.
 *
 * Browsers label every request with Sec-Fetch-Site. Only requests the
 * dashboard itself makes ('same-origin') or the user started by typing a URL
 * or opening a bookmark ('none') reach /api. 'same-site' is refused too: other
 * apps on the same Pi (another port) share the site and the cookie.
 *
 * Requests without the header (curl, scripts, peer nodes, the Docker
 * healthcheck) are not browsers acting for a user and pass through to the
 * normal auth checks. Origins listed in CORS_ORIGINS (e.g. the Vite dev
 * server) stay allowed; '*' does not count as listing them.
 */
export function createFetchSiteGuard({ allowedOrigins = [] } = {}) {
  const allowed = new Set(allowedOrigins.filter((o) => o && o !== '*'));
  return function fetchSiteGuard(req, res, next) {
    const site = req.headers['sec-fetch-site'];
    if (!site || site === 'same-origin' || site === 'none') return next();
    if (req.headers.origin && allowed.has(req.headers.origin)) return next();
    const p = req.path || '';
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/api/health' || p.startsWith('/api/health/'))) {
      return next();
    }
    return res.status(403).json({ error: 'Cross-site request refused. Open the dashboard directly.', auth: 'cross-site' });
  };
}
