const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const defaultSettings = [
  { key: 'rtmp_port', value: '1935', description: 'RTMP Ingest Port', type: 'number' },
  { key: 'api_port', value: '3000', description: 'Backend API Port', type: 'number' },
  { key: 'media_http_port', value: '8000', description: 'Media Server HTTP/FLV Port', type: 'number' },
  { key: 'ffmpeg_path', value: '/usr/bin/ffmpeg', description: 'Path to FFmpeg executable', type: 'string' },
  { key: 'server_hostname', value: 'localhost', description: 'Public Hostname or IP of the server', type: 'string' },
  { key: 'twitch_ingest', value: 'rtmp://live.twitch.tv/app/', description: 'Twitch Ingest Base URL', type: 'string' },
  { key: 'facebook_ingest', value: 'rtmps://live-api-s.facebook.com:443/rtmp/', description: 'Facebook Ingest Base URL', type: 'string' },
  { key: 'tiktok_ingest', value: 'rtmp://send.unify.tiktok.com/live/', description: 'TikTok Ingest Base URL', type: 'string' },
  { key: 'instagram_ingest', value: 'rtmps://live-upload.instagram.com:443/rtmp/', description: 'Instagram Ingest Base URL', type: 'string' }
];

async function main() {
  console.log('Seeding application settings...');
  for (const setting of defaultSettings) {
    await prisma.setting.upsert({
      where: { key: setting.key },
      update: {},
      create: setting
    });
  }
  console.log('Settings seeded successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
