import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConnectionsService } from '../src/service.js';
import { COMPONENT_ID } from '../src/constants.js';
import { OWNERSHIP_FILENAME } from '../src/state-store.js';
import { expectCode, tmpHome } from '../test-support/helpers.js';

async function exists(value) {
  try { await fs.lstat(value); return true; }
  catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

test('install refuses to claim an unrelated non-empty Connections home', async () => {
  const home = await tmpHome();
  const sentinel = path.join(home, 'unrelated.txt');
  await fs.writeFile(sentinel, 'must survive');

  const service = new ConnectionsService({ home, env: {} });
  await expectCode(service.install(), 'CONNECTIONS_HOME_NOT_OWNED');

  assert.equal(await fs.readFile(sentinel, 'utf8'), 'must survive');
  assert.equal(await exists(path.join(home, OWNERSHIP_FILENAME)), false);
});

test('install upgrades a recognizable legacy Connections home with exact ownership evidence', async () => {
  const home = await tmpHome();
  await fs.writeFile(path.join(home, 'lifecycle.json'), `${JSON.stringify({
    schemaVersion: 1,
    installed: true,
    setup: false,
    enabled: false,
    systemId: null,
    installedVersion: '0.1.0-beta.1',
    updatedAt: null
  }, null, 2)}\n`);

  const service = new ConnectionsService({ home, env: {} });
  await service.install();

  const marker = JSON.parse(await fs.readFile(path.join(home, OWNERSHIP_FILENAME), 'utf8'));
  assert.equal(marker.componentId, COMPONENT_ID);
  assert.equal(marker.rootRealpath, await fs.realpath(home));
});

test('purge fails closed when the ownership marker is missing', async () => {
  const home = await tmpHome();
  const service = new ConnectionsService({ home, env: {} });
  await service.install();
  const lifecycle = path.join(home, 'lifecycle.json');
  await fs.rm(path.join(home, OWNERSHIP_FILENAME));

  await expectCode(service.uninstall({ purge: true }), 'CONNECTIONS_HOME_NOT_OWNED');
  assert.equal(await exists(lifecycle), true);
});

test('purge rejects a wrong or foreign ownership marker', async () => {
  const home = await tmpHome();
  const service = new ConnectionsService({ home, env: {} });
  await service.install();
  const markerPath = path.join(home, OWNERSHIP_FILENAME);
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  marker.componentId = 'foreign-component';
  await fs.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`);

  await expectCode(service.uninstall({ purge: true }), 'CONNECTIONS_HOME_OWNERSHIP_INVALID');
  assert.equal(await exists(path.join(home, 'lifecycle.json')), true);
});

test('copied ownership evidence cannot authorize a different real root', async () => {
  const sourceHome = await tmpHome();
  const source = new ConnectionsService({ home: sourceHome, env: {} });
  await source.install();
  const copiedMarker = await fs.readFile(path.join(sourceHome, OWNERSHIP_FILENAME), 'utf8');

  const targetHome = await tmpHome();
  const sentinel = path.join(targetHome, 'sentinel.txt');
  await fs.writeFile(sentinel, 'must survive');
  await fs.writeFile(path.join(targetHome, OWNERSHIP_FILENAME), copiedMarker);

  const target = new ConnectionsService({ home: targetHome, env: {} });
  await expectCode(target.uninstall({ purge: true }), 'CONNECTIONS_HOME_OWNERSHIP_INVALID');
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'must survive');
});

test('purge refuses filesystem root, user home, user-home parent and temp root', async () => {
  const candidates = new Set([
    path.parse(path.resolve(os.homedir())).root,
    os.homedir(),
    path.dirname(os.homedir()),
    os.tmpdir()
  ]);
  for (const home of candidates) {
    const service = new ConnectionsService({ home, env: {} });
    await expectCode(service.uninstall({ purge: true }), 'UNSAFE_CONNECTIONS_HOME');
  }
});

test('safe custom owned purge removes Connections-owned state and the empty root', async () => {
  const home = await tmpHome();
  const service = new ConnectionsService({ home, env: {} });
  await service.install();
  await service.setup({ systemId: 'sys-a' });

  const result = await service.uninstall({ purge: true });
  assert.equal(result.purged, true);
  assert.equal(result.rootRemoved, true);
  assert.deepEqual(result.preservedEntries, []);
  assert.equal(await exists(home), false);
});

test('bounded purge preserves unknown user data instead of recursively erasing the root', async () => {
  const home = await tmpHome();
  const service = new ConnectionsService({ home, env: {} });
  await service.install();
  const sentinel = path.join(home, 'keep-me.txt');
  await fs.writeFile(sentinel, 'unowned data');

  const result = await service.uninstall({ purge: true });
  assert.equal(result.rootRemoved, false);
  assert.deepEqual(result.preservedEntries, ['keep-me.txt']);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unowned data');
  assert.equal(await exists(path.join(home, 'lifecycle.json')), false);
  assert.equal(await exists(path.join(home, OWNERSHIP_FILENAME)), false);
});

test('purge rejects an exact Connections home symlink or Windows junction', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'aiverse-connections-link-'));
  const realHome = path.join(base, 'real-home');
  const linkedHome = path.join(base, 'linked-home');
  await fs.mkdir(realHome);
  const sentinel = path.join(realHome, 'sentinel.txt');
  await fs.writeFile(sentinel, 'must survive');
  await fs.symlink(realHome, linkedHome, process.platform === 'win32' ? 'junction' : 'dir');

  const service = new ConnectionsService({ home: linkedHome, env: {} });
  await expectCode(service.uninstall({ purge: true }), 'UNSAFE_CONNECTIONS_HOME');
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'must survive');
});
