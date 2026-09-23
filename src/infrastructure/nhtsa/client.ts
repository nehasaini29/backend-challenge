import { setTimeout as delay } from 'node:timers/promises';
import { Logger } from 'pino';
import { Config } from '../../config';
import { idSchema, VehicleSource } from '../../domain/vehicle/model';
import { parseMakes, parseVehicleTypes } from '../../domain/vehicle/transform';

class UpstreamError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}
export class NhtsaClient implements VehicleSource {
  constructor(private readonly config: Config, private readonly logger: Logger,
    private readonly fetcher: typeof fetch = fetch,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> =
      (ms, signal) => delay(ms, undefined, { signal })) {}

  private async xml(path: string, signal?: AbortSignal): Promise<string> {
    const url = new URL(path, this.config.NHTSA_BASE_URL);
    url.searchParams.set('format', 'xml');
    for (let attempt = 1; attempt <= this.config.HTTP_MAX_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      try {
        const timeout = AbortSignal.timeout(this.config.HTTP_TIMEOUT_MS);
        const response = await this.fetcher(url, { headers: { Accept: 'application/xml' },
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout, redirect: 'error' });
        if (!response.ok) {
          await response.body?.cancel();
          throw new UpstreamError(`Upstream HTTP ${response.status}`, response.status === 429 || response.status >= 500);
        }
        return await response.text();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        const retryable = !(error instanceof UpstreamError) || error.retryable;
        this.logger.warn({ event: 'upstream_request_failed', path, attempt, retryable,
          reason: error instanceof UpstreamError ? error.message : 'Network or timeout failure' });
        if (!retryable || attempt === this.config.HTTP_MAX_ATTEMPTS) throw new Error(`Upstream request failed: ${path}`);
        await this.sleep(Math.min(8000, 500 * 2 ** (attempt - 1)), signal);
      }
    }
    throw new Error('Unreachable retry state');
  }

  async getMakes(signal?: AbortSignal) { return parseMakes(await this.xml('getallmakes', signal)); }
  async getVehicleTypes(makeId: string, signal?: AbortSignal) {
    idSchema.parse(makeId);
    return parseVehicleTypes(await this.xml(`GetVehicleTypesForMakeId/${makeId}`, signal));
  }
}
