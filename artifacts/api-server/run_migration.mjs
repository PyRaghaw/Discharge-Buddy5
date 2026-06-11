import pg from 'pg';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn("DATABASE_URL is not set. Skipping migrations.");
  process.exit(0);
}

async function run() {
  // Use a client with a short timeout to fail fast if db is unreachable
  const client = new pg.Client({ 
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000 
  });

  try {
    console.log("Connecting to database for migrations...");
    await client.connect();
    console.log("Connected. Running migrations...");

    const sql = fs.readFileSync('../../lib/db/drizzle/0000_spicy_micromacro.sql', 'utf8');
    const statements = sql.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);
    
    for (const stmt of statements) {
      try {
        await client.query(stmt);
        console.log('Executed:', stmt.substring(0, 50) + '...');
      } catch (err) {
        if (err.code === '42710' || err.code === '42P07') {
          console.log('Skipped (already exists):', stmt.substring(0, 50) + '...');
        } else {
          console.error('Error executing statement:', stmt.substring(0, 50) + '...', err.message);
        }
      }
    }
  } catch (err) {
    console.error("Database migration connection test failed:", err.message);
  } finally {
    await client.end().catch(() => {});
  }
  process.exit(0);
}

run();
