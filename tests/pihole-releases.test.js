/**
 * RaPiSys — Pi-hole in the Updates tab: versions from Pi-hole's own cache,
 * release notes between installed and latest, the security summary drawn from
 * them, and the markdown renderer of the changelog viewer.
 */
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import express from 'express';
import request from 'supertest';
import { cmpVer, notesBetween, summarizeNotes, createPiholeReleases, githubError } from '../server/services/pihole-releases.js';
import { releaseNotesHtml, inlineHtml } from '../src/modules/release-notes.js';
import { networkRouter } from '../server/routes/network.js';

const require = createRequire(import.meta.url);
process.env.AGENT_SECRET = process.env.AGENT_SECRET || 'test-secret-not-used-for-any-real-hmac';
const { parsePiholeVersions } = require('../agent/rapisys-agent.cjs');

// /etc/pihole/versions as found in the XRPi container on 2026-10-24.
const VERSIONS = `CORE_VERSION=v6.4.3
CORE_BRANCH=master
GITHUB_CORE_VERSION=v6.5
WEB_VERSION=v6.6
GITHUB_WEB_VERSION=v6.6.1
FTL_VERSION=v6.7.1
GITHUB_FTL_VERSION=v6.8
DOCKER_VERSION=2026.09.0
GITHUB_DOCKER_VERSION=2026.10.0
`;

describe('parsePiholeVersions', () => {
  it('reads installed and latest versions of every part, image included', () => {
    expect(parsePiholeVersions(VERSIONS)).toEqual({
      current: { CORE: '6.4.3', WEB: '6.6', FTL: '6.7.1', DOCKER: '2026.09.0' },
      latest: { CORE: '6.5', WEB: '6.6.1', FTL: '6.8', DOCKER: '2026.10.0' },
    });
  });
  it('does not take GITHUB_ lines for installed ones, and skips null', () => {
    expect(parsePiholeVersions('GITHUB_CORE_VERSION=v6.5\nWEB_VERSION=null\n')).toEqual({ current: {}, latest: { CORE: '6.5' } });
    expect(parsePiholeVersions('')).toEqual({ current: {}, latest: {} });
  });
});

describe('release selection', () => {
  it('compares Pi-hole and image versions numerically', () => {
    expect(cmpVer('v6.10', 'v6.9')).toBe(1);
    expect(cmpVer('6.6', 'v6.6.0')).toBe(0);
    expect(cmpVer('2026.09.0', '2026.10.0')).toBe(-1);
  });
  it('keeps published releases after installed and up to latest, newest first', () => {
    const rel = ['v6.4.2', 'v6.4.3', 'v6.4.4', 'v6.5', 'v6.6'].map((t) => ({ tag_name: t }));
    rel.push({ tag_name: 'v6.5-beta', prerelease: true }, { tag_name: 'v6.4.9', draft: true });
    expect(notesBetween(rel, '6.4.3', '6.5').map((r) => r.tag_name)).toEqual(['v6.5', 'v6.4.4']);
  });
});

describe('summarizeNotes', () => {
  it('counts distinct advisories and takes the worst severity', () => {
    const notes = [
      { date: '2026-10-17T10:00:00Z', body: '## Security\n**Low**\n- GHSA-aaaa-bbbb-cccc (CVSS 2.2): x\n**High**\n- GHSA-dddd-eeee-ffff (CVSS 7.8): y\n## What\'s Changed\n- fix GHSA-aaaa-bbbb-cccc again' },
      { date: '2026-09-19T10:00:00Z', body: '- [pi-hole/FTL/security/advisories/GHSA-gggg-hhhh-iiii](https://x) — thing (Medium)' },
    ];
    expect(summarizeNotes(notes)).toEqual({ advisories: 3, urgency: 'high', released: Date.parse('2026-10-17T10:00:00Z') });
  });
  it('does not count an advisory\'s duplicate id', () => {
    const body = '**Medium**\n- [GHSA-v53r-4564-3449](https://x) (CVSS 6.5, duplicate [GHSA-846w-3j3v-2hx8](https://y)): read-only sessions';
    expect(summarizeNotes([{ body }]).advisories).toBe(1);
  });
  it('has no urgency without advisories', () => {
    expect(summarizeNotes([{ date: null, body: '**High**\n- not a security item' }])).toEqual({ advisories: 0, urgency: null, released: null });
  });
});

