import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { termLineHtml, DB_PROGRESS_RE } from '../src/modules/term-log.js';

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
