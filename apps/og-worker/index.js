// afr-og — static asset worker for per-site Open Graph cards.
// The card PNGs are build artifacts (scripts/make-og-cards.mjs writes them to
// apps/web/public/og/sites and sync-site copies them into ./assets here).
// Every request is served by the assets binding: cache headers come from the
// generated _headers file, and no dynamic code runs per request.
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
