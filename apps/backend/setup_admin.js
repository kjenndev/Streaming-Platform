const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const username = process.argv[2] || 'admin';
  const password = process.argv[3] || 'admin123';
  
  const passwordHash = await bcrypt.hash(password, 10);
  
  try {
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        roles: ['ADMIN']
      }
    });
    console.log(`Admin user created successfully: ${user.username}`);
    console.log(`Password: ${password}`);
  } catch (error) {
    console.error('Error creating admin user:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
