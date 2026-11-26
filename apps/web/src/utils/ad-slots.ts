import {
  adClickUrl, adImpressionKey, adReportUrl, fetchActiveAds, postAdImpression, searchAdKey,
  type ActiveAd, type AdSlot,
} from '../data/ads.ts';

const QUERY_DEBOUNCE_MS = 250;
const REFRESH_MS = 30_000;
const EMPTY_REFRESH_MS = 120_000;
const REQUEST_TIMEOUT_MS = 5_000;
const HOUR_MS = 3_600_000;
const MAX_TIMER_MS = 2_147_483_647;

function impressionReporter() {
  const sent = new Set<string>();
  const inFlight = new Set<string>();
  return async (id: number) => {
    const day = new Date().toISOString().slice(0, 10);
    const key = adImpressionKey(id, day);
    if (sent.has(key) || inFlight.has(key)) return;
    try {
      if (localStorage.getItem(key)) return;
    } catch {
      // Storage can be blocked. The per-page set still deduplicates views.
    }

    inFlight.add(key);
    const controller = new AbortController();
    const deadline = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      if (!await postAdImpression(id, controller.signal)) return;
      sent.add(key);
      localStorage.setItem(key, '1');
    } catch {
      // A failed request is retried on the next visible recheck or entry.
    } finally {
      window.clearTimeout(deadline);
      inFlight.delete(key);
    }
  };
}

function renderRow(source: HTMLElement, ad: ActiveAd, root: HTMLElement): HTMLElement {
  const row = source.cloneNode(true) as HTMLElement;
  const locale = root.dataset.adLocale === 'zh-CN' ? 'zh-CN' : 'en';
  function text(selector: string, value: string) {
    const element = row.querySelector(selector);
    if (element) element.textContent = value;
  }
  row.dataset.adId = String(ad.id);
  text('[data-ad-domain]', ad.domain);
  text('[data-ad-headline]', ad.headline);
  text('[data-ad-body]', ad.body);
  row.querySelector('[data-ad-visit]')?.setAttribute('href', adClickUrl(ad.id));
  row.querySelector('[data-ad-report]')?.setAttribute('href', adReportUrl(ad.id, locale));
  const ring = row.querySelector<HTMLElement>('.ring');
  if (ring) {
    ring.dataset.grade = ad.grade;
    ring.setAttribute('aria-label', `${root.dataset.adGradeLabel} ${ad.grade}, ${root.dataset.adScoreLabel} ${ad.score}/100`);
    ring.style.setProperty('--pct', `${ad.score}%`);
    ring.querySelector<HTMLElement>('.ring-fill')?.style.setProperty('--sweep', `${ad.score}%`);
    text('.ring-letter', ad.grade);
    text('.ring-score', String(ad.score));
  }
  return row;
}

interface DisplayedAd {
  ad: ActiveAd;
  element: HTMLElement;
  inView: boolean;
}

function sameAd(a: ActiveAd, b: ActiveAd): boolean {
  return a.id === b.id && a.domain === b.domain && a.endsAt === b.endsAt && a.startsAt === b.startsAt &&
    a.headline === b.headline && a.body === b.body && a.grade === b.grade && a.score === b.score;
}

