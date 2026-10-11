/** RaPiSys — naming discovered services after the application owning the port. */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const { identifyPorts, imageBase } = await import('../server/services/port-owners.js');
const require = createRequire(import.meta.url);
process.env.AGENT_SECRET ||= 'test-secret-not-used-for-any-real-hmac';
const { parseListeners, containerIdFromCgroup } = require('../agent/rapisys-agent.cjs');

const id = (c) => c.repeat(64);
const container = (cid, name, image, project, service, ports = []) => ({
  Id: cid, Names: [`/${name}`], Image: image, Ports: ports,
  Labels: project ? { 'com.docker.compose.project': project, 'com.docker.compose.service': service } : {},
});

// The layout of a real host: Pi-hole and RaPiSys on the host network, two
// Compose apps publishing ports through docker-proxy, plus plain host daemons.
const containers = [
  container(id('a'), 'pihole', 'pihole/pihole:latest'),
  container(id('b'), 'rapisys', 'rapisys:latest', 'rapisys', 'rapisys'),
  container(id('c'), 'ankhor-backend-1', 'ankhor-backend', 'ankhor', 'backend',
    [{ PrivatePort: 8443, PublicPort: 8443, Type: 'tcp' }, { PrivatePort: 8000, Type: 'tcp' }]),
  container(id('d'), 'papyrusiq-caddy-1', 'caddy:2', 'papyrusiq', 'caddy',
    [{ PrivatePort: 80, PublicPort: 80, Type: 'tcp' }, { PrivatePort: 443, PublicPort: 9443, Type: 'tcp' }]),
  container(id('e'), 'papyrusiq-syncthing-1', 'syncthing/syncthing:1.27', 'papyrusiq', 'syncthing',
    [{ PrivatePort: 22000, PublicPort: 22000, Type: 'tcp' }]),
];
const listeners = [
  { port: 22, address: '0.0.0.0', process: 'sshd', pid: 10, containerId: null },
  { port: 53, address: '0.0.0.0', process: 'pihole-FTL', pid: 20, containerId: id('a') },
  { port: 8080, address: '0.0.0.0', process: 'pihole-FTL', pid: 20, containerId: id('a') },
  { port: 3001, address: '*', process: 'node', pid: 30, containerId: id('b') },
  { port: 3443, address: '*', process: 'node', pid: 30, containerId: id('b') },
  { port: 80, address: '0.0.0.0', process: 'docker-proxy', pid: 40, containerId: null },
  { port: 9443, address: '0.0.0.0', process: 'docker-proxy', pid: 41, containerId: null },
  { port: 8443, address: '0.0.0.0', process: 'docker-proxy', pid: 42, containerId: null },
  { port: 8086, address: '*', process: 'influxd', pid: 50, containerId: null },
  { port: 111, address: '0.0.0.0', process: 'rpcbind', pid: 60, containerId: null },
  { port: 4000, address: '0.0.0.0', process: 'node', pid: 70, containerId: null },
];

