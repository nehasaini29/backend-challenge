import { Logger } from 'pino';
import { SnapshotWriter, VehicleMake, VehicleSource } from '../domain/vehicle/model';
import { combineMake } from '../domain/vehicle/transform';

export class IngestionService {
  constructor(
    private readonly source: VehicleSource,
    private readonly store: SnapshotWriter,
    private readonly concurrency: number,
    private readonly logger: Logger,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('Invalid ingestion concurrency');
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    const started = Date.now();
    try {
      this.logger.info({ event: 'ingestion_started' });
      const makes = await this.source.getMakes(signal);
      if (makes.length === 0) {
        throw new Error('Refusing empty snapshot');
      }

      const data: VehicleMake[] = new Array(makes.length);
      const controller = new AbortController();
      const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let next = 0;
      const workers = Array.from({ length: Math.min(this.concurrency, makes.length) }, async () => {
        try {
          while (next < makes.length) {
            workSignal.throwIfAborted();
            const index = next++;
            const make = makes[index]!;
            data[index] = combineMake(make, await this.source.getVehicleTypes(make.makeId, workSignal));
          }
        } catch (error) {
          controller.abort(error);
          throw error;
        }
      });

      // Let cancelled workers finish before reporting a failed import.
      const outcomes = await Promise.allSettled(workers);
      const failure = outcomes.find(outcome => outcome.status === 'rejected');
      if (failure?.status === 'rejected') {
        throw failure.reason;
      }

      workSignal.throwIfAborted();
      await this.store.replace(data);
      this.logger.info({ event: 'ingestion_completed', makeCount: data.length, durationMs: Date.now() - started });
    } catch (error) {
      this.logger.error({ event: 'ingestion_failed', err: error, durationMs: Date.now() - started });
      throw error;
    }
  }
}
