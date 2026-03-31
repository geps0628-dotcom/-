// ==UserScript==
// @name         AutoDL 实例运行计时器
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  AutoDL 容器实例启动后自动显示运行时长
// @author       GPS
// @match        https://www.autodl.com/console/instance/list
// @match        https://www.autodl.com/console/instance/list/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        STORAGE_PREFIX: 'autodl_timer_start_',
        SCAN_DEBOUNCE_MS: 800,
        UPDATE_INTERVAL_MS: 1000,
        RUNNING_RE: /(运行中|已启动|running|started)/i,
        STOPPED_RE: /(已停止|停止|关机|已关机|stopped|shutdown|已释放|释放中)/i,
        ROW_SELECTORS: [
            'tr',
            '.ant-table-row',
            '.el-table__row',
            '.ant-card',
            '.el-card',
            '[class*="instance"]',
            '[class*="machine"]',
            '[class*="container"]'
        ].join(','),
        STATUS_SELECTORS: [
            '[class*="status"]',
            '[class*="tag"]',
            '[class*="badge"]',
            '.ant-tag',
            '.el-tag'
        ].join(','),
        BADGE_CLASS: 'autodl-lite-runtime-badge',
        DEBUG: false
    };

    const tracked = new Map(); // instanceId -> { el, badge }
    let scanTimer = null;
    let observer = null;

    function log(...args) {
        if (CONFIG.DEBUG) console.log('[AutoDL Timer Lite]', ...args);
    }

    function now() {
        return Date.now();
    }

    function formatDuration(ms) {
        if (!ms || ms < 0) ms = 0;
        const total = Math.floor(ms / 1000);
        const h = String(Math.floor(total / 3600)).padStart(2, '0');
        const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
        const s = String(total % 60).padStart(2, '0');
        return `${h}:${m}:${s}`;
    }

    function storageKey(id) {
        return CONFIG.STORAGE_PREFIX + id;
    }

    function getStartTime(id) {
        const v = localStorage.getItem(storageKey(id));
        return v ? Number(v) : null;
    }

    function setStartTime(id, ts) {
        localStorage.setItem(storageKey(id), String(ts));
    }

    function clearStartTime(id) {
        localStorage.removeItem(storageKey(id));
    }

    function isElementVisible(el) {
        return !!(el && el.isConnected && el.getClientRects().length);
    }

    function safeText(el) {
        return (el?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function getInstanceRows() {
        const rows = Array.from(document.querySelectorAll(CONFIG.ROW_SELECTORS));
        return rows.filter(el => {
            if (!isElementVisible(el)) return false;
            const txt = safeText(el);
            if (!txt || txt.length < 4) return false;
            return /实例|容器|机器|GPU|状态|运行|instance|container|machine/i.test(txt)
                || CONFIG.RUNNING_RE.test(txt)
                || CONFIG.STOPPED_RE.test(txt);
        });
    }

    function getInstanceId(row, index) {
        const attrs = ['data-row-key', 'data-id', 'data-key', 'data-instance-id'];
        for (const name of attrs) {
            const v = row.getAttribute(name);
            if (v) return `id:${v}`;
        }

        const link = row.querySelector('a[href*="instance"],a[href*="container"],a[href*="machine"],a[href*="detail"]');
        if (link) {
            const href = link.getAttribute('href') || '';
            const m = href.match(/([A-Za-z0-9_-]{6,})/);
            if (m) return `link:${m[1]}`;
        }

        const firstCells = row.querySelectorAll('td,th,strong,[class*="title"],[class*="name"]');
        for (const el of firstCells) {
            const txt = safeText(el);
            if (txt && txt.length <= 60) return `text:${txt}`;
        }

        return `idx:${index}:${safeText(row).slice(0, 50)}`;
    }

    function getStatusText(row) {
        const statusNodes = row.querySelectorAll(CONFIG.STATUS_SELECTORS);
        for (const el of statusNodes) {
            const txt = safeText(el);
            if (txt && txt.length <= 20 && (CONFIG.RUNNING_RE.test(txt) || CONFIG.STOPPED_RE.test(txt))) {
                return txt;
            }
        }

        const rowText = safeText(row);
        const m1 = rowText.match(CONFIG.RUNNING_RE);
        if (m1) return m1[0];
        const m2 = rowText.match(CONFIG.STOPPED_RE);
        if (m2) return m2[0];

        return '';
    }

    function getStatusType(row) {
        const txt = getStatusText(row);
        if (CONFIG.RUNNING_RE.test(txt)) return 'running';
        if (CONFIG.STOPPED_RE.test(txt)) return 'stopped';
        return 'unknown';
    }

    function getMountPoint(row) {
        const statusNode = row.querySelector(CONFIG.STATUS_SELECTORS);
        if (statusNode) return statusNode;

        const titleNode = row.querySelector('td,th,strong,[class*="title"],[class*="name"]');
        return titleNode || row;
    }

    function createBadge() {
        const span = document.createElement('span');
        span.className = CONFIG.BADGE_CLASS;
        span.style.cssText = [
            'display:inline-flex',
            'align-items:center',
            'margin-left:8px',
            'padding:2px 8px',
            'border-radius:999px',
            'font-size:12px',
            'line-height:18px',
            'font-weight:600',
            'color:#fff',
            'background:#16a34a',
            'white-space:nowrap'
        ].join(';');
        span.textContent = '已运行 00:00:00';
        return span;
    }

    function ensureBadge(row) {
        let badge = row.querySelector('.' + CONFIG.BADGE_CLASS);
        if (badge) return badge;

        badge = createBadge();
        const mount = getMountPoint(row);

        if (mount && mount !== row) {
            mount.insertAdjacentElement('afterend', badge);
        } else {
            row.appendChild(badge);
        }

        return badge;
    }

    function removeBadge(row) {
        const badge = row.querySelector('.' + CONFIG.BADGE_CLASS);
        if (badge) badge.remove();
    }

    function handleRow(row, index) {
        const id = getInstanceId(row, index);
        const status = getStatusType(row);

        row.dataset.autodlTimerId = id;
        row.dataset.autodlTimerStatus = status;

        if (status === 'running') {
            let start = getStartTime(id);
            if (!start) {
                start = now();
                setStartTime(id, start);
            }
            const badge = ensureBadge(row);
            tracked.set(id, { el: row, badge });
            badge.textContent = '已运行 ' + formatDuration(now() - start);
            return;
        }

        if (status === 'stopped') {
            clearStartTime(id);
            removeBadge(row);
            tracked.delete(id);
            return;
        }

        const start = getStartTime(id);
        if (start) {
            const badge = ensureBadge(row);
            tracked.set(id, { el: row, badge });
            badge.textContent = '已运行 ' + formatDuration(now() - start);
        } else {
            removeBadge(row);
            tracked.delete(id);
        }
    }

    function fullScan() {
        const rows = getInstanceRows();
        const aliveIds = new Set();

        rows.forEach((row, index) => {
            try {
                handleRow(row, index);
                if (row.dataset.autodlTimerId) aliveIds.add(row.dataset.autodlTimerId);
            } catch (e) {
                log('handleRow error', e);
            }
        });

        for (const [id, item] of tracked.entries()) {
            if (!aliveIds.has(id) || !item.el.isConnected) {
                tracked.delete(id);
            }
        }
    }

    function scheduleScan() {
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = setTimeout(fullScan, CONFIG.SCAN_DEBOUNCE_MS);
    }

    function startObserver() {
        observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
                    scheduleScan();
                    return;
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function startTicker() {
        setInterval(() => {
            for (const [id, item] of tracked.entries()) {
                if (!item.el.isConnected) {
                    tracked.delete(id);
                    continue;
                }

                const start = getStartTime(id);
                if (!start) {
                    tracked.delete(id);
                    removeBadge(item.el);
                    continue;
                }

                if (!item.badge || !item.badge.isConnected) {
                    item.badge = ensureBadge(item.el);
                }

                item.badge.textContent = '已运行 ' + formatDuration(now() - start);
            }
        }, CONFIG.UPDATE_INTERVAL_MS);
    }

    function init() {
        fullScan();
        startObserver();
        startTicker();
        log('initialized');
    }

    window.addEventListener('load', () => {
        setTimeout(init, 1000);
    });
})();
