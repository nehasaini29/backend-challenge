export const envelope = (tag: string, records: string[], count = records.length) =>
  `<Response><Count>${count}</Count><Message>Response returned successfully</Message><Results>${records.map(r => `<${tag}>${r}</${tag}>`).join('')}</Results></Response>`;
export const makeRecord = (id = '440', name = 'ASTON MARTIN') => `<Make_ID>${id}</Make_ID><Make_Name>${name}</Make_Name>`;
export const typeRecord = (id = '2', name = 'Passenger Car') => `<VehicleTypeId>${id}</VehicleTypeId><VehicleTypeName>${name}</VehicleTypeName>`;
export const makesXml = envelope('AllVehicleMakes', [makeRecord('440'), makeRecord('441', 'TESLA')]);
export const typesXml = envelope('VehicleTypesForMakeIds', [typeRecord()]);
export const emptyTypesXml = envelope('VehicleTypesForMakeIds', []);
export const make = { makeId: '440', makeName: 'ASTON MARTIN', vehicleTypes: [{ typeId: '2', typeName: 'Passenger Car' }] };
