/* The drill-down metric vocabulary, fetched from the server (QA-8).
 *
 * The ids and their wording live in includes/reporting/metrics.php and are
 * served by api/filters.php, so the client keeps no second copy. The catalog
 * is fetched at most once per session (the filter bar asks for the same
 * endpoint — departments — so this is usually free) and the raw metric id is
 * the fallback until it lands or if the request fails.
 */
import { api } from './api.js';
import { useEffect, useState } from './react.js';

let cached = null;
let inFlight = null;

/* id -> {label, title}; resolves to {} when the endpoint is unavailable. */
const loadMetricCatalog = () => {
  if (cached) return Promise.resolve(cached);

  if (!inFlight) {
    inFlight = api('filters')
      .then(r => {
        const metrics =
          r && typeof r.metrics === 'object' && r.metrics
            ? r.metrics
            : {};

        if (Object.keys(metrics).length) cached = metrics;

        return metrics;
      })
      .catch(() => ({}))
      .finally(() => {
        /* Failed or not, the next caller may try again. */
        inFlight = null;
      });
  }

  return inFlight;
};

/* Server catalog, or {} while it is in flight. */
const useMetricCatalog = () => {
  const [catalog, setCatalog] = useState(cached || {});

  useEffect(() => {
    let active = true;

    if (!cached) {
      loadMetricCatalog().then(metrics => {
        if (active && metrics && Object.keys(metrics).length) setCatalog(metrics);
      });
    }

    return () => {
      active = false;
    };
  }, []);

  return catalog;
};

export { loadMetricCatalog, useMetricCatalog };
