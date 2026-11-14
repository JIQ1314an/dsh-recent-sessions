# Changelog

## 0.2.0

- **Session-first recents**: the panel is now a flat list of the sessions you
  opened most recently (across every workspace), ordered by visit time rather
  than activity. Each row is labelled with the workspace it belongs to.
- **Honest visit tracking**: a renderless recorder mounted in the session-scoped
  composer dock records a touch whenever a session is opened from *any* entry
  point (sidebar, this panel, the New Session view), not only from the panel.
- **Stored snapshots**: `recents.json` is keyed by session id and keeps the
  workspace path and title, so a session that left the catalog still shows
  which workspace it belonged to.
- **Stale-Host detection**: the panel reports when the Host process still runs
  the previous plugin code (that is the usual reason a newly updated plugin
  appears empty), instead of silently rendering an empty list.
- **Seeding**: an empty store is filled from the most recently updated catalog
  sessions once the session list is ready.
- Minor: per-row remove, auto-dismissing notices, `/clear` accepted without a
  request body.

## 0.1.0

- First working version: workspace-grouped recents panel with quick session
  entry and a blinking three-dot mark for running sessions.