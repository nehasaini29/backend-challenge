import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { idSchema, makeSchema, MakeSummary, VehicleMake, VehicleType } from './model';

export class TransformationError extends Error {
  constructor(message: string) { super(message); this.name = 'TransformationError'; }
}
const parser = new XMLParser({
  ignoreAttributes: true, parseTagValue: false, trimValues: true,
  isArray: (name) => ['AllVehicleMakes', 'VehicleTypesForMakeIds'].includes(name),
});
const envelope = z.object({ Response: z.object({
  Count: z.string().regex(/^\d+$/).transform(Number),
  Results: z.union([z.literal(''), z.record(z.unknown())]),
}) });

function rows(xml: string, tag: string): unknown[] {
  try {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DTD/entity declarations are forbidden');
    if (XMLValidator.validate(xml) !== true) throw new Error('Invalid XML syntax');
    const { Response: response } = envelope.parse(parser.parse(xml));
    const result = response.Results;
    const records = result === '' ? [] : result[tag] ?? [];
    if (result !== '' && Object.keys(result).some(key => key !== tag)) throw new Error('Unexpected result element');
    if (!Array.isArray(records) || records.length !== response.Count) throw new Error('Result count mismatch');
    return records;
  } catch {
    throw new TransformationError(`Invalid ${tag} XML response`);
  }
}

function unique<T>(items: T[], key: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    const previous = map.get(id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) {
      throw new TransformationError(`Conflicting records for ID ${id}`);
    }
    map.set(id, item);
  }
  return [...map.values()].sort((a, b) => Number(key(a)) - Number(key(b)));
}

export function parseMakes(xml: string): MakeSummary[] {
  try {
    const source = z.array(z.object({ Make_ID: idSchema, Make_Name: z.string().trim().min(1).max(500) }))
      .parse(rows(xml, 'AllVehicleMakes'));
    if (source.length === 0) throw new TransformationError('Makes response must not be empty');
    return unique(source.map(v => ({ makeId: v.Make_ID, makeName: v.Make_Name })), v => v.makeId);
  } catch (error) {
    if (error instanceof TransformationError) throw error;
    throw new TransformationError('Invalid make record');
  }
}

export function parseVehicleTypes(xml: string): VehicleType[] {
  try {
    const source = z.array(z.object({ VehicleTypeId: idSchema, VehicleTypeName: z.string().trim().min(1).max(500) }))
      .parse(rows(xml, 'VehicleTypesForMakeIds'));
    return unique(source.map(v => ({ typeId: v.VehicleTypeId, typeName: v.VehicleTypeName })), v => v.typeId);
  } catch (error) {
    if (error instanceof TransformationError) throw error;
    throw new TransformationError('Invalid vehicle type record');
  }
}

export function combineMake(make: MakeSummary, vehicleTypes: VehicleType[]): VehicleMake {
  const result = makeSchema.safeParse({ ...make, vehicleTypes: unique(vehicleTypes, v => v.typeId) });
  if (!result.success) throw new TransformationError('Invalid combined make');
  return result.data;
}
