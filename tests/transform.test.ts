import { combineMake, parseMakes, parseVehicleTypes, TransformationError } from '../src/domain/vehicle/transform';
import { emptyTypesXml, envelope, make, makeRecord, makesXml, typeRecord, typesXml } from './fixtures';

describe('XML to unified JSON transformation', () => {
  test('matches the reference shape, preserving string IDs', () => {
    expect(combineMake(parseMakes(makesXml)[0]!, parseVehicleTypes(typesXml))).toEqual(make);
  });
  test('supports a singleton, escaped names, whitespace, and numeric-looking names', () => {
    expect(parseMakes(envelope('AllVehicleMakes', [makeRecord('1', ' A &amp; B ')])))
      .toEqual([{ makeId: '1', makeName: 'A & B' }]);
    expect(parseMakes(envelope('AllVehicleMakes', [makeRecord('1', '123')]))[0]!.makeName).toBe('123');
  });
  test('normalizes empty type results to an array', () => {
    expect(parseVehicleTypes(emptyTypesXml)).toEqual([]);
    expect(parseVehicleTypes('<Response><Count>0</Count><Results/></Response>')).toEqual([]);
  });
  test('deduplicates identical rows and sorts numerically', () => {
    expect(parseMakes(envelope('AllVehicleMakes', [makeRecord('10'), makeRecord('2'), makeRecord('2')])).map(m => m.makeId)).toEqual(['2', '10']);
    expect(parseVehicleTypes(envelope('VehicleTypesForMakeIds', [typeRecord('10'), typeRecord('2'), typeRecord('2')])).map(t => t.typeId)).toEqual(['2', '10']);
  });
  test.each([
    '<Response>', '<html>unavailable</html>',
    '<!DOCTYPE x [<!ENTITY x "unsafe">]><Response/>',
    envelope('AllVehicleMakes', []),
    envelope('AllVehicleMakes', [makeRecord()], 2),
    envelope('AllVehicleMakes', [makeRecord('0')]),
    envelope('AllVehicleMakes', [makeRecord('abc')]),
    envelope('AllVehicleMakes', [makeRecord('01')]),
    envelope('AllVehicleMakes', [makeRecord('1', ' ')]),
    envelope('AllVehicleMakes', ['<Make_ID>1</Make_ID>']),
    envelope('AllVehicleMakes', [makeRecord('1', 'A'), makeRecord('1', 'B')]),
    envelope('Unexpected', [makeRecord()]),
  ])('rejects malformed or unsafe makes XML %#', xml => {
    expect(() => parseMakes(xml)).toThrow(TransformationError);
  });
  test.each([
    envelope('VehicleTypesForMakeIds', [typeRecord('x')]),
    envelope('VehicleTypesForMakeIds', [typeRecord('2', '')]),
    envelope('VehicleTypesForMakeIds', [typeRecord('2', 'A'), typeRecord('2', 'B')]),
    envelope('VehicleTypesForMakeIds', [typeRecord()], 0),
  ])('rejects invalid vehicle types %#', xml => expect(() => parseVehicleTypes(xml)).toThrow(TransformationError));
  test('validates final output at the domain boundary', () => {
    expect(() => combineMake({ makeId: '0', makeName: 'A' }, [])).toThrow(TransformationError);
    expect(combineMake({ makeId: '1', makeName: 'A' }, [])).toEqual({ makeId: '1', makeName: 'A', vehicleTypes: [] });
  });
});
