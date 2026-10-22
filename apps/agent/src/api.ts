// Cliente HTTP do agente. Só conexões de saída para o servidor; nada é exposto na rede da loja.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export class AgentApi {
  private inflight = new Set<AbortController>();
  constructor(private baseUrl: string, private token: string, private version: string) {}

  // Cancela as requisições em andamento (ex.: long-poll) para o agente parar ou recarregar a configuração na hora.
  abortAll() {
    for (const c of this.inflight) c.abort();
  }

  private async req<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const ctrl = new AbortController();
    this.inflight.add(ctrl);
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          'user-agent': `RangassoAgent/${this.version}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new ApiError(0, 'network', `Sem conexão com o servidor: ${(e as Error).name === 'AbortError' ? 'tempo esgotado' : (e as Error).message}`);
    } finally {
      clearTimeout(t);
      this.inflight.delete(ctrl);
    }
    const data: any = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? `http_${res.status}`, data?.error?.message ?? `HTTP ${res.status}`);
    return data as T;
  }

  heartbeat(body: unknown) {
    return this.req<{ ok: boolean; serverTime: string; device: { name: string }; printer: ServerPrinterConfig }>('POST', '/api/agent/heartbeat', body);
  }

  jobs(waitSeconds: number) {
    return this.req<{ jobs: ServerJob[] }>('GET', `/api/agent/jobs?wait=${waitSeconds}`, undefined, (waitSeconds + 15) * 1000);
  }

  updateInfo() {
    return this.req<{ version: string | null; sha256?: string; size?: number }>('GET', '/api/agent/update');
  }

  async downloadUpdate(): Promise<Buffer> {
    const ctrl = new AbortController();
    this.inflight.add(ctrl);
    const t = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const res = await fetch(this.baseUrl + '/api/agent/update/agent.cjs', {
        headers: { authorization: `Bearer ${this.token}`, 'user-agent': `RangassoAgent/${this.version}` },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new ApiError(res.status, `http_${res.status}`, `Download da atualização falhou (HTTP ${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(t);
      this.inflight.delete(ctrl);
    }
  }

  report(jobId: string, status: string, detail: string) {
    return this.req<{ ok: boolean; status: string }>('POST', `/api/agent/jobs/${jobId}/status`, { status, detail: detail.slice(0, 500) });
  }
}

export interface ServerPrinterConfig { connection: 'usb' | 'network' | 'serial'; host: string; port: number; windowsName: string; columns: number; model: string }
export interface ServerJob { id: string; claimId: string; kind: 'original' | 'reprint' | 'test'; reprintNumber: number; copies: number; attempt: number; payload: any; createdAt: string }
