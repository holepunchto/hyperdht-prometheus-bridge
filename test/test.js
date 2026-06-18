const path = require('path')
const { once } = require('events')

const test = require('brittle')
const promClient = require('prom-client')
const DhtPromClient = require('dht-prom-client')
const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const fastify = require('fastify')
const axios = require('axios')
const hypCrypto = require('hypercore-crypto')
const getTmpDir = require('test-tmp')
const PrometheusDhtBridge = require('../index')
const Hyperswarm = require('hyperswarm')
const ProtomuxRpcClient = require('protomux-rpc-client')

test('put alias + lookup happy flow', async (t) => {
  const { bridge, dhtPromClient } = await setup(t)

  await dhtPromClient.ready()
  await bridge.ready()

  const baseUrl = await bridge.server.listen({ host: '127.0.0.1', port: 0 })

  bridge.putAlias('dummy', dhtPromClient.publicKey)
  await new Promise((resolve) => setTimeout(resolve, 1000)) // TODO: use swarm.flush again when bug fixed

  const res = await axios.get(`${baseUrl}/scrape/dummy/metrics`, { validateStatus: null })

  t.is(res.status, 200, 'correct status')
  t.is(res.data.includes('process_cpu_user_seconds_total'), true, 'Successfully scraped metrics')
})

test('404 on unknown alias', async (t) => {
  const { bridge } = await setup(t)

  await bridge.ready()

  const baseUrl = await bridge.server.listen({ host: '127.0.0.1', port: 0 })

  const res = await axios.get(`${baseUrl}/scrape/nothinghere/metrics`, { validateStatus: null })
  t.is(res.status, 404, 'correct status')
  t.is(res.data.includes('Unknown alias'), true, 'Sensible err msg')
})

test('502 with uid if upstream returns success: false', async (t) => {
  const { bridge, dhtPromClient } = await setup(t)

  new promClient.Gauge({
    // eslint-disable-line no-new
    name: 'broken_metric',
    help: 'A metric which throws on collecting it',
    collect() {
      throw new Error('I break stuff')
    }
  })

  let reqUid = null
  dhtPromClient.on('metrics-request', ({ uid }) => {
    reqUid = uid
  })

  await dhtPromClient.ready()
  await bridge.ready()

  const baseUrl = await bridge.server.listen({ host: '127.0.0.1', port: 0 })
  bridge.putAlias('dummy', dhtPromClient.publicKey)
  await new Promise((resolve) => setTimeout(resolve, 1000)) // TODO: use swarm.flush again when bug fixed

  const res = await axios.get(`${baseUrl}/scrape/dummy/metrics`, { validateStatus: null })
  t.is(res.status, 502, 'correct status')
  t.is(res.data.includes(reqUid), true, 'uid included in error message')
})

test('502 if upstream unavailable', async (t) => {
  const { bridge, dhtPromClient, protomuxRpcClient } = await setup(t)

  await dhtPromClient.ready()
  await bridge.ready()

  const baseUrl = await bridge.server.listen({ host: '127.0.0.1', port: 0 })
  bridge.putAlias('dummy', dhtPromClient.publicKey)

  await protomuxRpcClient.close()
  await dhtPromClient.close()

  const res = await axios.get(`${baseUrl}/scrape/dummy/metrics`, { validateStatus: null })
  t.is(res.status, 502, 'correct status')
  t.is(res.data, 'Upstream unavailable')
})

test('No new alias if adding same key', async (t) => {
  const { bridge } = await setup(t)
  const key = 'a'.repeat(64)
  const key2 = 'b'.repeat(64)

  await bridge.ready()
  bridge.putAlias('dummy', key)
  const clientA = bridge.aliases.get('dummy')

  t.is(clientA !== null, true, 'sanity check')
  bridge.putAlias('dummy', key)
  t.is(clientA, bridge.aliases.get('dummy'), 'no new client')

  bridge.putAlias('dummy', key2)
  t.not(clientA, bridge.aliases.get('dummy'), 'sanity check')
})