describe('notesFor', () => {
  const lists = {
    'docker-pi-hole': [{ tag_name: '2026.10.0', body: '<!-- gen -->\nimage', published_at: '2026-10-17T00:00:00Z', html_url: 'u1' }, { tag_name: '2026.09.0', body: 'old' }],
    'pi-hole': [{ tag_name: 'v6.5', body: 'core' }, { tag_name: 'v6.4.3', body: 'old' }],
    web: [{ tag_name: 'v6.6.1', body: 'web' }],
    FTL: [{ tag_name: 'v6.8', body: 'ftl' }],
  };
  const fetchImpl = vi.fn(async (url) => ({ ok: true, json: async () => lists[url.match(/pi-hole\/([^/]+)\/releases/)[1]] }));
  const { current, latest } = parsePiholeVersions(VERSIONS);
  const { DOCKER: c, ...cur } = current;
  const { DOCKER: l, ...lat } = latest;
  const status = { method: 'docker', currentVersion: c, latestVersion: l, components: { current: cur, latest: lat } };

  it('lists the new release of each part that is behind, image first, and caches per repo', async () => {
    const rel = createPiholeReleases({ fetchImpl });
    const notes = await rel.notesFor(status);
    expect(notes.map((n) => `${n.group} ${n.tag}`)).toEqual(['Docker image 2026.10.0', 'Core v6.5', 'Web v6.6.1', 'FTL v6.8']);
    expect(notes[0]).toMatchObject({ body: 'image', installed: '2026.09.0', url: 'u1' });
    await rel.notesFor(status);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it('skips the image for a host install and parts already current', async () => {
    const rel = createPiholeReleases({ fetchImpl });
    const host = { method: 'host', components: { current: { ...cur, WEB: '6.6.1' }, latest: lat } };
    expect((await rel.notesFor(host)).map((n) => n.group)).toEqual(['Core', 'FTL']);
  });
  it('uses the last good list when GitHub fails', async () => {
    let t = 0;
    const flaky = vi.fn(async (url) => { if (t > 0) throw new Error('down'); return fetchImpl(url); });
    const rel = createPiholeReleases({ fetchImpl: flaky, ttlMs: 10, now: () => t });
    await rel.notesFor(status);
    t = 100;
    expect(await rel.notesFor(status)).toHaveLength(4);
  });
});

describe('githubError', () => {
  const res = (status, headers) => ({ status, headers: new Headers(headers) });
  it('names the hourly limit and when it resets', () => {
    const reset = Date.UTC(2026, 9, 24, 15, 41) / 1000;
    const msg = githubError(res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }), 'FTL');
    expect(msg).toMatch(/^GitHub's hourly limit for this network is used up; try again after \d\d:\d\d$/);
  });
  it('keeps other failures plain', () => {
    expect(githubError(res(404, {}), 'FTL')).toBe('GitHub answered 404 for pi-hole/FTL');
  });
});

describe('releaseNotesHtml', () => {
  it('renders headings, severity labels, bullets, code and links', () => {
    const html = releaseNotesHtml('<!-- x -->\n## Security\n**High**\n- [GHSA-cf36-4hhc-8398](https://github.com/pi-hole/pi-hole/security/advisories/GHSA-cf36-4hhc-8398): `/opt/pihole` fix\n\nPlain **bold** line');
    expect(html).toBe('<h5>Security</h5><span class="up-rn-sev up-rn-sev-high">High</span>'
      + '<ul><li><a href="https://github.com/pi-hole/pi-hole/security/advisories/GHSA-cf36-4hhc-8398" target="_blank" rel="noopener noreferrer">GHSA-cf36-4hhc-8398</a>: <code>/opt/pihole</code> fix</li></ul>'
      + '<p>Plain <b>bold</b> line</p>');
  });
  it('links bare advisory ids and URLs', () => {
    expect(inlineHtml('see GHSA-aaaa-bbbb-cccc and https://github.com/pi-hole/web/pull/1'))
      .toBe('see <a href="https://github.com/advisories/GHSA-aaaa-bbbb-cccc" target="_blank" rel="noopener noreferrer">GHSA-aaaa-bbbb-cccc</a>'
        + ' and <a href="https://github.com/pi-hole/web/pull/1" target="_blank" rel="noopener noreferrer">pi-hole/web/pull/1</a>');
  });
  it('escapes HTML and drops non-https links', () => {
    const html = releaseNotesHtml('- <img src=x onerror=alert(1)> [x](javascript:alert(1)) **<b>**');
    expect(html).not.toMatch(/<img|href="javascript/);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('Pi-hole routes', () => {
  function app(over = {}) {
    const recorded = [];
    const network = {
      piholeUpdate: vi.fn(async (onLine) => { onLine('Pulling latest image…'); return { ok: true, method: 'docker', version: '6.5' }; }),
      piholeResetSession: () => {}, piholeCheckUpdate: vi.fn(),
      ...over.network,
    };
    const deps = { network, metricsRepo: {}, requireControl: (q, s, n) => n(), loadSettings: async () => ({}),
      saveSettings: async () => {}, withFileLock: (fn) => fn(), secrets: {}, refreshPiholeConfig: async () => {},
      piholeUpdateCheck: vi.fn(async () => (globalThis.__rapisysPiholeUpdate = { installed: true, method: 'docker', updateAvailable: false, currentVersion: '2026.10.0' })),
      piholeReleases: { notesFor: vi.fn(async () => [{ group: 'Core', tag: 'v6.5' }]) },
      updatesRepo: { record: (r) => recorded.push(r) }, ...over.deps };
    const a = express();
    a.use('/api/network', networkRouter(deps));
    return { a, recorded, deps };
  }

  it('records a successful update in History with from and to versions', async () => {
    globalThis.__rapisysPiholeUpdate = { installed: true, method: 'docker', updateAvailable: true, currentVersion: '2026.09.0', latestVersion: '2026.10.0' };
    const { a, recorded } = app();
    const r = await request(a).get('/api/network/dns/pihole/update/stream');
    expect(r.text).toMatch(/event: done/);
    expect(r.text).toMatch(/"currentVersion":"2026.10.0"/);
    expect(recorded).toEqual([expect.objectContaining({ packageName: 'pihole', fromV: '2026.09.0', toV: '2026.10.0', result: 'success', description: 'Pi-hole (Docker image)' })]);
  });

  it('records a failed update', async () => {
    globalThis.__rapisysPiholeUpdate = { installed: true, method: 'docker', updateAvailable: true, currentVersion: '2026.09.0', latestVersion: '2026.10.0' };
    const { a, recorded } = app({ network: { piholeUpdate: vi.fn(async () => { throw new Error('docker compose pull failed'); }) } });
    const r = await request(a).get('/api/network/dns/pihole/update/stream');
    expect(r.text).toMatch(/event: failed/);
    expect(recorded[0]).toMatchObject({ packageName: 'pihole', result: 'failed' });
  });

  it('runs Check now through the saved-status job', async () => {
    const { a, deps } = app();
    const r = await request(a).get('/api/network/dns/pihole/update-check');
    expect(deps.piholeUpdateCheck).toHaveBeenCalled();
    expect(r.body.currentVersion).toBe('2026.10.0');
  });

  it('serves release notes for the saved status', async () => {
    globalThis.__rapisysPiholeUpdate = { installed: true, method: 'docker', updateAvailable: true };
    const { a } = app();
    const r = await request(a).get('/api/network/dns/pihole/release-notes');
    expect(r.body.notes).toEqual([{ group: 'Core', tag: 'v6.5' }]);
  });
});
