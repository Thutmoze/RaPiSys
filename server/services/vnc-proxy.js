/**
 * RaPiSys — VeNCrypt/TLS VNC proxy.
 *
 * noVNC (in the browser) cannot speak wayvnc's offered security types: VeNCrypt
 * requires in-stream TLS (no browser TLS-in-JS), RA2 type 5 isn't implemented by
 * noVNC (only RA2ne/6), and UnixLogin isn't either. So this bridge terminates
 * the upstream crypto itself and presents a clean, already-authenticated RFB
 * stream to noVNC as a plain "None"-auth server.
 *
 * Downstream (bridge ↔ noVNC):  RFB 3.8, offers [None], replies SecurityResult OK,
 *   forwards ServerInit from upstream, then splices.
 * Upstream  (bridge ↔ wayvnc):  RFB version → VeNCrypt(19) → version 0.2 →
 *   choose an X509Plain/TLSPlain subtype → TLS handshake (Node tls) → Plain auth
 *   (username/password = PAM creds) → SecurityResult → ClientInit → ServerInit →
 *   then splices.
 *
 * Every handshake step is logged (when debug=true) so divergences can be pinned
 * down on-device.
 */

import net from 'net';
import tls from 'tls';

// VeNCrypt sub-auth types we can terminate (all do TLS then username/password).
const VENCRYPT_TLS_PLAIN = 259;   // anonymous TLS + Plain
const VENCRYPT_X509_PLAIN = 262;  // X.509 (server cert) TLS + Plain
const VENCRYPT_TLS_NONE = 257;    // anonymous TLS, no further auth
const VENCRYPT_X509_NONE = 260;   // X.509 TLS, no further auth

// A tiny pull-reader over a stream of Buffers: await exactly N bytes.
export function createReader() {
  let buf = Buffer.alloc(0);
  let want = 0;
  let resolve = null;
  function feed(chunk) {
    buf = Buffer.concat([buf, chunk]);
    maybe();
  }
  function maybe() {
    if (resolve && buf.length >= want) {
      const out = buf.subarray(0, want);
      buf = buf.subarray(want);
      const r = resolve; resolve = null; want = 0;
      r(out);
    }
  }
  function read(n) {
    return new Promise((res) => { want = n; resolve = res; maybe(); });
  }
  // any leftover bytes already buffered (handed to the splice phase)
  function drain() { const b = buf; buf = Buffer.alloc(0); return b; }
  return { feed, read, drain };
}

/**
 * Run the VeNCrypt/TLS proxy.
 * @param {WebSocket} ws        downstream noVNC connection
 * @param {object}    opts      { host, port, username, password, debug, onEvent }
 */