test('A client which registers itself can get scraped', async (t) => {
  t.plan(4)

  const { bridge, dhtPromClient } = await setup(t)

  bridge.aliasRpcServer.on('alias-request', ({ uid, _remotePublicKey, alias, targetPublicKey }) => {
    t.is(alias, 'dummy', 'correct alias')
    t.alike(targetPublicKey, dhtPromClient.publicKey, 'correct target key got registered')
  })
  bridge.aliasRpcServer.on('register-error', ({ error, uid }) => {
    console.error(error)
    t.fail('unexpected error')
  })
  await bridge.ready()

  const baseUrl = await bridge.server.listen({ host: '127.0.0.1', port: 0 })

  await new Promise((resolve) => setTimeout(resolve, 1000)) // TODO: use swarm.flush again when bug fixed
  await Promise.all([dhtPromClient.ready(), once(dhtPromClient, 'register-alias-success')])

  const res = await axios.get(`${baseUrl}/scrape/dummy/metrics`, { validateStatus: null })

  t.is(res.status, 200, 'correct status')
  t.is(res.data.includes('process_cpu_user_seconds_total'), true, 'Successfully scraped metrics')
})

test('A client gets removed and closed after it expires', async (t) => {
  const { bridge, dhtPromClient } = await setup(t, {
    entryExpiryMs: 1200,
    checkExpiredsIntervalMs: 100
  })

  await bridge.ready()
  await dhtPromClient.ready()

  bridge.putAlias('dummy', dhtPromClient.publicKey)
  await new Promise((resolve) => setTimeout(resolve, 1000)) // TODO: use swarm.flush again when bug fixed

  // Can be 2 if the alias-request connection isn't cleaned up yet
  t.is(bridge.swarm.connections.size > 0, true, 'sanity check: connected')
  t.is(bridge.aliases.size, 1, 'sanity check')

  const [{ alias: expiredAlias }] = await once(bridge, 'alias-expired')
  t.is(expiredAlias, 'dummy', 'alias-expired event emitted')

  t.is(bridge.aliases.size, 0, 'alias removed when expired')

  await once(bridge, 'aliases-updated')
  t.pass('aliases file rewritten after an entry gets removed')
})

test('A client does not get removed if it renews before the expiry', async (t) => {
  // Test is somewhat susceptible to CPU blocking due to timings
  // (add more margin if that happens in practice)
  const { bridge } = await setup(t, {
    entryExpiryMs: 500,
    checkExpiredsIntervalMs: 100
  })
  const key = 'a'.repeat(64)

  await bridge.ready()
  bridge.putAlias('dummy', key)
  setTimeout(() => {
    bridge.putAlias('dummy', key)
  }, bridge.entryExpiryMs / 2)

  t.is(bridge.aliases.size, 1, 'sanity check')

  await new Promise((resolve) => setTimeout(resolve, bridge.entryExpiryMs + 100))

  t.is(bridge.aliases.size, 1, 'alias not removed if renewed in time')

  await new Promise((resolve) => setTimeout(resolve, bridge.entryExpiryMs + 100))

  t.is(bridge.aliases.size, 0, 'alias removed when expired')
})

async function setup(t, bridgeOpts = {}) {
  promClient.collectDefaultMetrics() // So we have something to scrape
  t.teardown(() => promClient.register.clear())

  const testnet = await createTestnet()
  const bootstrap = testnet.bootstrap

  const sharedSecret = hypCrypto.randomBytes(32)

  const swarm = new Hyperswarm({ bootstrap })
  const protomuxRpcClient = new ProtomuxRpcClient(swarm.dht, { keyPair: swarm.keyPair })
  const server = fastify({ logger: false })
  const tmpDir = await getTmpDir(t)
  const prometheusTargetsLoc = path.join(tmpDir, 'prom-targets.json')
  const bridge = new PrometheusDhtBridge(swarm, server, protomuxRpcClient, sharedSecret, {
    _forceFlushOnClientReady: true, // to avoid race conditions
    prometheusTargetsLoc,
    ...bridgeOpts
  })

  bridge.on('upstream-error', (e) => {
    console.warn(e.stack)
  })

  const scraperPubKey = bridge.publicKey

  const dhtClient = new HyperDHT({ bootstrap })
  const clientProtomuxRpcClient = new ProtomuxRpcClient(dhtClient)
  const dhtPromClient = new DhtPromClient(
    dhtClient,
    promClient,
    scraperPubKey,
    'dummy',
    sharedSecret,
    'my-service',
    { bootstrap, hostname: 'my-hostname', clientProtomuxRpcClient }
  )
  dhtPromClient.on('register-alias-error', (e) => {
    console.warn(e.stack)
  })

  t.teardown(async () => {
    await server.close()
    await bridge.close()
    await protomuxRpcClient.close()
    await clientProtomuxRpcClient.close()
    await dhtPromClient.close()
    await swarm.destroy()
    await testnet.destroy()
    promClient.register.clear()
  })

  const ownPublicKey = dhtPromClient.dht.defaultKeyPair.publicKey
  return { dhtPromClient, bridge, bootstrap, ownPublicKey, protomuxRpcClient }
}
