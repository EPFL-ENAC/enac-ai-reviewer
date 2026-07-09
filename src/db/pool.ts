import postgres from 'postgres';

export type Sql = postgres.Sql;

export function createPool(databaseUrl: string): Sql {
  return postgres(databaseUrl, { max: 10 });
}
