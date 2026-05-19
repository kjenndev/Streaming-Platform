const request = require('supertest');
const bcrypt = require('bcrypt');
const { startServer, prisma, redis } = require('../index');

let appInstance;
let serverInstance;
let adminToken;
let clientToken;
let testAdmin;
let testClient;
let testStream;

beforeAll(async () => {
  // Start server
  const { app, server } = await startServer();
  appInstance = app;
  serverInstance = server;

  // Clean up existing test data
  await prisma.user.deleteMany({ where: { username: { in: ['testadmin', 'testclient'] } } });
  await prisma.stream.deleteMany({ where: { channelName: 'test-perm-stream' } });

  // Create test data
  const hashedPass = await bcrypt.hash('password123', 10);
  
  testAdmin = await prisma.user.create({
    data: {
      username: 'testadmin',
      passwordHash: hashedPass,
      roles: ['ADMIN']
    }
  });

  testStream = await prisma.stream.create({
    data: {
      channelName: 'test-perm-stream',
      streamKey: 'test-key'
    }
  });

  testClient = await prisma.user.create({
    data: {
      username: 'testclient',
      passwordHash: hashedPass,
      roles: ['CLIENT'],
      authorizedStreams: { connect: { id: testStream.id } }
    }
  });

  // Get tokens
  const adminLogin = await request(appInstance)
    .post('/api/login')
    .send({ username: 'testadmin', password: 'password123' });
  adminToken = adminLogin.body.token;

  const clientLogin = await request(appInstance)
    .post('/api/login')
    .send({ username: 'testclient', password: 'password123' });
  clientToken = clientLogin.body.token;
});

afterAll(async () => {
  if (testAdmin) await prisma.user.delete({ where: { id: testAdmin.id } }).catch(() => {});
  if (testClient) await prisma.user.delete({ where: { id: testClient.id } }).catch(() => {});
  if (testStream) await prisma.stream.delete({ where: { id: testStream.id } }).catch(() => {});
  
  await serverInstance.close();
  await prisma.$disconnect();
  await redis.quit();
});

describe('Authentication & Login Logic', () => {
  it('should fail login with incorrect password', async () => {
    const res = await request(appInstance)
      .post('/api/login')
      .send({ username: 'testadmin', password: 'wrongpassword' });
    expect(res.statusCode).toEqual(401);
    expect(res.body).toHaveProperty('error');
  });

  it('should succeed login with correct credentials', async () => {
    const res = await request(appInstance)
      .post('/api/login')
      .send({ username: 'testadmin', password: 'password123' });
    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body.roles).toContain('ADMIN');
  });

  it('should fail to create user with weak password', async () => {
    const res = await request(appInstance)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ username: 'weakuser', password: '123', roles: ['CLIENT'] });
    expect(res.statusCode).toEqual(400);
    expect(res.body.error).toContain('at least 8 characters');
  });
});

describe('Permission & RBAC Logic', () => {
  it('should allow ADMIN to access user management', async () => {
    const res = await request(appInstance)
      .get('/api/users')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toEqual(200);
    expect(Array.isArray(res.body)).toBeTruthy();
  });

  it('should deny CLIENT from accessing user management', async () => {
    const res = await request(appInstance)
      .get('/api/users')
      .set('Authorization', `Bearer ${clientToken}`);
    expect(res.statusCode).toEqual(403);
    expect(res.body.error).toContain('Access denied');
  });

  it('should allow ADMIN to see all streams', async () => {
    const res = await request(appInstance)
      .get('/api/streams')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.statusCode).toEqual(200);
    const hasStream = res.body.some(s => s.channelName === 'test-perm-stream');
    expect(hasStream).toBeTruthy();
  });

  it('should restrict CLIENT to only authorized streams', async () => {
    // Create another stream not authorized for client
    const privateStream = await prisma.stream.create({
      data: { channelName: 'private-stream', streamKey: 'priv' }
    });

    const res = await request(appInstance)
      .get('/api/streams')
      .set('Authorization', `Bearer ${clientToken}`);
    
    expect(res.statusCode).toEqual(200);
    const hasAuthorized = res.body.some(s => s.channelName === 'test-perm-stream');
    const hasPrivate = res.body.some(s => s.channelName === 'private-stream');
    
    expect(hasAuthorized).toBeTruthy();
    expect(hasPrivate).toBeFalsy();

    await prisma.stream.delete({ where: { id: privateStream.id } });
  });
});
