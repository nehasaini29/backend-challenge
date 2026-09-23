import pino from 'pino';
import { loadConfig } from '../src/config';
import { NhtsaClient } from '../src/infrastructure/nhtsa/client';
import { makesXml, typesXml } from './fixtures';
const config = loadConfig({ DATABASE_URL: 'postgresql://localhost/test', HTTP_MAX_ATTEMPTS: '3', HTTP_TIMEOUT_MS: '100' });
const logger = pino({ level: 'silent' });

function setup() {
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  const sleep = jest.fn<Promise<void>, [number, AbortSignal?]>().mockResolvedValue(undefined);
  return { fetcher, sleep, client: new NhtsaClient(config, logger, fetcher, sleep) };
}
test('uses both XML endpoints with typed transformation', async () => {
  const { fetcher, client } = setup();
  fetcher.mockResolvedValueOnce(new Response(makesXml)).mockResolvedValueOnce(new Response(typesXml));
  expect(await client.getMakes()).toHaveLength(2);
  expect(await client.getVehicleTypes('440')).toEqual([{ typeId: '2', typeName: 'Passenger Car' }]);
  expect(String(fetcher.mock.calls[0]![0])).toBe('https://vpic.nhtsa.dot.gov/api/vehicles/getallmakes?format=xml');
  expect(String(fetcher.mock.calls[1]![0])).toContain('GetVehicleTypesForMakeId/440?format=xml');
});
test('retries network failures and 429 with simple exponential delays', async () => {
  const { fetcher, client, sleep } = setup();
  fetcher.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce(new Response('', { status: 429 }))
    .mockResolvedValueOnce(new Response(makesXml));
  await client.getMakes();
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(sleep.mock.calls.map(call => call[0])).toEqual([500, 1000]);
});
test('caps retries after server errors', async () => {
  const { fetcher, client } = setup();
  fetcher.mockImplementation(async () => new Response('', { status: 503 }));
  await expect(client.getMakes()).rejects.toThrow('Upstream request failed');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
test('does not retry client errors or invalid XML', async () => {
  const { fetcher, client, sleep } = setup();
  fetcher.mockResolvedValueOnce(new Response('', { status: 404 }));
  await expect(client.getMakes()).rejects.toThrow();
  fetcher.mockResolvedValueOnce(new Response('<bad>'));
  await expect(client.getMakes()).rejects.toThrow('Invalid');
  expect(sleep).not.toHaveBeenCalled();
});
test('passes a timeout signal and honors cancellation without retry', async () => {
  const { fetcher, client, sleep } = setup();
  const abort = new AbortController();
  fetcher.mockImplementation(async (_url, options) => {
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    abort.abort(new Error('cancelled'));
    throw new Error('aborted');
  });
  await expect(client.getMakes(abort.signal)).rejects.toThrow('cancelled');
  expect(sleep).not.toHaveBeenCalled();
});
