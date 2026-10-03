import { ConnectionsService } from '../src/service.js';

const [home, mode, connectionId, capability, providerUrl] = process.argv.slice(2);
const service = new ConnectionsService({ home, env: {} });
const request = {
  capability,
  systemId: 'sys-a',
  workspaceId: 'ws-a',
  actor: 'crash-test',
  grantedCapabilities: [capability],
  approval: { approved: true },
  idempotencyKey: 'crash-boundary-1',
  input: { method: 'POST', path: '/v1/write', body: { value: 1 } }
};

if (mode === 'before-provider') {
  service.hooks.beforeFinalEdge = async () => {
    process.send?.({ type: 'reserved', pid: process.pid });
    await new Promise((resolve) => process.once('message', resolve));
    process.exit(97);
  };
} else if (mode === 'after-budget-reservation') {
  service.hooks.afterBudgetReservation = async ({ executionId }) => {
    process.send?.({ type: 'budget-reserved', executionId });
    await new Promise((resolve) => process.once('message', resolve));
    process.exit(97);
  };
} else if (mode === 'after-edge') {
  service.hooks.afterProviderEdge = async ({ executionId }) => {
    process.send?.({ type: 'edge', executionId }, () => process.exit(97));
    await new Promise(() => {});
  };
} else if (mode === 'after-provider-response') {
  service.hooks.afterProviderResponse = async ({ executionId }) => {
    process.send?.({ type: 'provider-response', executionId }, () => process.exit(97));
    await new Promise(() => {});
  };
} else {
  throw new Error('unknown external-effect child mode');
}

await service.execute(connectionId, request);
process.send?.({ type: 'unexpected-completion' });
process.exit(98);