describe('identifyPorts', () => {
  const r = identifyPorts({ listeners, containers });
  const pick = (port) => { const x = r.get(port); return x && { name: x.name, icon: x.icon, checkType: x.checkType }; };

  it('names a host-network container by its image, one name per role', () => {
    expect(pick(53)).toEqual({ name: 'Pi-hole DNS', icon: 'shield', checkType: 'dns' });
    expect(pick(8080)).toEqual({ name: 'Pi-hole Admin', icon: 'shield', checkType: 'http' });
    expect(r.get(8080).path).toBe('/admin/');
    expect(r.get(53).owner).toBe('process pihole-FTL · container pihole · image pihole');
  });

  it('names RaPiSys and its HTTPS port', () => {
    expect(pick(3001)).toEqual({ name: 'RaPiSys', icon: 'activity', checkType: 'http' });
    expect(pick(3443)).toEqual({ name: 'RaPiSys HTTPS', icon: 'lock', checkType: 'https' });
  });

  it('names a published port after its Compose project, capitalised', () => {
    expect(pick(8443)).toEqual({ name: 'Ankhor', icon: 'box', checkType: 'https' });
    expect(r.get(8443).owner).toBe('container ankhor-backend-1 · image ankhor-backend');
  });

  it('tells apart two ports of one container, using the container port for TLS', () => {
    expect(pick(80)).toEqual({ name: 'Papyrusiq', icon: 'box', checkType: 'http' });
    expect(pick(9443)).toEqual({ name: 'Papyrusiq HTTPS', icon: 'lock', checkType: 'https' });
  });

  it('names a second container of a project after a known image', () => {
    expect(pick(22000)).toEqual({ name: 'Syncthing', icon: 'refresh-cw', checkType: 'tcp' });
  });

  it('leaves ports without an identifiable application to the port-based guess', () => {
    expect(r.has(8086)).toBe(false);   // influxd: unknown process; the port guess "InfluxDB" stays
    expect(r.has(111)).toBe(false);
    expect(r.has(4000)).toBe(false);   // generic 'node' says nothing
  });

  it('names a known host process', () => {
    expect(pick(22)).toEqual({ name: 'SSH', icon: 'terminal', checkType: 'tcp' });
  });

  it('works from Docker alone when the agent is unavailable', () => {
    const only = identifyPorts({ listeners: [], containers });
    expect(only.get(8443).name).toBe('Ankhor');
    expect(only.has(53)).toBe(false);
  });

  it('adds the port when one app has two plain ports', () => {
    const two = identifyPorts({ containers: [container(id('f'), 'web-1', 'nginx', 'web', 'web',
      [{ PrivatePort: 80, PublicPort: 8081, Type: 'tcp' }, { PrivatePort: 81, PublicPort: 8082, Type: 'tcp' }])] });
    expect(two.get(8081).name).toBe('Web');
    expect(two.get(8082).name).toBe('Web :8082');
  });
});

describe('imageBase', () => {
  it('strips registry, namespace, tag and digest', () => {
    expect(imageBase('ghcr.io/home-assistant/home-assistant:stable')).toBe('home-assistant');
    expect(imageBase('pihole/pihole@sha256:abc')).toBe('pihole');
    expect(imageBase('rapisys')).toBe('rapisys');
  });
});

describe('agent ports.owners parsing', () => {
  it('parses ss -tlnpH lines, including IPv6 and lines without a process', () => {
    const out = parseListeners([
      'LISTEN 0      4096                                 0.0.0.0:9443       0.0.0.0:*    users:(("docker-proxy",pid=3254,fd=8))',
      'LISTEN 0      511                                        *:3443             *:*    users:(("node",pid=4179990,fd=22))',
      'LISTEN 0      4096                                    [::]:8443          [::]:*    users:(("docker-proxy",pid=2938,fd=8))',
      'LISTEN 0      128                                  0.0.0.0:22         0.0.0.0:*',
      'garbage',
    ].join('\n'));
    expect(out).toEqual([
      { port: 9443, address: '0.0.0.0', process: 'docker-proxy', pid: 3254 },
      { port: 3443, address: '*', process: 'node', pid: 4179990 },
      { port: 8443, address: '[::]', process: 'docker-proxy', pid: 2938 },
      { port: 22, address: '0.0.0.0', process: null, pid: null },
    ]);
  });

  it('reads the container id from a cgroup v2 path', () => {
    expect(containerIdFromCgroup(`0::/system.slice/docker-${id('5')}.scope\n`)).toBe(id('5'));
    expect(containerIdFromCgroup(`0::/docker/${id('6')}`)).toBe(id('6'));
    expect(containerIdFromCgroup('0::/system.slice/ssh.service')).toBeNull();
    expect(containerIdFromCgroup('')).toBeNull();
  });
});
