import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConnectionsService } from '../src/service.js';
import { expectCode, tmpHome } from '../test-support/helpers.js';

test('purge refuses an unrelated non-empty directory without Connections ownership', async () => {
  const home = await tmpHome();
  const sentinel = path.join(home, 'unrelated.txt');
  await fs.writeFile(sentinel, 'must survive');

  const service = new ConnectionsService({ home, env: {} });
  await expectCode(service.uninstall({ purge: true }), 'CONNECTIONS_HOME_NOT_OWNED');
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'must survive');
});
