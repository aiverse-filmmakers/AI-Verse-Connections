import fs from 'node:fs/promises';
import path from 'node:path';
import { StateStore } from '../src/state-store.js';

const [home, mode] = process.argv.slice(2);
const store = new StateStore(home);

if (mode === 'hold') {
  await store.withLock(async () => {
    process.send?.({ type: 'acquired', pid: process.pid });
    await new Promise((resolve) => process.once('message', resolve));
  });
} else if (mode === 'bump') {
  await new Promise((resolve) => process.once('message', resolve));
  await store.withLock(async () => {
    const counterPath = path.join(home, 'counter.json');
    let value = 0;
    try { value = JSON.parse(await fs.readFile(counterPath, 'utf8')).value; }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fs.writeFile(counterPath, JSON.stringify({ value: value + 1 }));
  });
  process.send?.({ type: 'done' });
} else {
  throw new Error('unknown child mode');
}
