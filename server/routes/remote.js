/** RaPiSys — /api/remote: in-browser SSH/VNC config + key management. */
import express from 'express';

export function remoteRouter({ remoteAccess, requireControl }) {
  const r = express.Router();

  // Current config (never returns the private key; public key is safe to show).
  r.get('/config', async (req, res) => {
    try { res.json(await remoteAccess.getConfig()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Update config (enable/disable, host/port/username). Control-mode only.
  r.put('/config', requireControl, async (req, res) => {
    try { res.json(await remoteAccess.setConfig(req.body || {})); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Generate (or rotate) the dashboard SSH keypair. Returns the public key to
  // install in ~/.ssh/authorized_keys on the Pi. Control-mode only.
  r.post('/ssh/key', requireControl, async (req, res) => {
    try { res.json(await remoteAccess.generateKey()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });

  return r;
}
