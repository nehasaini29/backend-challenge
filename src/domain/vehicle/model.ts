import { z } from 'zod';

export const idSchema = z.string().regex(/^[1-9]\d{0,14}$/);
export const vehicleTypeSchema = z.object({
  typeId: idSchema,
  typeName: z.string().trim().min(1).max(500),
}).strict();
export const makeSchema = z.object({
  makeId: idSchema,
  makeName: z.string().trim().min(1).max(500),
  vehicleTypes: z.array(vehicleTypeSchema),
}).strict();
export type VehicleType = z.infer<typeof vehicleTypeSchema>;
export type VehicleMake = z.infer<typeof makeSchema>;
export type MakeSummary = Omit<VehicleMake, 'vehicleTypes'>;
export interface CatalogPage {
  items: VehicleMake[];
  nextCursor: string | null;
}
export interface CatalogStatus { makeCount: number; lastSuccessfulIngestion: string | null }
export interface VehicleRepository {
  findById(id: string): Promise<VehicleMake | null>;
  list(first: number, after?: string): Promise<CatalogPage>;
  status(): Promise<CatalogStatus>;
}
export interface SnapshotWriter {
  replace(makes: VehicleMake[]): Promise<void>;
}
export interface VehicleSource {
  getMakes(signal?: AbortSignal): Promise<MakeSummary[]>;
  getVehicleTypes(makeId: string, signal?: AbortSignal): Promise<VehicleType[]>;
}
