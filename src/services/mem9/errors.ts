export class Mem9Error extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "Mem9Error";
  }
}

export class Mem9Unavailable extends Mem9Error {
  constructor(url: string, cause?: unknown) {
    super(`mem9 server at ${url} is unreachable`, cause);
    this.name = "Mem9Unavailable";
  }
}

export class Mem9AuthError extends Mem9Error {
  constructor(cause?: unknown) {
    super("mem9 authentication failed — check MEM9_API_KEY", cause);
    this.name = "Mem9AuthError";
  }
}

export class Mem9NotFound extends Mem9Error {
  constructor(id: string) {
    super(`mem9 memory not found: ${id}`);
    this.name = "Mem9NotFound";
  }
}

export class Mem9BadRequest extends Mem9Error {
  constructor(message: string, public readonly body?: string) {
    super(`mem9 bad request: ${message}`);
    this.name = "Mem9BadRequest";
  }
}
