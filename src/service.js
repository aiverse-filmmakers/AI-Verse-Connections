import { StateStore } from './state-store.js';
import { CredentialManager } from './credentials.js';
import { GenericApiAdapter } from './providers/generic-api.js';
import { McpAdapter } from './providers/mcp.js';
import * as lifecycle from './service-lifecycle.js';
import * as registry from './service-registry.js';
import * as admission from './service-admission.js';
import * as execution from './service-execute.js';

export class ConnectionsService {
  constructor({ home, env, hooks = {} } = {}) {
    this.store = new StateStore(home);
    this.credentials = new CredentialManager(this.store, env || process.env);
    this.adapters = {
      'generic-api': new GenericApiAdapter(this.credentials),
      mcp: new McpAdapter(this.credentials)
    };
    this.hooks = hooks;
  }
}

Object.assign(ConnectionsService.prototype, lifecycle, registry, admission, execution);
