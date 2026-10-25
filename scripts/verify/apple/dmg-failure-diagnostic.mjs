// Synthetic macos-bundle verifier only. No production cleanup behavior changes.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

const errorKeys = new Set(['code', 'message', 'retryable', 'reason', 'resources',
  'details', 'diagnostics', 'cleanup', 'cleanup_error', 'primary_error', 'error']);
const projectError = (value, depth = 0) => {
  if (depth > 12) return { omitted: 'depth-limit' };
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(v => projectError(v, depth + 1));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).filter(([k]) => errorKeys.has(k))
    .map(([k, v]) => [k, projectError(v, depth + 1)]));
};
export function failureOutput(failure) {
  const stdout = typeof failure?.stdout === 'string' ? failure.stdout : '';
  const report = { bytes: Buffer.byteLength(stdout), sha256: createHash('sha256').update(stdout).digest('hex'),
    exit_code: typeof failure?.code === 'number' ? failure.code : null,
    signal: typeof failure?.signal === 'string' ? failure.signal : null,
    killed: failure?.killed === true, parse: 'empty' };
  if (stdout) {
    try {
      const value = JSON.parse(stdout);
      report.parse = 'json';
      report.error = projectError(value?.error ?? null);
    } catch { report.parse = 'invalid-or-truncated-json'; }
  }
  return report; // Never retain raw stdout/stderr, argv or environment.
}
export function ownedEntities(inventory, imagePath) {
  if (!Array.isArray(inventory?.images)) return [];
  const owned = inventory.images.filter(image => image?.['image-path'] === imagePath);
  if (owned.length !== 1) return [];
  return (owned[0]['system-entities'] ?? []).flatMap(entity => {
    const device = entity?.['dev-entry']; const mount = entity?.['mount-point'];
    if (typeof device !== 'string' || !/^\/dev\/disk\d+(?:s\d+)*$/.test(device)) return [];
    return [{ device, ...(typeof mount === 'string' ? { mount } : {}) }];
  });
}
export function processFields(output) {
  const rows = []; let current;
  for (const line of output.split('\n')) {
    if (/^p\d+$/.test(line)) { current = { pid: Number(line.slice(1)), fds: [] }; rows.push(current); }
    else if (current && line.startsWith('c')) current.command = line.slice(1);
    else if (current && /^f[\w-]+$/.test(line)) current.fds.push(line.slice(1));
  }
  return rows;
}
const run = (file, args, input) => spawnSync(file, args, { input, encoding: 'utf8', timeout: 2000,
  maxBuffer: 256 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } });

export async function collectDmgFailure({ failure, imagePath, temporaryRoot,
  execute = run, canonical = realpath }) {
  const started = Date.now();
  const report = { schema: 1, phase: 'after-cli-exit-before-fixture-finally',
    outcome: 'original-cli-failure', output: failureOutput(failure), devices: [], occupancy: [] };
  const finish = () => ({ ...report, elapsed_ms: Date.now() - started });
  const image = await canonical(imagePath); const tmp = await canonical(temporaryRoot);
  // Only the known synthetic fixture image is eligible, not a user-selected image.
  if (!image.startsWith(tmp + sep) || !/^rea-macos-bundle-[^/]+\/MacFixture\.dmg$/.test(image.slice(tmp.length + 1)))
    throw new Error('Diagnostic image is not the generated synthetic fixture');
  const info = execute('/usr/bin/hdiutil', ['info', '-plist']);
  if (info.status !== 0) { report.inventory = 'unavailable'; return finish(); }
  const converted = execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], info.stdout);
  if (converted.status !== 0) { report.inventory = 'unavailable'; return finish(); }
  let inventory;
  try { inventory = JSON.parse(converted.stdout); } catch { report.inventory = 'invalid'; return finish(); }
  const entities = ownedEntities(inventory, image);
  report.inventory = entities.length ? 'owned-image-observed' : 'owned-image-not-observed';
  report.devices = entities.map(({ device }) => device);
  const mounts = [...new Set(entities.flatMap(e => e.mount ? [e.mount] : []))];
  report.mounts_omitted_by_budget = Math.max(0, mounts.length - 4);
  for (const mount of mounts.slice(0, 4)) {
    let path;
    try { path = await canonical(mount); } catch { report.occupancy.push({ status: 'mount-unresolvable' }); continue; }
    if (!path.startsWith(tmp + sep) || !/^rea-dmg-[^/]+(?:\/|$)/.test(path.slice(tmp.length + 1))) {
      report.occupancy.push({ status: 'outside-owned-temporary-mount' }); continue;
    }
    const begin = Date.now(); const result = execute('/usr/sbin/lsof', ['-a', '+D', path, '-Fpcf']);
    report.occupancy.push({ mount: path, status: result.status === 0 ? 'observed' : result.status === 1 ? 'none-or-unavailable' : 'unavailable',
      exit_code: result.status, elapsed_ms: Date.now() - begin,
      processes: result.status === 0 ? processFields(result.stdout) : [] });
  }
  return finish();
}
export async function retainDmgFailure(options, outputPath) {
  // Diagnostic errors never replace the original verifier failure.
  let report;
  try { report = await collectDmgFailure(options); }
  catch { report = { schema: 1, phase: 'after-cli-exit-before-fixture-finally',
    collection_status: 'failed', output: failureOutput(options.failure) }; }
  try {
    await mkdir(dirname(resolve(outputPath)), { recursive: true });
    await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return true;
  } catch { return false; /* no retry or raw diagnostic error publication */ }
}
