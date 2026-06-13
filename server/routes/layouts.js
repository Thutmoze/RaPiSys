/** RaPiSys — /api/layouts: dashboard layout persistence (single-admin model).
 *
 * Reads are public (so the saved arrangement shows for anyone viewing the
 * dashboard); writes require an authenticated admin session via requireControl.
 */
import express from 'express';

// Widget id must be a simple slug; placement values are bounded integers.
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;
const PAGE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;
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
