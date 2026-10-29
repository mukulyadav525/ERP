// A production build without the API address bakes "http://localhost:4000" into
// every page, and every browser then fails to reach the server. On a hosting
// platform (Railway, CI) that stops the build; locally it is a loud warning.
if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_API_URL) {
  const message = 'NEXT_PUBLIC_API_URL is not set: this build will call http://localhost:4000. Set it to the API address as the browser sees it.';
  if (process.env.RAILWAY_ENVIRONMENT || process.env.CI || process.env.VERCEL) throw new Error(message);
  console.warn(`\n⚠  ${message}\n`);
}

const withPWA = require('next-pwa')({
  dest: 'public',
  register: true,
  skipWaiting: true,
  // next-pwa reloads the whole page when the connection returns by default. On the
  // counter that would throw away a bill being typed. Sales queued offline upload
  // in place instead (the billing screen listens for 'online' and drains its queue).
  reloadOnOnline: false,
  // Next 15 lists manifests that are only ever served on demand (never on disk at
  // the URL the worker would precache), so precaching them 404s on every load.
  buildExcludes: [/dynamic-css-manifest\.json$/, /middleware-manifest\.json$/, /app-build-manifest\.json$/],
  disable: process.env.NODE_ENV === 'development',
});

// Section 3.5 — offline resilience.
//
// The service worker caches the app shell so the billing screen still loads with
// no connection. The half that matters more is application code, not the worker:
// a sale that cannot reach the server is written to a local queue with its own
// client_txn_id and replayed on reconnect (see the POS screen in
// pages/billing/index.tsx). Because the server treats that id as idempotent, a
// retry can never bill the customer twice.
module.exports = withPWA({
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        // Lets the Google sign-in popup talk back to this page.
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
      ],
    }];
  },
});
