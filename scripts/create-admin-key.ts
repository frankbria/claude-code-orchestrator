#!/usr/bin/env tsx
// scripts/create-admin-key.ts
// CLI utility to create the initial admin API key, bypassing API authentication
import { Pool } from 'pg';
import 'dotenv/config';
import { createApiKey } from '../src/db/queries';

async function main() {
  const name = process.argv[2] || 'Initial Admin Key';
  
  console.log('Creating admin API key...');
  console.log(`Name: ${name}`);
  
  const db = new Pool({
    connectionString: process.env.DATABASE_URL
  });

  try {
    // Create an admin key with admin=true in metadata
    const apiKey = await createApiKey(db, name, { admin: true });
    
    console.log('\n✅ Admin API key created successfully!\n');
    console.log('='.repeat(70));
    console.log('API Key ID:', apiKey.id);
    console.log('API Key:', apiKey.key);
    console.log('Name:', apiKey.name);
    console.log('Created:', apiKey.created_at);
    console.log('='.repeat(70));
    console.log('\n⚠️  IMPORTANT: Store this key securely. It will not be shown again!');
    console.log('\nAdd it to your requests with the x-api-key header:');
    console.log(`  curl -H 'x-api-key: ${apiKey.key}' http://localhost:3001/api/admin/keys\n`);
  } catch (error) {
    console.error('❌ Error creating admin key:', error);
    process.exit(1);
  } finally {
    await db.end();
  }
}

main();
