/** RaPiSys — upgrade plan details for the confirm card.
 *
 * The confirm card lists every package a selected upgrade will change and lets
 * each row expand to its summary, "required by" and changelog. The server
 * parses the apt dry run, reads candidate records via `apt-cache show`, and
 * infers why each extra package is in the plan.
 */
import { describe, it, expect } from 'vitest';
import { parseAptPlan, parseAptCacheShow, describePlan } from '../server/collectors/updates.js';

const PLAN = `Reading package lists...
Building dependency tree...
The following packages will be upgraded:
  containerd.io docker-ce docker-ce-cli
Inst docker-ce-cli [5:28.3.2-1~debian.13~trixie] (5:28.4.0-1~debian.13~trixie Docker CE:trixie [arm64])
Inst docker-ce [5:28.3.2-1~debian.13~trixie] (5:28.4.0-1~debian.13~trixie Docker CE:trixie [arm64])
Inst containerd.io [1.7.27-1] (1.7.28-1 Docker CE:trixie [arm64])
Inst docker-model-plugin (0.1.40-1~debian.13~trixie Docker CE:trixie [arm64])
Remv old-thing [1.0-1]
Conf docker-ce-cli (5:28.4.0-1~debian.13~trixie Docker CE:trixie [arm64])
`;

const SHOW = `Package: docker-ce
Version: 5:28.4.0-1~debian.13~trixie
Pre-Depends: init-system-helpers (>= 1.54~)
Depends: containerd.io (>= 1.7.27), docker-ce-cli, iptables, libseccomp2 (>= 2.3.0)
Recommends: docker-model-plugin, git, pigz
Description: Docker: the open-source application container engine
 Docker is a product for you to build, ship and run any application.
 .
 Longer text here.

Package: docker-ce-cli
Version: 5:28.4.0-1~debian.13~trixie
Depends: libc6 (>= 2.34)
Description: Docker CLI: the open-source application container engine

Package: containerd.io
Version: 1.7.28-1
Depends: libc6 (>= 2.34), libseccomp2:any (>= 2.5.0) | libseccomp-dev
Description: An open and reliable container runtime

Package: docker-model-plugin
Version: 0.1.40-1~debian.13~trixie
Description-en: Docker Model Runner plugin
`;

describe('parseAptPlan', () => {
  it('reads upgrades, new installs and removals with versions', () => {
    const p = parseAptPlan(PLAN);
    expect(p).toEqual([
      { name: 'docker-ce-cli', action: 'upgrade', from: '5:28.3.2-1~debian.13~trixie', to: '5:28.4.0-1~debian.13~trixie' },
      { name: 'docker-ce', action: 'upgrade', from: '5:28.3.2-1~debian.13~trixie', to: '5:28.4.0-1~debian.13~trixie' },
      { name: 'containerd.io', action: 'upgrade', from: '1.7.27-1', to: '1.7.28-1' },
      { name: 'docker-model-plugin', action: 'install', from: null, to: '0.1.40-1~debian.13~trixie' },
      { name: 'old-thing', action: 'remove', from: '1.0-1', to: null },
    ]);
  });
  it('ignores Conf lines and empty input', () => {
    expect(parseAptPlan('')).toEqual([]);
    expect(parseAptPlan('Conf foo (1.0 Debian [arm64])')).toEqual([]);
  });
});

describe('parseAptCacheShow', () => {
  const info = parseAptCacheShow(SHOW);
  it('keeps only the one-line summary, not the long description', () => {
    expect(info['docker-ce'].summary).toBe('Docker: the open-source application container engine');
    expect(info['docker-model-plugin'].summary).toBe('Docker Model Runner plugin');
  });
  it('merges Depends and Pre-Depends, stripping versions, arch qualifiers and alternatives', () => {
    expect([...info['docker-ce'].depends]).toEqual(['containerd.io', 'docker-ce-cli', 'iptables', 'libseccomp2', 'init-system-helpers']);
    expect([...info['containerd.io'].depends]).toEqual(['libc6', 'libseccomp2', 'libseccomp-dev']);
    expect(info['docker-ce'].recommends.has('docker-model-plugin')).toBe(true);
  });
  it('keeps the first stanza when a package appears twice', () => {
    const twice = parseAptCacheShow('Package: a\nVersion: 2\nDescription: new\n\nPackage: a\nVersion: 1\nDescription: old\n');
    expect(twice.a.summary).toBe('new');
  });
});

describe('describePlan', () => {
  const d = describePlan(parseAptPlan(PLAN), parseAptCacheShow(SHOW), ['docker-ce']);
  const by = Object.fromEntries(d.map((x) => [x.name, x]));
  it('attaches summaries', () => {
    expect(by['containerd.io'].summary).toBe('An open and reliable container runtime');
    expect(by['old-thing'].summary).toBeNull();
  });
  it('names the plan packages that pull each extra in, hard dependencies before recommends', () => {
    expect(by['docker-ce-cli'].requiredBy).toEqual([{ name: 'docker-ce', recommends: false }]);
    expect(by['containerd.io'].requiredBy).toEqual([{ name: 'docker-ce', recommends: false }]);
    expect(by['docker-model-plugin'].requiredBy).toEqual([{ name: 'docker-ce', recommends: true }]);
  });
  it('leaves selected and removed packages without a reason', () => {
    expect(by['docker-ce'].requiredBy).toEqual([]);
    expect(by['old-thing'].requiredBy).toEqual([]);
  });
  it('still returns the plan when package info is unavailable', () => {
    const bare = describePlan(parseAptPlan(PLAN), {}, ['docker-ce']);
    expect(bare).toHaveLength(5);
    expect(bare.every((x) => x.summary === null && x.requiredBy.length === 0)).toBe(true);
  });
});