function mountSlot(root: HTMLElement, report: (id: number) => Promise<void>) {
  const slot = root.dataset.adSlot as AdSlot;
  const placementBody = root.querySelector<HTMLElement>('[data-ad-items]');
  const rowTemplate = placementBody?.firstElementChild;
  if (!placementBody || !rowTemplate) return;
  const outlet = placementBody;
  const source = rowTemplate.cloneNode(true) as HTMLElement;
  // The page's GradeRing module is already scheduled. Clones only need markup.
  for (const script of source.querySelectorAll('script')) script.remove();
  outlet.replaceChildren();
  const searchInput = slot === 'search-top'
    ? document.querySelector<HTMLInputElement>('[data-ad-search]') : null;
  if (slot === 'search-top' && !searchInput) return;

  let key = slot === 'category-top' ? root.dataset.adKey : undefined;
  let composing = false;
  let pageHidden = false;
  let request: AbortController | undefined;
  let refreshTimer: number | undefined;
  let expiryTimer: number | undefined;
  let rows: DisplayedAd[] = [];

  const canLoad = () => !pageHidden && document.visibilityState === 'visible' && navigator.onLine &&
    (slot === 'home-supporter' || Boolean(key));

  function countIfVisible(row: DisplayedAd) {
    if (row.inView && canLoad() && row.element.isConnected && !row.element.closest('[hidden]') && Date.now() < row.ad.endsAt) {
      void report(row.ad.id);
    }
  }

  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    for (const { target, isIntersecting, intersectionRatio } of entries) {
      const row = rows.find(({ element }) => element === target);
      if (!row) continue; // A callback queued before the placement was replaced.
      row.inView = isIntersecting && intersectionRatio > 0;
      countIfVisible(row);
    }
  }, { threshold: [0, 0.01] }) : undefined;

  function repaint(ads: ActiveAd[]) {
    // Keep links and the observer in place during periodic refreshes when
    // the creative is unchanged (including while a link has keyboard focus).
    if (rows.length !== ads.length || rows.some(({ ad }, i) => !sameAd(ad, ads[i]!))) {
      for (const { element } of rows) observer?.unobserve(element);
      rows = ads.map((ad) => ({ ad, element: renderRow(source, ad, root), inView: false }));
      outlet.replaceChildren(...rows.map(({ element }) => element));
      root.hidden = !rows.length;
      for (const { element } of rows) observer?.observe(element);
    }

    window.clearTimeout(expiryTimer);
    if (!rows.length) return;
    const currentHour = Math.floor(Date.now() / HOUR_MS);
    const end = Math.min(...rows.map(({ ad }) => ad.endsAt));
    const cutoff = slot === 'category-top' ? Math.min(end, (currentHour + 1) * HOUR_MS) : end;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, cutoff - Date.now()));
    expiryTimer = window.setTimeout(() => {
      const now = Date.now();
      const rotated = slot === 'category-top' && Math.floor(now / HOUR_MS) !== currentHour;
      const live = rotated ? [] : rows.filter(({ ad }) => ad.endsAt > now).map(({ ad }) => ad);
      const changed = live.length !== rows.length;
      repaint(live);
      if (changed) void refresh();
    }, delay);

    // The observer only emits when visibility changes. This also allows a
    // failed ping to retry and a continuously viewed ad to count on a new day.
    for (const row of rows) countIfVisible(row);
  }

  function clear() {
    window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
    request?.abort();
    request = undefined;
    repaint([]);
  }

  async function refresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = undefined;
    if (!canLoad() || request) return;
    const controller = new AbortController();
    const startedAt = Date.now();
    request = controller;
    const deadline = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const ads = await fetchActiveAds(slot, key, controller.signal);
      const now = Date.now();
      if (request === controller && canLoad()) {
        // Fail closed if the request timed out or crossed the rotation boundary.
        const stale = controller.signal.aborted || (slot === 'category-top' &&
          Math.floor(startedAt / HOUR_MS) !== Math.floor(now / HOUR_MS));
        repaint(stale ? [] : ads.filter((ad) => ad.startsAt <= now && now < ad.endsAt));
      }
    } catch {
      if (request === controller) repaint([]);
    } finally {
      window.clearTimeout(deadline);
      if (request === controller) {
        request = undefined;
        if (canLoad()) {
          // Empty slots poll less often to avoid spending the API budget on idle tabs.
          const next = startedAt + (rows.length ? REFRESH_MS : EMPTY_REFRESH_MS);
          const nextHour = (Math.floor(startedAt / HOUR_MS) + 1) * HOUR_MS;
          const due = slot === 'category-top' ? Math.min(next, nextHour) : next;
          refreshTimer = window.setTimeout(refresh, Math.max(0, due - Date.now()));
        }
      }
    }
  }

  function wake() {
    if (canLoad() && !request && refreshTimer === undefined) void refresh();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wake();
    else clear();
  });
  window.addEventListener('pagehide', () => {
    pageHidden = true;
    clear();
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    pageHidden = false;
    wake();
  });
  window.addEventListener('offline', clear);
  window.addEventListener('online', wake);

  if (searchInput) {
    function queueQuery(value: string) {
      const next = searchAdKey(value);
      if (next === key) return;
      clear();
      key = next;
      if (canLoad()) refreshTimer = window.setTimeout(refresh, QUERY_DEBOUNCE_MS);
    }
    searchInput.addEventListener('compositionstart', () => {
      composing = true;
      queueQuery('');
    });
    searchInput.addEventListener('compositionend', () => {
      composing = false;
      queueQuery(searchInput.value);
    });
    searchInput.addEventListener('input', (event) => {
      if (!composing && !(event as InputEvent).isComposing) queueQuery(searchInput.value);
    });
    searchInput.form?.addEventListener('submit', () => {
      if (!composing) queueQuery(searchInput.value);
    });
    queueQuery(new URLSearchParams(location.search).get('q') ?? '');
  } else {
    wake();
  }
}

export function startAdSlots() {
  const report = impressionReporter();
  for (const root of document.querySelectorAll<HTMLElement>('[data-ad-slot]')) mountSlot(root, report);
}
