import sql from "mssql";

let pool: sql.ConnectionPool | null = null;

function parseDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const server = parsed.hostname;
  const port = parsed.port ? Number(parsed.port) : 1433;
  const database = parsed.pathname.replace("/", "");
  return { user, password, server, port, database };
}

function getConfig(): sql.config {
  const fromUrl = parseDatabaseUrl();
  const server = fromUrl?.server ?? process.env.MSSQL_HOST ?? "";
  const port = fromUrl?.port ?? (process.env.MSSQL_PORT ? Number(process.env.MSSQL_PORT) : 1433);
  const user = fromUrl?.user ?? process.env.MSSQL_USER ?? "";
  const password = fromUrl?.password ?? process.env.MSSQL_PASSWORD ?? "";
  const database = fromUrl?.database ?? process.env.MSSQL_DB ?? "";

  if (!server || !user || !password || !database) {
    throw new Error("Missing MSSQL connection environment variables.");
  }

  return {
    server,
    port,
    user,
    password,
    database,
    options: {
      encrypt: true,
      trustServerCertificate: true,
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };
}

export async function getPool() {
  if (pool) return pool;
  pool = await sql.connect(getConfig());
  return pool;
}

export { sql };