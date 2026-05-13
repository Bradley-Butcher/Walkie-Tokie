export class RelayHttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "RelayHttpError";
    this.status = status;
    this.code = code;
  }
}

export class RelayHttpClient {
  readonly baseUrl: string;
  readonly token?: string;

  constructor(
    baseUrl = process.env.WALKIE_TOKIE_URL ?? "http://127.0.0.1:8787",
    token = process.env.WALKIE_TOKIE_TOKEN,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  async get(path: string): Promise<unknown> {
    return await this.request("GET", path);
  }

  async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    return await this.request("POST", path, stripUndefined(body));
  }

  private async request(method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: requestHeaders(body !== undefined, this.token),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new RelayHttpError(
        0,
        `Could not reach Walkie Tokie relay at ${this.baseUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const text = await response.text();
    const parsed = parseJson(text);

    if (!response.ok) {
      const error = readRelayError(parsed);
      throw new RelayHttpError(response.status, error.message, error.code);
    }

    return parsed;
  }
}

function requestHeaders(hasBody: boolean, token: string | undefined): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (hasBody) {
    headers["content-type"] = "application/json";
  }
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function parseJson(text: string): unknown {
  if (text.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function readRelayError(value: unknown): { code?: string; message: string } {
  if (typeof value !== "object" || value === null) {
    return { message: String(value) };
  }

  const error = (value as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) {
    return { message: JSON.stringify(value) };
  }

  const record = error as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    message: typeof record.message === "string" ? record.message : JSON.stringify(error),
  };
}

function stripUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
