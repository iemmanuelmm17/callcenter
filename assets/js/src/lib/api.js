/* Endpoint calls, auth-expiry handling and the role → route policy.
 *
 * Was part of the single-file assets/js/src/app.js; split out by
 * tools/split-js-file.mjs. The body below is byte-identical to the
 * original source — the move is verified by declaration hash. */

import { applyServerTimezone, rangeDateTimes } from './time.js';

let authExpiredHandler = null;

let authExpiredBusy = false;

const handleAuthExpired = () => {
    if (authExpiredBusy) return;
    authExpiredBusy = true;
    fetch('api/logout.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }).catch(() => {}).finally(() => {
      try {
        if (typeof authExpiredHandler === 'function') authExpiredHandler();
      } finally {
        authExpiredBusy = false;
      }
    });
  };

/*
 * App has to install (and remove) the callback that runs when a request comes
 * back 401. ES modules cannot assign to an imported binding, so the one
 * cross-module writer goes through this setter instead.
 */
const setAuthExpiredHandler = handler => {
    authExpiredHandler = handler;
  };

const ROLE_ROUTES = {
    office_manager: ['dashboard', 'agents', 'queues', 'telephone_numbers', 'attendants', 'call_history', 'reports', 'intelligence'],
    supervisor: ['dashboard', 'agents', 'queues', 'call_history', 'reports'],
    agent: ['dashboard'],
    basic_user: ['dashboard']
  };

const routesForRole = role => ROLE_ROUTES[role] || ROLE_ROUTES.basic_user;

const api = async (path, body = null) => {

    const response = await fetch(
        `api/${path}.php`,
        {
            method: body ? 'POST' : 'GET',

            headers: body
                ? {
                    'Content-Type': 'application/json'
                }
                : {},

            body: body
                ? JSON.stringify(apiBody(body))
                : undefined
        }
    );

    const raw = await response.text();

    let json;

    try {

        json = JSON.parse(raw);

    } catch (e) {

        throw new Error(
            `Server returned invalid JSON.`
        );
    }

    if (response.status === 401 && path !== 'login' && path !== 'logout') {
        handleAuthExpired();
        throw Object.assign(new Error('Authentication required'), { status: 401 });
    }

    if (!response.ok) {

        const errText =
            (typeof json.error === 'string' && json.error) ||
            (json.error && typeof json.error === 'object' && json.error.message) ||
            json.message ||
            ('Request failed (' + response.status + ')');

        throw Object.assign(
            new Error(String(errText)),
            {
                status: response.status
            }
        );

    }

    /*
     * The desk's clock travels with the data (review, finding C7): every report
     * payload says which timezone its day boundaries were cut in, and the client
     * adopts it, so a tenant that moved from New York to Manila stops being
     * shown yesterday's numbers at 09:00 local. An endpoint that does not answer
     * a question about time says nothing, and changes nothing.
     *
     * It happens here rather than in each screen because this is the one place a
     * response can be seen: a screen that forgot to re-apply the zone would
     * otherwise drift back to the browser's clock one click later.
     */
    if (json && typeof json.timezone === 'string') applyServerTimezone(json.timezone);

    if (
        json &&
        json.success === true &&
        json.data !== undefined
    ) {
        return json.data;
    }

    return json;
};

const apiBody = body => (body && body.start && body.end)
    ? { ...body, ...rangeDateTimes(body.start, body.end) }
    : body;

const apiDownload = async (path, body, fallbackName) => {

    const response = await fetch('api/' + path + '.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(apiBody(body) || {})
    });

    if (response.status === 401) {
      handleAuthExpired();
      throw Object.assign(new Error('Authentication required'), { status: 401 });
    }

    if (!response.ok) {
      throw Object.assign(new Error('Export failed (' + response.status + ')'), { status: response.status });
    }

    const disposition = response.headers.get('Content-Disposition') || '';
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    const name = (match && match[1]) || fallbackName || 'export.csv';

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(url);
  };

export { api, apiDownload, authExpiredHandler, routesForRole, setAuthExpiredHandler };
