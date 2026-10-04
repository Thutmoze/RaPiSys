/** RaPiSys — finding a Docker Pi-hole after its tag moved, and judging updates.
 *
 * Fixtures are captured from XRPi (Docker 29, containerd image store) after
 * `docker pull pihole/pihole:latest` moved the tag to a newer image: the
 * `pihole` container still runs the old image, which is now untagged, so
 * `docker ps` shows it as `f7d1be836e3b` and `--filter ancestor=pihole/pihole`
 * no longer matches it. Its .Config.Image still reads `pihole/pihole:latest`.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
process.env.AGENT_SECRET = 'test-secret-not-used-for-any-real-hmac';
const { piholeImageTag, pickPiholeContainer, piholeDockerUpdateState } = require('../agent/rapisys-agent.cjs');

// docker inspect --format '{{.Name}}\t{{.Config.Image}}' $(docker ps -q)
const XRPI_INSPECT = [
  '/rapisys\trapisys:latest',
  '/ankhor-backend-1\tankhor-backend',
  '/ankhor-db-1\tpostgres:16-alpine',
  '/ankhor-docker-proxy-1\ttecnativa/docker-socket-proxy:latest',
  '/pihole\tpihole/pihole:latest',
  '/papyrusiq-papyrusiq-api-1\tpapyrusiq:latest',
  '/papyrusiq-caddy-1\tcaddy:2-alpine',
  '/papyrusiq-syncthing-1\tsyncthing/syncthing:latest',
].join('\n') + '\n';

// The running (old, untagged) image and the re-pulled pihole/pihole:latest.
const RUNNING_ID = 'sha256:f7d1be836e3bc608b56d82fc9904f5a831cdfbc0dc9c6d58f94e4c985c70038b';
const LATEST_ID = 'sha256:5b9c8cf51de7d6d3f2240dbe72baf5f06e1fd39cb4d77a99fab4fa13e23bd1be';
// Docker Hub tags/latest .digest at the time — the index digest, equal to
// LATEST_ID because the containerd store uses the index digest as image ID.
const HUB_DIGEST = LATEST_ID;
const NEWER_HUB = 'sha256:' + 'a'.repeat(64);

describe('piholeImageTag', () => {
  it('reads the tag of Docker Hub and GHCR Pi-hole references', () => {
    expect(piholeImageTag('pihole/pihole:latest')).toBe('latest');
    expect(piholeImageTag('pihole/pihole')).toBe('latest');
    expect(piholeImageTag('pihole/pihole:2025.11.0')).toBe('2025.11.0');
    expect(piholeImageTag('docker.io/pihole/pihole:latest')).toBe('latest');
    expect(piholeImageTag('ghcr.io/pi-hole/pihole:nightly')).toBe('nightly');
    expect(piholeImageTag(`pihole/pihole:latest@${LATEST_ID}`)).toBe('latest');
  });

  it('rejects other images, look-alikes and bare image IDs', () => {
    expect(piholeImageTag('rapisys:latest')).toBeNull();
    expect(piholeImageTag('someone/pihole:latest')).toBeNull();
    expect(piholeImageTag('pihole/pihole-unbound:latest')).toBeNull();
    expect(piholeImageTag('f7d1be836e3b')).toBeNull();
    expect(piholeImageTag('')).toBeNull();
  });
});

describe('pickPiholeContainer', () => {
  it('finds the XRPi container whose image tag moved on (the regression)', () => {
    expect(pickPiholeContainer(XRPI_INSPECT)).toBe('pihole');
  });

  it('matches on the configured image even when the name differs', () => {
    expect(pickPiholeContainer('/web\tnginx:latest\n/dns-1\tdocker.io/pihole/pihole:2025.11.0\n')).toBe('dns-1');
  });

  it('prefers an image match over a container merely named pihole', () => {
    expect(pickPiholeContainer('/pihole\tbusybox\n/dns\tpihole/pihole:latest\n')).toBe('dns');
  });

  it('falls back to a container named pihole (custom or ID-referenced image)', () => {
    expect(pickPiholeContainer(`/web\tnginx\n/pihole\t${RUNNING_ID}\n`)).toBe('pihole');
    expect(pickPiholeContainer('/pihole\tmy/pihole-custom:1\n')).toBe('pihole');
  });

  it('returns null when nothing looks like Pi-hole', () => {
    expect(pickPiholeContainer('/rapisys\trapisys:latest\n/db\tpostgres:16-alpine\n')).toBeNull();
    expect(pickPiholeContainer('')).toBeNull();
    expect(pickPiholeContainer(undefined)).toBeNull();
  });

  it('ignores rows with names Docker would not allow', () => {
    expect(pickPiholeContainer("/x'; rm -rf /\tpihole/pihole:latest\n")).toBeNull();
  });
});

describe('piholeDockerUpdateState', () => {
  it('XRPi: newer image pulled, container still on the old one → pending update', () => {
    expect(piholeDockerUpdateState({ containerImageId: RUNNING_ID, runningDigests: [],
      tagImageId: LATEST_ID, remoteDigest: HUB_DIGEST }))
      .toEqual({ updateAvailable: true, pending: true, checked: 'registry' });
  });

  it('XRPi without registry access still reports the pending recreate', () => {
    expect(piholeDockerUpdateState({ containerImageId: RUNNING_ID, tagImageId: LATEST_ID, remoteDigest: null }))
      .toEqual({ updateAvailable: true, pending: true, checked: 'local' });
  });

  it('up to date: running image is the registry digest (containerd store image ID)', () => {
    expect(piholeDockerUpdateState({ containerImageId: LATEST_ID, runningDigests: [`pihole/pihole@${LATEST_ID}`],
      tagImageId: LATEST_ID, remoteDigest: HUB_DIGEST }))
      .toEqual({ updateAvailable: false, pending: false, checked: 'registry' });
  });

  it('up to date: classic store, digest only in RepoDigests', () => {
    const classicId = 'sha256:' + 'c'.repeat(64);
    expect(piholeDockerUpdateState({ containerImageId: classicId, runningDigests: [`pihole/pihole@${HUB_DIGEST}`],
      tagImageId: classicId, remoteDigest: HUB_DIGEST }).updateAvailable).toBe(false);
  });

  it('registry has a newer digest than anything local → update, not pending', () => {
    expect(piholeDockerUpdateState({ containerImageId: LATEST_ID, runningDigests: [`pihole/pihole@${LATEST_ID}`],
      tagImageId: LATEST_ID, remoteDigest: NEWER_HUB }))
      .toEqual({ updateAvailable: true, pending: false, checked: 'registry' });
  });

  it('no registry answer and tag matches the container → no update claimed', () => {
    expect(piholeDockerUpdateState({ containerImageId: LATEST_ID, tagImageId: LATEST_ID }))
      .toEqual({ updateAvailable: false, pending: false, checked: 'local' });
    expect(piholeDockerUpdateState({}))
      .toEqual({ updateAvailable: false, pending: false, checked: 'local' });
  });
});
