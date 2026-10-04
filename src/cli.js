import fs from 'node:fs/promises';
import { ConnectionsService } from './service.js';
import { ConnectionsError } from './errors.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    if (['json', 'approve', 'purge', 'allow-private-network', 'confirm'].includes(key)) flags[key] = true;
    else flags[key] = argv[++i];
  }
  return { positional, flags };
}

const split = (v) => v ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
const bool = (v) => v === true || v === 'true';

async function readStdin() {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

function output(value, json = false) {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  const { positional: p, flags: f } = parseArgs(argv);
  const service = new ConnectionsService();
  const cmd = p[0];
  let result;
  switch (cmd) {
    case 'install': result = await service.install(); break;
    case 'setup': result = await service.setup({ systemId: f.system }); break;
    case 'rebind-system': result = await service.rebindSystem({ fromSystemId: f['from-system'], systemId: f.system }); break;
    case 'status': result = await service.status(); break;
    case 'doctor': result = await service.doctor(); break;
    case 'enable': result = await service.enable(); break;
    case 'disable': result = await service.disable(); break;
    case 'update': result = await service.update(); break;
    case 'uninstall': result = await service.uninstall({ purge: bool(f.purge) }); break;
    case 'descriptor': result = await service.componentDescriptor(); break;
    case 'credential': {
      if (p[1] === 'put') result = await service.putCredential(p[2], await readStdin());
      else if (p[1] === 'delete') result = await service.deleteCredential(p[2]);
      else throw new ConnectionsError('USAGE', 'credential supports put <id> or delete <handle>');
      break;
    }
    case 'connection': {
      const sub = p[1];
      if (sub === 'list') result = await service.listConnections();
      else if (sub === 'add-generic') result = await service.addGeneric({
        id: f.id, systemId: f.system, workspaceIds: split(f.workspaces), credentialHandle: f.credential || 'none',
        authorization: f.auth === 'bearer' ? { type: 'bearer' } : f.auth === 'header' ? { type: 'header', headerName: f['header-name'] } : { type: 'none' },
        config: { baseUrl: f.url, allowedMethods: split(f.methods || 'GET'), allowedPathPrefixes: split(f.paths || '/'), healthPath: f['health-path'] || '/', healthMethod: f['health-method'] || 'HEAD' },
        limits: { allowPrivateNetwork: bool(f['allow-private-network']) }, risk: f.risk || 'write'
      });
      else if (sub === 'add-mcp') result = await service.addMcp({
        id: f.id, systemId: f.system, workspaceIds: split(f.workspaces), credentialHandle: f.credential || 'none',
        authorization: f.auth === 'bearer' ? { type: 'bearer', resource: f.resource || f.url, issuer: f.issuer || null } : { type: 'none' }, config: { url: f.url },
        limits: { allowPrivateNetwork: bool(f['allow-private-network']) }
      });
      else if (sub === 'verify') result = await service.verify(p[2]);
      else if (sub === 'admit') result = await service.admitCapability(p[2], { sourceName: p[3], capability: f.capability, risk: f.risk || 'write' });
      else if (sub === 'approve') result = await service.approveConnection(p[2]);
      else if (sub === 'revoke') result = await service.revoke(p[2]);
      else if (sub === 'reauth') result = await service.reauth(p[2], f.credential);
      else if (sub === 'reconcile') result = await service.reconcileExternalEffect(p[2], {
        executionId: f['execution-id'], resolution: f.resolution, operatorConfirmed: bool(f.confirm),
        note: f.note, actor: f.actor || 'cli-operator'
      });
      else if (sub === 'execute') result = await service.execute(p[2], {
        capability: f.capability, systemId: f.system, workspaceId: f.workspace, actor: f.actor || 'cli',
        grantedCapabilities: split(f.grants || f.capability), idempotencyKey: f['idempotency-key'], approval: { approved: bool(f.approve) },
        input: f['input-file'] ? JSON.parse(await fs.readFile(f['input-file'], 'utf8')) : JSON.parse(f.input || '{}')
      });
      else throw new ConnectionsError('USAGE', 'Unknown connection subcommand');
      break;
    }
    default:
      throw new ConnectionsError('USAGE', 'Usage: aiverse-connections <install|setup|rebind-system|status|doctor|enable|disable|update|uninstall|descriptor|credential|connection>');
  }
  output(result, bool(f.json));
}

export function formatCliError(err) {
  const code = err instanceof ConnectionsError ? err.code : 'UNEXPECTED_ERROR';
  if (code === 'MCP_RPC_ERROR') {
    const providerCode = Number.isSafeInteger(err?.details?.providerCode) ? err.details.providerCode : null;
    return { ok: false, error: code, message: 'MCP provider returned an RPC error', details: { providerCode } };
  }
  return { ok: false, error: code, message: err.message, details: err.details };
}

export async function runCli() {
  try { await main(); }
  catch (err) {
    process.stderr.write(`${JSON.stringify(formatCliError(err))}\n`);
    process.exitCode = err instanceof ConnectionsError ? 2 : 1;
  }
}
