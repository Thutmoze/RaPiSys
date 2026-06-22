/** RaPiSys — /api/layouts: dashboard layout persistence (single-admin model).
 *
 * Reads are public (so the saved arrangement shows for anyone viewing the
 * dashboard); writes require an authenticated admin session via requireControl.
 */
import express from 'express';

// Widget id must be a simple slug; placement values are bounded integers.
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;
// A page key is a slug, optionally with a single ':<id>' suffix for per-dashboard
// overview layouts (e.g. 'overview:d1abc'). Bounded length, no other punctuation.
const PAGE_RE = /^[a-z0-9][a-z0-9_-]{0,40}(:[a-z0-9][a-z0-9_-]{0,40})?$/i;
const NAME_RE = /^[a-z0-9][a-z0-9 _-]{0,40}$/i;

function sanitizeLayout(input) {
  if (!Array.isArray(input)) throw new Error('layout must be an array');
  if (input.length > 100) throw new Error('too many widgets');
  return input.map((w) => {
    if (!w || !ID_RE.test(String(w.id || ''))) throw new Error('invalid widget id');
    const int = (v, lo, hi, dflt) => {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) return dflt;
      return Math.min(hi, Math.max(lo, n));
    };
    return {
      id: String(w.id),
      x: int(w.x, 0, 48, 0),
      y: int(w.y, 0, 9999, 0),
      w: int(w.w, 1, 48, 1),
      h: int(w.h, 1, 96, 1),
      visible: w.visible === false ? false : true,
    };
  });
}

export function layoutsRouter({ layoutsRepo, requireControl, events }) {
  const r = express.Router();

  // ---- Overview dashboards (admin-only: list/add/rename/delete/select) ------
  // Registered before /:page so 'dashboards' isn't captured as a page param.
  // Glyph is a key into the frontend's icon library — restrict to a slug so no
  // arbitrary markup is ever stored or echoed.
  const GLYPH_RE = /^[a-z][a-z0-9_-]{0,24}$/i;
  r.get('/dashboards', requireControl, (req, res) => {
    res.json(layoutsRepo.listDashboards());
  });
  r.post('/dashboards', requireControl, (req, res) => {
    const name = String(req.body?.name || 'New dashboard');
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'invalid name' });
    const glyph = req.body?.glyph;
    if (glyph != null && !GLYPH_RE.test(String(glyph))) return res.status(400).json({ error: 'invalid glyph' });
    const d = layoutsRepo.addDashboard(name, glyph || null);
    events?.add('dashboard.added', 'info', { id: d.id });
    res.json({ ok: true, dashboard: d });
  });
  r.put('/dashboards/reorder', requireControl, (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be an array' });
    if (ids.length > 50 || ids.some((x) => !PAGE_RE.test(String(x)))) return res.status(400).json({ error: 'invalid ids' });
    layoutsRepo.reorderDashboards(ids);
    res.json({ ok: true });
  });
  r.put('/dashboards/:id', requireControl, (req, res) => {
    const name = String(req.body?.name || '');
    if (!NAME_RE.test(name)) return res.status(400).json({ error: 'invalid name' });
    const glyph = req.body?.glyph;
    if (glyph != null && glyph !== '' && !GLYPH_RE.test(String(glyph))) return res.status(400).json({ error: 'invalid glyph' });
    // pass glyph through (including '' → cleared) only when the field is present
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'glyph')) {
      layoutsRepo.renameDashboard(req.params.id, name, glyph || null);
    } else {
      layoutsRepo.renameDashboard(req.params.id, name);
    }
    res.json({ ok: true });
  });
  r.delete('/dashboards/:id', requireControl, (req, res) => {
    const ok = layoutsRepo.deleteDashboard(req.params.id);
    if (!ok) return res.status(400).json({ error: 'cannot delete the built-in dashboard' });
    events?.add('dashboard.deleted', 'info', { id: req.params.id });
    res.json({ ok: true });
  });
  r.post('/dashboards/:id/select', requireControl, (req, res) => {
    layoutsRepo.setActiveDashboard(req.params.id);
    res.json({ ok: true });
  });

  // Active layout for a page (null → upstream default positions).
  r.get('/:page', (req, res) => {
    if (!PAGE_RE.test(req.params.page)) return res.status(400).json({ error: 'bad page' });
    res.json({ layout: layoutsRepo.getActive(req.params.page) });
  });

  // Full bundle (active + presets) — used by the layout editor.
  r.get('/:page/bundle', (req, res) => {
    if (!PAGE_RE.test(req.params.page)) return res.status(400).json({ error: 'bad page' });
    res.json(layoutsRepo.getPageBundle(req.params.page));
  });

  // Save the active layout.
  r.put('/:page', requireControl, (req, res) => {
    if (!PAGE_RE.test(req.params.page)) return res.status(400).json({ error: 'bad page' });
    let layout;
    try { layout = sanitizeLayout(req.body?.layout); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    layoutsRepo.saveActive(req.params.page, layout);
    events?.add('layout.saved', 'info', { page: req.params.page, widgets: layout.length });
    res.json({ ok: true });
  });

  // Reset a page to upstream default.
  r.delete('/:page', requireControl, (req, res) => {
    if (!PAGE_RE.test(req.params.page)) return res.status(400).json({ error: 'bad page' });
    layoutsRepo.resetActive(req.params.page);
    events?.add('layout.reset', 'info', { page: req.params.page });
    res.json({ ok: true });
  });

  // Save a named preset.
  r.put('/:page/preset/:name', requireControl, (req, res) => {
    if (!PAGE_RE.test(req.params.page)) return res.status(400).json({ error: 'bad page' });
    if (!NAME_RE.test(req.params.name)) return res.status(400).json({ error: 'bad preset name' });
    let layout;
    try { layout = sanitizeLayout(req.body?.layout); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    layoutsRepo.savePreset(req.params.page, req.params.name, layout);
    events?.add('layout.preset_saved', 'info', { page: req.params.page, name: req.params.name });
    res.json({ ok: true });
  });

  // Delete a named preset.
  r.delete('/:page/preset/:name', requireControl, (req, res) => {
    if (!PAGE_RE.test(req.params.page)) return res.status(400).json({ error: 'bad page' });
    if (!NAME_RE.test(req.params.name)) return res.status(400).json({ error: 'bad preset name' });
    layoutsRepo.deletePreset(req.params.page, req.params.name);
    res.json({ ok: true });
  });

  return r;
}
