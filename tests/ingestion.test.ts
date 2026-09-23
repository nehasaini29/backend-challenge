import pino from 'pino';
import { IngestionService } from '../src/services/ingestion';
import { SnapshotWriter, VehicleMake, VehicleSource } from '../src/domain/vehicle/model';
const logger = pino({ level: 'silent' });
function setup() {
  const source: jest.Mocked<VehicleSource> = { getMakes: jest.fn(), getVehicleTypes: jest.fn() };
  const replace = jest.fn<Promise<void>, [VehicleMake[]]>().mockResolvedValue(undefined);
  const store: SnapshotWriter = { replace };
  return { source, replace, store, service: new IngestionService(source, store, 2, logger) };
}
test('bounds concurrency and persists a complete deterministic snapshot', async () => {
  const { source, replace, service } = setup();
  source.getMakes.mockResolvedValue(Array.from({ length: 6 }, (_, i) => ({ makeId: String(i + 1), makeName: `Make ${i}` })));
  let active = 0; let maxActive = 0;
  source.getVehicleTypes.mockImplementation(async () => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return [];
  });
  await expect(service.run()).resolves.toBeUndefined();
  expect(maxActive).toBe(2);
  expect(replace).toHaveBeenCalledTimes(1);
  expect(replace.mock.calls[0]![0]).toHaveLength(6);
});
test('a failed type request leaves the existing snapshot untouched', async () => {
  const { source, replace, service } = setup();
  source.getMakes.mockResolvedValue([{ makeId: '1', makeName: 'A' }, { makeId: '2', makeName: 'B' }]);
  source.getVehicleTypes.mockRejectedValue(new Error('offline'));
  await expect(service.run()).rejects.toThrow('offline');
  expect(replace).not.toHaveBeenCalled();
});
test('empty and invalid source data cannot be persisted', async () => {
  const { source, replace, service } = setup();
  source.getMakes.mockResolvedValueOnce([]).mockResolvedValueOnce([{ makeId: '0', makeName: '' }]);
  await expect(service.run()).rejects.toThrow('empty snapshot');
  source.getVehicleTypes.mockResolvedValue([]);
  await expect(service.run()).rejects.toThrow('Invalid combined');
  expect(replace).not.toHaveBeenCalled();
});
test('insertion errors propagate', async () => {
  const { source, store, service } = setup();
  source.getMakes.mockResolvedValue([{ makeId: '1', makeName: 'A' }]);
  source.getVehicleTypes.mockResolvedValue([]);
  store.replace = async () => { throw new Error('database unavailable'); };
  await expect(service.run()).rejects.toThrow('database unavailable');
});
test('cancellation prevents publication', async () => {
  const { source, replace, service } = setup();
  source.getMakes.mockResolvedValue([{ makeId: '1', makeName: 'A' }]);
  const abort = new AbortController(); abort.abort(new Error('stop'));
  await expect(service.run(abort.signal)).rejects.toThrow('stop');
  expect(replace).not.toHaveBeenCalled();
});
