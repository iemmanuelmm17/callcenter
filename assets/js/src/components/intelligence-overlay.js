import { h, useEffect, useRef } from '../lib/react.js';

/* Shared accessible overlay for the watch drawer and topic browser. */
function IntelligenceOverlay({ title, onClose, drawer, children }) {
    const panel = useRef(null);
    const close = useRef(onClose);
    close.current = onClose;
    useEffect(() => {
        const previous = document.activeElement;
        const node = panel.current;
        const focusable = () => [...node.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]')];
        (focusable()[0] || node).focus();
        const handle = e => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); }
            if (e.key === 'Tab') {
                const items = focusable();
                if (!items.length) { e.preventDefault(); node.focus(); return; }
                const first = items[0], last = items[items.length - 1];
                if (e.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
            }
        };
        document.addEventListener('keydown', handle);
        return () => { document.removeEventListener('keydown', handle); if (previous && previous.isConnected) previous.focus(); };
    }, []);
    return ReactDOM.createPortal(h('div', { className: 'intel-overlay cursor-pointer' + (drawer ? ' is-drawer' : ''), onClick: onClose, role: 'presentation' },
        h('div', { className: 'intel-overlay-panel cursor-default', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabIndex: -1, ref: panel, onClick: e => e.stopPropagation() },
            h('div', { className: 'intel-overlay-head' }, h('h2', null, title),
                h('button', { type: 'button', className: 'intel-icon-btn', 'aria-label': 'Close ' + title, onClick: onClose }, '×')),
            h('div', { className: 'intel-overlay-body' }, children))), document.body);
}
export { IntelligenceOverlay };
