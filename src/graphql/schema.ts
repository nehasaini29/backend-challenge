export const typeDefs = `#graphql
  "A vehicle category supplied by NHTSA. IDs are strings."
  type VehicleType {
    typeId: ID!
    typeName: String!
  }
  "The exact unified make object persisted as JSON."
  type VehicleMake {
    makeId: ID!
    makeName: String!
    vehicleTypes: [VehicleType!]!
  }
  type MakePage {
    items: [VehicleMake!]!
    "Pass this make ID as 'after'. Null means there are no more results."
    nextCursor: ID
  }
  type CatalogStatus {
    makeCount: Int!
    "UTC ISO-8601 timestamp; null before the first successful ingestion."
    lastSuccessfulIngestion: String
  }
  type Query {
    "Find one make by its positive numeric NHTSA ID. Missing IDs return null."
    make(makeId: ID!): VehicleMake
    "Keyset pagination ordered by numeric make ID; first must be 1..100."
    makes(first: Int = 25, after: ID): MakePage!
    "Metadata for the last fully committed ingestion."
    catalogStatus: CatalogStatus!
  }
`;