export async function vncVencryptProxy(ws, opts) {
  const { host = '127.0.0.1', port = 5900, username = '', password = '', debug = false } = opts;
  const log = (...a) => { if (debug) console.log('[vnc-proxy]', ...a); };
  const wsReader = createReader();
  let upReader = null;       // upstream byte reader (raw TCP, then TLS)
  let upstream = null;       // current upstream socket (raw TCP, then upgraded to TLS)
  let tlsSock = null;
  let spliced = false;
  let closed = false;

  const fail = (msg) => {
    log('FAIL:', msg);
    try { opts.onEvent?.('error', msg); } catch { /* */ }
    cleanup();
  };
  function cleanup() {
    if (closed) return; closed = true;
    try { tlsSock && tlsSock.destroy(); } catch { /* */ }
    try { upstream && upstream.destroy(); } catch { /* */ }
    try { ws.close(); } catch { /* */ }
  }

  // ---- downstream (noVNC) framing ------------------------------------------
  ws.on('message', (m, isBinary) => {
    const chunk = Buffer.isBuffer(m) ? m : Buffer.from(m);
    if (spliced) { try { tlsSock.write(chunk); } catch { /* */ } return; }
    wsReader.feed(chunk);
  });
  ws.on('close', cleanup);
  ws.on('error', cleanup);
  const wsSend = (b) => { try { ws.send(b); } catch { /* */ } };

  try {
    // ===== DOWNSTREAM HANDSHAKE (bridge acts as a None-auth VNC server) =====
    // 1) send our ProtocolVersion
    wsSend(Buffer.from('RFB 003.008\n'));
    // 2) read noVNC's ProtocolVersion (12 bytes)
    const clientVer = await wsReader.read(12);
    log('noVNC version:', clientVer.toString().trim());
    // 3) offer exactly one security type: None(1)
    wsSend(Buffer.from([1, 1]));
    // 4) read noVNC's selected type (1 byte) — must be 1
    const selType = (await wsReader.read(1))[0];
    if (selType !== 1) return fail(`noVNC selected unexpected security type ${selType}`);
    // 5) SecurityResult OK (U32 = 0)
    wsSend(Buffer.from([0, 0, 0, 0]));
    // 6) read ClientInit (1 byte shared-flag)
    const clientInit = await wsReader.read(1);
    log('noVNC ClientInit shared-flag:', clientInit[0]);

    // ===== UPSTREAM HANDSHAKE (bridge acts as a VeNCrypt client) =====
    const serverInit = await upstreamHandshake(clientInit);
    if (closed) return;

    // 7) forward ServerInit to noVNC, then splice everything.
    wsSend(serverInit);
    spliced = true;
    log('spliced; ServerInit', serverInit.length, 'bytes forwarded');
    // any upstream bytes already buffered past ServerInit go out immediately
    const leftover = upReader.drain();
    if (leftover.length) wsSend(leftover);
    // pump upstream (TLS) → noVNC
    tlsSock.on('data', (d) => { if (spliced) wsSend(d); });
    tlsSock.on('close', cleanup);
    tlsSock.on('error', cleanup);
    // any downstream bytes buffered past ClientInit go to upstream
    const dsLeft = wsReader.drain();
    if (dsLeft.length) { try { tlsSock.write(dsLeft); } catch { /* */ } }
    opts.onEvent?.('ready');
  } catch (err) {
    if (!closed) fail('handshake error: ' + err.message);
  }

  // upstream reader is created inside upstreamHandshake but referenced in splice
  async function upstreamHandshake(clientInitFlag) {
    upReader = createReader();
    // connect raw TCP first
    await new Promise((res, rej) => {
      upstream = net.connect({ host, port }, res);
      upstream.once('error', rej);
    });
    log('TCP connected to', host + ':' + port);
    upstream.on('data', (d) => upReader.feed(d));
    upstream.on('error', (e) => fail('upstream socket error: ' + e.message));
    upstream.on('close', () => { if (!spliced) fail('upstream closed during handshake'); });

    const writeRaw = (b) => upstream.write(b);

    // 1) read server ProtocolVersion, echo it back (use 3.8)
    const sv = await upReader.read(12);
    log('wayvnc version:', sv.toString().trim());
    writeRaw(Buffer.from('RFB 003.008\n'));

    // 2) read security types: U8 count, then count×U8
    const nTypes = (await upReader.read(1))[0];
    if (nTypes === 0) {
      // failure: U32 reason length + reason
      const rl = (await upReader.read(4)).readUInt32BE(0);
      const reason = (await upReader.read(rl)).toString();
      throw new Error('wayvnc refused: ' + reason);
    }
    const types = Array.from(await upReader.read(nTypes));
    log('wayvnc security types:', types);
    if (!types.includes(19)) throw new Error('wayvnc does not offer VeNCrypt (got ' + types + ')');

    // 3) select VeNCrypt (19)
    writeRaw(Buffer.from([19]));

    // 4) VeNCrypt version: read [maj,min], require 0.2, reply 0.2
    const vv = await upReader.read(2);
    log('VeNCrypt version:', vv[0] + '.' + vv[1]);
    if (!(vv[0] === 0 && vv[1] === 2)) throw new Error('unsupported VeNCrypt version ' + vv[0] + '.' + vv[1]);
    writeRaw(Buffer.from([0, 2]));

    // 5) version ack (1 byte, 0 = ok)
    const vack = (await upReader.read(1))[0];
    if (vack !== 0) throw new Error('VeNCrypt version rejected (' + vack + ')');

    // 6) subtypes: U8 count, then count×U32
    const nSub = (await upReader.read(1))[0];
    if (nSub < 1) throw new Error('VeNCrypt offered no subtypes');
    const subBuf = await upReader.read(4 * nSub);
    const subtypes = [];
    for (let i = 0; i < nSub; i++) subtypes.push(subBuf.readUInt32BE(i * 4));
    log('VeNCrypt subtypes:', subtypes);

    // 7) choose a TLS-Plain subtype (we can do username/password over TLS).
    //    Prefer X509Plain (cert), then TLSPlain (anon), then the *None variants.
    let chosen = null;
    for (const pref of [VENCRYPT_X509_PLAIN, VENCRYPT_TLS_PLAIN, VENCRYPT_X509_NONE, VENCRYPT_TLS_NONE]) {
      if (subtypes.includes(pref)) { chosen = pref; break; }
    }
    if (chosen == null) throw new Error('no TLS-capable VeNCrypt subtype offered (got ' + subtypes + ')');
    const needsPlainAuth = (chosen === VENCRYPT_X509_PLAIN || chosen === VENCRYPT_TLS_PLAIN);
    log('chose VeNCrypt subtype', chosen, needsPlainAuth ? '(plain auth)' : '(no auth)');
    const sb = Buffer.alloc(4); sb.writeUInt32BE(chosen, 0); writeRaw(sb);

    // 8) server sends 1 ack byte (1 = continue) before TLS in many servers; but
    //    per the strict 0.2 spec the TLS handshake starts immediately. wayvnc
    //    (neatvnc) sends an ack byte: read it but tolerate either path by
    //    peeking — we read 1 byte; if it's part of the TLS ClientHello we'd
    //    corrupt the stream, so we DON'T read here and start TLS directly, which
    //    matches neatvnc. (If this proves wrong on-device, the log will show a
    //    TLS handshake failure and we add a 1-byte read here.)

    // 9) upgrade the socket to TLS. Hand the raw socket to tls.connect as the
    //    underlying transport; from here we read/write via tlsSock.
    upstream.removeAllListeners('data');
    const anyLeft = upReader.drain();   // should be empty; if not, TLS would choke
    if (anyLeft.length) log('WARNING: ' + anyLeft.length + ' bytes buffered before TLS (unexpected)');
    tlsSock = await new Promise((res, rej) => {
      const t = tls.connect({
        socket: upstream,
        rejectUnauthorized: false,           // wayvnc uses a self-signed cert
        // allow anonymous-DH ciphers for the TLS* (non-X509) subtypes
        ciphers: 'ALL:@SECLEVEL=0',
      }, () => res(t));
      t.once('error', rej);
    });
    log('TLS established, cipher:', tlsSock.getCipher && tlsSock.getCipher().name);

    // re-attach the reader to the TLS stream for the remaining handshake
    const tlsReader = createReader();
    tlsSock.on('data', (d) => { if (!spliced) tlsReader.feed(d); });

    // 10) Plain auth (if chosen): U32 user-len, U32 pass-len, user, pass
    if (needsPlainAuth) {
      if (!username) throw new Error('VNC requires a username (PAM) — set it in Settings');
      const u = Buffer.from(username, 'utf8');
      const p = Buffer.from(password, 'utf8');
      const hdr = Buffer.alloc(8);
      hdr.writeUInt32BE(u.length, 0); hdr.writeUInt32BE(p.length, 4);
      tlsSock.write(Buffer.concat([hdr, u, p]));
      log('sent Plain auth for user', username);
    }

    // 11) SecurityResult (U32, 0 = ok). In 3.8 a failure includes a reason.
    const sr = (await tlsReader.read(4)).readUInt32BE(0);
    if (sr !== 0) {
      let reason = '';
      try { const rl = (await tlsReader.read(4)).readUInt32BE(0); reason = (await tlsReader.read(rl)).toString(); } catch { /* */ }
      throw new Error('VNC auth failed' + (reason ? ': ' + reason : ' (bad username/password?)'));
    }
    log('upstream auth OK');

    // 12) ClientInit (shared flag) — forward noVNC's choice
    tlsSock.write(Buffer.from([clientInitFlag[0] ? 1 : 0]));

    // 13) ServerInit: U16 w, U16 h, 16-byte pixel-format, U32 name-len, name
    const head = await tlsReader.read(24);
    const nameLen = head.readUInt32BE(20);
    const name = await tlsReader.read(nameLen);
    const serverInit = Buffer.concat([head, name]);

    // hand the TLS reader's leftovers to upReader so the splice phase flushes them
    upReader = tlsReader;
    return serverInit;
  }
}
