/* CallScope reporting dashboard — entry point.
 *
 * The application used to live in this one 12,000-line file; it is now
 * assembled from the modules under lib/ (api, time, format, …) and
 * components/ (one file per screen). The map is tools/app-modules.json. This
 * file keeps the React root, `App` and the auth-expiry wiring. */

import { Dashboard } from './components/app-shell.js';
import { Login } from './components/login.js';
import { api, setAuthExpiredHandler } from './lib/api.js';
import { applyServerTimezone } from './lib/time.js';
import { h, useEffect, useState } from './lib/react.js';

/*
 * The desk's timezone, before the first render (review, finding C7).
 *
 * portal.php writes the tenant's setting into a JSON island next to the vendor
 * manifest. Reading it here, while the module graph is still loading, is what
 * makes the default date range ("Today") the tenant's today rather than the
 * browser's or New York's - and every screen that later fetches a report
 * re-asserts the same value through lib/api.js, so a change made in Settings
 * needs no reload.
 */
const bootClock = () => {
    try {
        const node = document.getElementById('app-clock');
        if (!node) return;
        applyServerTimezone(JSON.parse(node.textContent || '{}').timezone);
    } catch (e) {
        /* A missing or malformed island is the pre-C7 behaviour: the deployment
         * default, which is what the server falls back to as well. */
    }
};
bootClock();

function App(){
    const [user,setUser] = useState(null);
    useEffect(() => {
        setAuthExpiredHandler(() => {
            history.replaceState(null, '', location.pathname);
            setUser(null);
        });
        api('session').then(r => {
            /* The island is rendered from the session's domain; a signed-out or
             * hand-edited page gets the seat from the API instead. */
            applyServerTimezone(r && r.timezone);
            setUser(r.user);
        }).catch(() => {});
        return () => { setAuthExpiredHandler(null); };
    }, []);
    const logout = async () => {
        try { await api('logout', {}); }
        finally {
            history.replaceState(null, '', location.pathname);
            setUser(null);
        }
    };
    return user
        ? h(Dashboard, { user, onLogout: logout })
        : h(Login, { onLogin: r => {
            applyServerTimezone(r && r.timezone);
            setUser(r.user);
        } });
}

ReactDOM.createRoot(document.getElementById('root')).render(h(App));
