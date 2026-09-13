export class ConnectionsError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ConnectionsError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details) {
  throw new ConnectionsError(code, message, details);
}
