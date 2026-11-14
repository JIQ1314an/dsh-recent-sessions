/**
 * Browser half of @miloji/dsh-recent-sessions (v2, session-first).
 *
 * Adds a "Recents" panel to the sidebar: a flat list of the sessions the user
 * recently OPENED (most recent first — not by activity), regardless of which
 * workspace they belong to. Each row shows the session title and a chip for
 * its workspace, so the same workspace can contribute several entries. A
 * session that is currently running shows a blinking three-dot waiting
 * indicator in the leading cell.
 *
 * Two parts:
 *  - RecentSessionsPanel: the `main` panel (key `recent-workspaces`).
 *  - SessionTouchRecorder: a renderless component mounted through the
 *    session-scoped `conversation.input.dock` seat; it POSTs a touch whenever
 *    the user opens any session anywhere in the GUI (sidebar, panel, hero),
 *    which is what makes "recently accessed" honest.
 *
 * The visit order is persisted by the Host in
 * `$DSH_HOME/plugins/recent-workspaces/recents.json` over the plugin's own
 * fenced `/dsh-recent-workspaces` route; titles, cwd and running state are
 * read live from the framework hooks, so the list always reflects the current
 * catalog. Stored title/path snapshots are the fallback for sessions that
 * left the catalog.
 */
window.__ModuleLoader__.load({
  id: '@miloji/dsh-recent-sessions',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    const PLUGIN_ID = '@miloji/dsh-recent-sessions';
    const NS = 'recent-workspaces';
    const API = '/dsh-recent-workspaces';
    const PANEL_ID = 'recent-workspaces';
    const RECORDER_ID = PLUGIN_ID + '.touch-recorder';
    const MAX_PANEL_ROWS = 24;
    const SEED_LIMIT = 12;
    const REFRESH_MS = 10000;
    const TOUCH_DEBOUNCE_MS = 400;

    /** Runtime dictionary for the panel. */
    const STRINGS = {
      zh: {
        'panel': '最近访问',
        'panel.title': '最近访问的会话',
        'panel.empty': '还没有最近访问的会话。打开任意会话后，它会自动记录在这里。',
        'panel.clear': '清空记录',
        'panel.clearDone': '已清空最近访问记录',
        'panel.refresh': '刷新',
        'panel.loading': '正在读取…',
        'panel.error': '读取失败：{message}',
        'panel.stale': '⚠ 宿主进程还在运行旧版本插件代码：最近访问已无法正确记录。请完全退出 dsh 后重新启动（命令：dsh web --no-open），然后刷新本页面。',
        'panel.dir': '数据文件：{dir}',
        'workspace.tooltip': '工作区：{path}',
        'session.running': '任务进行中',
        'session.remove': '从最近访问中移除',
        'session.stale': '该会话已不在会话列表',
        'time.justNow': '刚刚',
        'time.minutes': '{n} 分钟前',
        'time.hours': '{n} 小时前',
        'time.days': '{n} 天前',
      },
      en: {
        'panel': 'Recents',
        'panel.title': 'Recently accessed sessions',
        'panel.empty': 'No recent sessions yet. Open any session and it will be recorded here.',
        'panel.clear': 'Clear',
        'panel.clearDone': 'Recent list cleared',
        'panel.refresh': 'Refresh',
        'panel.loading': 'Loading…',
        'panel.error': 'Failed to load: {message}',
        'panel.stale': '⚠ The Host process still runs the previous plugin code, so recent visits are not recorded correctly. Fully quit dsh and start it again (command: dsh web --no-open), then refresh this page.',
        'panel.dir': 'Data file: {dir}',
        'workspace.tooltip': 'Workspace: {path}',
        'session.running': 'Task in progress',
        'session.remove': 'Remove from recents',
        'session.stale': 'This session is no longer in the session list',
        'time.justNow': 'just now',
        'time.minutes': '{n}m ago',
        'time.hours': '{n}h ago',
        'time.days': '{n}d ago',
      },
    };

    /** Panel stylesheet; only `--dsw-alias-*` theme tokens are referenced. */
    const CSS = [
      '.rw-panel{display:flex;flex-direction:column;height:100%;min-height:0}',
      '.rw-header{padding:16px 16px 8px}',
      '.rw-title{margin:0;font-size:16px;line-height:24px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.rw-toolbar{display:flex;gap:8px;align-items:center;margin-top:10px}',
      '.rw-button{height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.rw-button:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.rw-list{flex:1;overflow-y:auto;padding:4px 8px 16px;list-style:none;margin:0}',
      '.rw-row{position:relative;display:flex;align-items:center;margin:2px 0;border-radius:8px}',
      '.rw-row:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.rw-session{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:7px 8px;background:none;border:none;cursor:pointer;color:inherit;font:inherit;text-align:left}',
      '.rw-leading{flex:none;width:14px;height:14px;display:flex;align-items:center;justify-content:center}',
      '.rw-dot{width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.rw-dots{display:flex;gap:2px;align-items:center}',
      '.rw-dots span{width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);animation:rw-blink 1.2s infinite ease-in-out}',
      '.rw-dots span:nth-child(2){animation-delay:.2s}',
      '.rw-dots span:nth-child(3){animation-delay:.4s}',
      '@keyframes rw-blink{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}',
      '.rw-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.rw-sessionTitle{display:block;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.rw-session.stale .rw-sessionTitle{color:var(--dsw-alias-label-secondary)}',
      '.rw-workspaceChip{align-self:flex-start;display:inline-flex;align-items:center;gap:4px;max-width:100%;height:16px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font-size:10px;line-height:14px;color:var(--dsw-alias-label-secondary)}',
      '.rw-workspaceChip svg{flex:none}',
      '.rw-workspaceChipLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.rw-time{flex:none;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);padding-right:4px}',
      '.rw-remove{flex:none;width:22px;height:22px;margin-right:4px;border-radius:6px;border:none;background:none;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer;opacity:0}',
      '.rw-row:hover .rw-remove,.rw-remove:focus-visible{opacity:1}',
      '.rw-remove:hover{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}',
      '.rw-empty{padding:32px 20px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
      '.rw-empty-stale{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;margin:8px}',
      '.rw-footer{padding:8px 16px;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
    ].join('\n');

    /**
     * Install the panel stylesheet as one marked <style> tag so an unload or
     * HMR pass can find and remove exactly this tag.
     * @returns cleanup that removes the tag.
     */
    function installCss() {
      if (typeof document === 'undefined') return () => {};
      const id = PLUGIN_ID + '/style.css';
      const existing = document.getElementById(id);
      if (existing !== null) return () => { existing.remove(); };
      const tag = document.createElement('style');
      tag.id = id;
      tag.dataset.pluginCss = PLUGIN_ID + '/style.css';
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => { tag.remove(); };
    }

    /**
     * Call the plugin's fenced JSON API.
     * @param path - route path below the plugin prefix.
     * @param options - fetch options.
     * @returns the parsed JSON body.
     */
    async function api(path, options) {
      const res = await fetch(API + path, options);
      let data = null;
      try { data = await res.json(); }
      catch { /* non-JSON reply */ }
      if (!res.ok || data === null || data.ok === false) {
        throw new Error(data?.error ?? ('HTTP ' + res.status));
      }
      return data;
    }

    /** POST a JSON body to the plugin API. */
    function post(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    /** Last path segment of a workspace path, for display. */
    function basename(value) {
      const normalized = String(value).replace(/[\\/]+$/, '');
      const idx = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
      return idx >= 0 ? normalized.slice(idx + 1) : normalized;
    }

    /** Relative time label for a Unix-epoch-millisecond timestamp. */
    function formatRelative(timestamp, now, t) {
      if (!timestamp) return '';
      const diff = Math.max(0, now - timestamp);
      const minute = 60 * 1000;
      const hour = 60 * minute;
      const day = 24 * hour;
      if (diff < minute) return t('time.justNow');
      if (diff < hour) return t('time.minutes', { n: Math.floor(diff / minute) });
      if (diff < day) return t('time.hours', { n: Math.floor(diff / hour) });
      return t('time.days', { n: Math.floor(diff / day) });
    }

    /** Clock glyph used as the sidebar panel icon. */
    function RecentSessionsIcon({ size = 20 }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 20 20',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block' },
      },
        h('circle', { cx: 10, cy: 10, r: 7.4, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', {
          d: 'M10 6.2V10l2.8 1.9',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }));
    }

    /** Small folder glyph inside the workspace chip. */
    function chipFolderIcon() {
      return h('svg', {
        width: 10,
        height: 10,
        viewBox: '0 0 20 20',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block' },
      },
        h('path', {
          fill: 'currentColor',
          d: 'M2 5.5A1.5 1.5 0 0 1 3.5 4h3.879a1.5 1.5 0 0 1 1.06.44L9.94 5.94a1.5 1.5 0 0 0 1.06.44H16.5A1.5 1.5 0 0 1 18 7.88v6.62a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 2 14.5v-9Z',
        }));
    }

    /**
     * Renderless recorder: every time the main view switches to a session
     * (mounted into the session-scoped composer dock), report a touch so the
     * Host records "the user opened this session now". Blank drafts are not
     * recorded; the effect re-fires only when the opened identity changes,
     * not on activity updates, so recording follows navigation.
     * @param props - session-scoped standard props (the bound Session id and
     * the global sessions hook).
     * @returns null.
     */
    function SessionTouchRecorder({ sessionId, useSessions }) {
      const sessions = useSessions((snapshot) => snapshot);
      const session = sessionId === undefined ? undefined : sessions.byId[sessionId];
      const cwd = session?.cwd;
      const title = session?.displayTitle;
      const blank = session?.blank;
      const lastTouchedRef = useRef('');
      useEffect(() => {
        if (sessionId === undefined || blank === true) return;
        const key = sessionId + '|' + (cwd ?? '');
        const timer = setTimeout(() => {
          // Same identity+workspace within the debounce window: skip the POST.
          if (lastTouchedRef.current === key) return;
          lastTouchedRef.current = key;
          post('/touch', { sessionId, path: cwd, title }).catch(() => {});
        }, TOUCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
      }, [sessionId, cwd, title, blank]);
      return null;
    }

    /**
     * The Recents panel body: a flat, most-recently-opened list of sessions,
     * each row labelled with its workspace, with a blinking three-dot leading
     * mark while the Session runs.
     * @param props - framework hooks, injected callbacks, and the locale seat.
     * @returns the panel.
     */
    function RecentSessionsPanel(props) {
      const { useSessions, useSessionStatus, onOpenSession, t } = props;
      const sessions = useSessions((snapshot) => snapshot);
      const statuses = useSessionStatus((snapshot) => snapshot);
      const [recents, setRecents] = useState([]);
      const [dir, setDir] = useState('');
      const [staleHost, setStaleHost] = useState(false);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState('');
      const [now, setNow] = useState(() => Date.now());

      // Clock for relative times.
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000);
        return () => clearInterval(timer);
      }, []);

      const refresh = useCallback(async () => {
        try {
          const data = await api('/recents');
          // A Host still running the previous (workspace-keyed) code answers
          // without a `sessions` array: say so in the panel instead of
          // silently rendering an empty list.
          if (Array.isArray(data.sessions)) {
            setStaleHost(false);
            setRecents(data.sessions);
          }
          else {
            setStaleHost(true);
            setRecents([]);
          }
          setDir(data.dir || '');
          setError(null);
          return data;
        }
        catch (cause) {
          setError(String((cause && cause.message) || cause));
          return null;
        }
        finally {
          setLoading(false);
        }
      }, []);

      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, REFRESH_MS);
        return () => clearInterval(timer);
      }, [refresh]);

      // First run with an empty store: seed from the catalog's most recently
      // updated sessions so the panel is useful immediately. Waits for the
      // list phase to settle and does not consume the attempt while pending,
      // and never seeds against a Host still running the previous code.
      useEffect(() => {
        if (loading || staleHost || recents.length > 0) return;
        if (sessions.phase !== 'ready') return;
        const seeds = [];
        for (const id of sessions.ids) {
          const session = sessions.byId[id];
          if (session === undefined || session.blank || !session.cwd || session.origin === 'subagent') continue;
          seeds.push(session);
          if (seeds.length >= SEED_LIMIT) break;
        }
        if (seeds.length === 0) return;
        (async () => {
          // Touch oldest-first so the final stored order is newest-first.
          for (const session of seeds.slice().sort((a, b) => a.updatedAt - b.updatedAt)) {
            try {
              await post('/touch', {
                sessionId: session.id,
                path: session.cwd,
                title: session.displayTitle,
                lastAccessedAt: session.updatedAt,
              });
            }
            catch { /* seeding is best-effort */ }
          }
          refresh();
        })();
      }, [loading, staleHost, recents.length, sessions, refresh]);

      // Auto-dismiss transient notices.
      useEffect(() => {
        if (notice === '') return;
        const timer = setTimeout(() => setNotice(''), 3000);
        return () => clearTimeout(timer);
      }, [notice]);

      const clear = useCallback(async () => {
        try {
          await post('/clear');
          setRecents([]);
          setNotice(t('panel.clearDone'));
        }
        catch { /* best-effort */ }
      }, [t]);

      const remove = useCallback(async (sessionId) => {
        try {
          const data = await post('/remove', { sessionId });
          setRecents(data.sessions || []);
        }
        catch { /* best-effort */ }
      }, []);

      const open = useCallback((sessionId, record) => {
        // Record the visit immediately (the recorder also covers view mounts);
        // for a stale record, keep its stored labels.
        post('/touch', {
          sessionId,
          path: record?.path,
          title: record?.title,
        }).catch(() => {});
        try {
          onOpenSession(sessionId);
        }
        catch { /* the workspace surface reports navigation failures */ }
      }, [onOpenSession]);

      const isRunning = (sessionId) => {
        const status = statuses.get(sessionId);
        if (status !== undefined && status.running !== undefined) return status.running;
        const session = sessions.byId[sessionId];
        return session !== undefined && session.running;
      };

      // Overlay the persisted visit order with the live catalog.
      const rows = useMemo(() => {
        return recents.slice(0, MAX_PANEL_ROWS).map((record) => {
          const live = sessions.byId[record.sessionId];
          const path = live?.cwd ?? record.path;
          return {
            sessionId: record.sessionId,
            title: live?.displayTitle || record.title || record.sessionId,
            path,
            stale: live === undefined,
            lastAccessedAt: record.lastAccessedAt,
          };
        });
      }, [recents, sessions]);

      let body;
      if (error !== null) {
        body = h('div', { className: 'rw-empty' }, t('panel.error', { message: error }));
      }
      else if (staleHost) {
        body = h('div', { className: 'rw-empty rw-empty-stale' }, t('panel.stale'));
      }
      else if (loading && rows.length === 0) {
        body = h('div', { className: 'rw-empty' }, t('panel.loading'));
      }
      else if (rows.length === 0) {
        body = h('div', { className: 'rw-empty' }, t('panel.empty'));
      }
      else {
        body = h('ul', { className: 'rw-list' },
          rows.map((row) => {
            const running = isRunning(row.sessionId);
            const workspaceLabel = row.path ? basename(row.path) : '';
            return h('li', {
              key: row.sessionId,
              className: 'rw-row',
            },
              h('button', {
                type: 'button',
                className: 'rw-session' + (row.stale ? ' stale' : ''),
                onClick: () => open(row.sessionId, row),
                title: row.stale ? t('session.stale') : undefined,
              },
                h('span', { className: 'rw-leading' },
                  running
                    ? h('span', { className: 'rw-dots', role: 'img', 'aria-label': t('session.running') },
                        h('span'), h('span'), h('span'))
                    : h('span', { className: 'rw-dot' })),
                h('span', { className: 'rw-main' },
                  h('span', { className: 'rw-sessionTitle' }, row.title),
                  workspaceLabel !== '' && h('span', {
                    className: 'rw-workspaceChip',
                    title: t('workspace.tooltip', { path: row.path }),
                  },
                    chipFolderIcon(),
                    h('span', { className: 'rw-workspaceChipLabel' }, workspaceLabel))),
                h('span', { className: 'rw-time' },
                  formatRelative(row.lastAccessedAt, now, t))),
              h('button', {
                type: 'button',
                className: 'rw-remove',
                'aria-label': t('session.remove'),
                title: t('session.remove'),
                onClick: () => remove(row.sessionId),
              }, '×'));
          }));
      }

      return h('section', { className: 'rw-panel', 'aria-label': t('panel.title') },
        h('div', { className: 'rw-header' },
          h('h1', { className: 'rw-title' }, t('panel.title')),
          h('div', { className: 'rw-toolbar' },
            h('button', { type: 'button', className: 'rw-button', onClick: refresh }, t('panel.refresh')),
            h('button', { type: 'button', className: 'rw-button', onClick: clear }, t('panel.clear')))),
        notice !== '' ? h('div', { className: 'rw-empty' }, notice) : body,
        dir !== '' && h('div', { className: 'rw-footer' }, t('panel.dir', { dir })));
    }

    /**
     * Register the panel, its sidebar entry, and the touch recorder.
     * @param ctx - browser services used by these contributions.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, STRINGS), 'recent-workspaces: dictionaries');
      ctx.effect(installCss, 'recent-workspaces: styles');
      const t = ctx.locale.bind(NS);
      const openSession = (sessionId) => ctx.uiWorkspace.openSession(sessionId);

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ onOpenSession: openSession }),
      }, RecentSessionsPanel));

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        locale: NS,
        label: () => t('panel'),
      }, RecentSessionsIcon));

      // Session-scoped invisible recorder: mounts inside the composer dock of
      // whatever session the main view currently shows.
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: RECORDER_ID,
        order: 999,
      }, SessionTouchRecorder));
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply,
    };
  },
});