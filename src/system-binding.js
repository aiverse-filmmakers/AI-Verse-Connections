import { fail } from './errors.js';

export function installationSystemId(lifecycle) {
  const systemId = lifecycle?.systemId;
  if (typeof systemId !== 'string' || !systemId) {
    fail('SYSTEM_BINDING_REQUIRED', 'Connections installation is not bound to an AI-Verse system');
  }
  return systemId;
}

export function assertInstallationSystem(lifecycle, systemId, { subject = 'Connection' } = {}) {
  const boundSystemId = installationSystemId(lifecycle);
  if (systemId !== boundSystemId) {
    fail('SYSTEM_BINDING_MISMATCH', `${subject} system scope does not match the Connections installation binding`, {
      installationSystemId: boundSystemId,
      observedSystemId: systemId ?? null
    });
  }
  return boundSystemId;
}
