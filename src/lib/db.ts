import mysql from "mysql2/promise";

let pool: mysql.Pool | null = null;

function parseDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace("/", ""),
  };
}

function getConfig(): mysql.PoolOptions {
  const fromUrl = parseDatabaseUrl();
  const host = fromUrl?.host ?? process.env.MYSQLHOST ?? process.env.MYSQL_HOST ?? "";
  const port = fromUrl?.port ?? Number(process.env.MYSQLPORT ?? process.env.MYSQL_PORT ?? 3306);
  const user = fromUrl?.user ?? process.env.MYSQLUSER ?? process.env.MYSQL_USER ?? "";
  const password = fromUrl?.password ?? process.env.MYSQLPASSWORD ?? process.env.MYSQL_PASSWORD ?? "";
  const database = fromUrl?.database ?? process.env.MYSQLDATABASE ?? process.env.MYSQL_DB ?? "";

  if (!host || !user || !password || !database) {
    throw new Error("Missing MySQL connection environment variables.");
  }

  return {
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: "Z",
  };
}

export async function getPool() {
  if (pool) return pool;
  pool = mysql.createPool(getConfig());
  return pool;
}

export { mysql };
