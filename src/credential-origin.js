import { fail } from './errors.js';

function mcpOrigin(connection) {
  return new URL(connection.config.url).origin;
}

export function assertMcpCredentialOriginBinding(registry, connection, credentialHandle = connection?.credentialHandle) {
  if (connection?.provider !== 'mcp') return;
  if (!credentialHandle || credentialHandle === 'none') return;

  const origin = mcpOrigin(connection);
  const reused = Object.values(registry.connections || {}).find((candidate) =>
    candidate.id !== connection.id &&
    candidate.provider === 'mcp' &&
    candidate.credentialHandle === credentialHandle &&
    mcpOrigin(candidate) !== origin
  );

  if (reused) {
    fail(
      'MCP_CREDENTIAL_REUSE_FORBIDDEN',
      'The same MCP bearer credential handle cannot be reused across different server origins',
      {
        connectionId: connection.id,
        conflictingConnectionId: reused.id,
        origin,
        conflictingOrigin: mcpOrigin(reused)
      }
    );
  }
}
