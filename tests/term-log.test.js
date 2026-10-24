import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { termLineHtml, DB_PROGRESS_RE, dockerEvent, layerRowHtml, pulledHtml, containerHtml } from '../src/modules/term-log.js';

const require = createRequire(import.meta.url);
process.env.AGENT_SECRET = 'test-secret-not-used-for-any-real-hmac';
const { createLineSplitter } = require('../agent/rapisys-agent.cjs');

describe('agent line splitter', () => {
  it('rejoins a line split across chunks', () => {
    const lines = [];
    const s = createLineSplitter((l) => lines.push(l));
    s.push('(Reading database ... ');
    s.push('75%\rUnpacking x (1) ...\n');
    s.end();
    expect(lines).toEqual(['(Reading database ... 75%', 'Unpacking x (1) ...']);
  });

  it('treats \\r as a line end and \\r\\n as one break', () => {
    const lines = [];
    const s = createLineSplitter((l) => lines.push(l));
    s.push('a\r\nb\r');
    s.push('\nc');
    s.end();
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('flushes a trailing partial line after the idle delay', () => {
    vi.useFakeTimers();
    const lines = [];
    const s = createLineSplitter((l) => lines.push(l), 1500);
    s.push('*** influxdb.conf (Y/I/N/O/D/Z) [default=N] ? ');
    expect(lines).toEqual([]);
    vi.advanceTimersByTime(1500);
    expect(lines).toEqual(['*** influxdb.conf (Y/I/N/O/D/Z) [default=N] ? ']);
    vi.useRealTimers();
  });
});

describe('terminal line colouring', () => {
  it('recognises dpkg database progress redraws', () => {
    expect('(Reading database ... 45%'.match(DB_PROGRESS_RE)[1]).toBe('45');
    expect(DB_PROGRESS_RE.test('(Reading database ... 165558 files and directories currently installed.)')).toBe(false);
    expect(DB_PROGRESS_RE.test('(Reading database ... ')).toBe(true);
  });

  it('colours unpack and setup lines with name and versions', () => {
    const u = termLineHtml('Unpacking influxdb (1.13.1-1) over (1.12.4-1) ...');
    expect(u).toContain('t-yellow');
    expect(u).toContain('<span class="t-b">influxdb</span>');
    expect(u).toContain('<span class="t-green">1.13.1-1</span>');
    expect(u).toContain('over 1.12.4-1');
    expect(termLineHtml('Setting up libcap2-bin (1:2.75-10+deb13u1+b3) ...')).toContain('t-green t-tag');
  });

  it('marks package-list members by section and resets after it', () => {
    const st = {};
    termLineHtml('The following packages will be REMOVED:', st);
    expect(termLineHtml('  tailscale', st)).toContain('t-pkg-rm');
    termLineHtml('0 upgraded, 0 newly installed, 1 to remove and 3 not upgraded.', st);
    expect(st.list).toBe(null);
  });

  it('opens and closes the conffile notice block', () => {
    const st = {};
    termLineHtml("Configuration file '/etc/influxdb/influxdb.conf'", st);
    expect(st.block).toBe(true);
    expect(termLineHtml(' ==> Keeping old config file as default.', st)).toContain('t-green');
    expect(st.blockEnd).toBe(true);
  });

  it('flags errors and warnings, and escapes HTML', () => {
    expect(termLineHtml('E: Could not get lock /var/lib/dpkg/lock-frontend')).toContain('t-red');
    expect(termLineHtml('W: something')).toContain('t-orange');
    expect(termLineHtml('Failed to open connection to "session" message bus: Unable to')).toContain('t-red');
    expect(termLineHtml('rpi-connect: error: something broke')).toContain('t-red');
    expect(termLineHtml('This allows users who are not logged in to run long-running')).not.toContain('t-red');
    expect(termLineHtml('<script>x</script>')).toBe('&lt;script&gt;x&lt;/script&gt;');
  });

  it('splits a Get: line into its parts', () => {
    const h = termLineHtml('Get:1 https://repos.influxdata.com/debian stable/main arm64 influxdb arm64 1.13.1-1 [47.2 MB]');
    expect(h).toContain('<span class="t-cyan">Get:1</span>');
    expect(h).toContain('<span class="t-b">influxdb</span>');
    expect(h).toContain('<span class="t-green">1.13.1-1</span>');
  });
});

describe('docker output', () => {
  it('recognises compose pull, layer, container and RaPiSys step lines', () => {
    expect(dockerEvent('Pulling latest image…')).toEqual({ type: 'step', text: 'Pulling latest image…' });
    expect(dockerEvent(' Image pihole/pihole:latest Pulling ')).toEqual({ type: 'pullStart', image: 'pihole/pihole:latest' });
    expect(dockerEvent(' 9efb78552436 Downloading 3.146MB')).toEqual({ type: 'layer', id: '9efb78552436', state: 'dl', size: '3.146MB', total: null });
    expect(dockerEvent(' 9efb78552436 Pulling fs layer 0B')).toMatchObject({ state: 'wait' });
    expect(dockerEvent(' 44136fa355b3 Already exists 0B')).toMatchObject({ state: 'have' });
    expect(dockerEvent(' a9986cd6f37d Extracting 1B')).toMatchObject({ state: 'ex' });
    expect(dockerEvent(' a9986cd6f37d Pull complete 0B')).toMatchObject({ state: 'ok' });
    expect(dockerEvent(' Image pihole/pihole:latest Pulled ')).toEqual({ type: 'pulled', image: 'pihole/pihole:latest' });
    expect(dockerEvent(' Container pihole Recreated ')).toEqual({ type: 'container', name: 'pihole', action: 'Recreated' });
  });
  it('recognises plain docker pull output, with its download fraction', () => {
    expect(dockerEvent('latest: Pulling from pihole/pihole')).toEqual({ type: 'pullStart', image: 'pihole/pihole' });
    expect(dockerEvent('9efb78552436: Downloading [=====>    ]  1.2MB/12MB')).toMatchObject({ state: 'dl', size: '1.2MB', total: '12MB' });
    expect(dockerEvent('Status: Downloaded newer image for pihole/pihole:latest')).toEqual({ type: 'pulled', image: 'pihole/pihole:latest' });
  });
  it('leaves apt and dpkg lines alone', () => {
    for (const l of ['Reading package lists...', 'Unpacking curl (8.14.1-2) over (8.14.1-1) ...', 'Setting up docker-ce (5:29.9.2-1~debian.13~trixie) ...', 'E: Could not get lock']) {
      expect(dockerEvent(l)).toBeNull();
    }
  });
  it('renders layer rows, the pull summary and container tags', () => {
    expect(layerRowHtml({ id: '9efb78552436', state: 'dl', size: '11.53MB', total: null })).toContain('<span class="t-meter t-indet">');
    expect(layerRowHtml({ id: '9efb78552436', state: 'dl', size: '1.2MB', total: '12MB' })).toContain('width:10%');
    expect(layerRowHtml({ id: '9efb78552436', state: 'ok' })).toContain('✓ done');
    expect(pulledHtml('pihole/pihole:latest', 14, 1)).toContain('13 layers downloaded, 1 already present');
    expect(pulledHtml('x', 0, 0)).toContain('up to date');
    expect(containerHtml({ name: 'pihole', action: 'Starting' })).toContain('t-yellow');
    expect(containerHtml({ name: 'pihole', action: 'Started' })).toContain('t-green');
    expect(containerHtml({ name: '<b>', action: 'Started' })).toContain('&lt;b&gt;');
  });
});
