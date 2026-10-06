/* CallScope reporting dashboard — entry point.
 *
 * The application used to live in this one 12,000-line file; it is now
 * assembled from the modules under lib/ and components/. The table of
 * contents is tools/app-modules.json. This file keeps the React root and
 * the two top-level components that mount it. */

import { Dashboard } from './components/app-shell.js';
import { Login } from './components/login.js';
import { api, setAuthExpiredHandler } from './lib/api.js';
import { h, useEffect, useState } from './lib/react.js';

function App(){
    const [user,setUser] = useState(null);
    useEffect(() => {
        setAuthExpiredHandler(() => {
            history.replaceState(null, '', location.pathname);
            setUser(null);
        });
        api('session').then(r => setUser(r.user)).catch(() => {});
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
        : h(Login, { onLogin: r => setUser(r.user) });
}

ReactDOM.createRoot(document.getElementById('root')).render(h(App));
