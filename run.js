#! /usr/bin/env node
require('#globals')
const HyperDht = require('hyperdht')
const Hyperswarm = require('hyperswarm')
const pino = require('pino', {
  with: { imports: 'bare-node-runtime/imports' }
})
const fastify = require('fastify', {
  with: { imports: 'bare-node-runtime/imports' }
})
const idEnc = require('hypercore-id-encoding')
const goodbye = require('graceful-goodbye')
const promClient = require('bare-prom-client')
const ProtomuxRpcClient = require('protomux-rpc-client')

const PrometheusDhtBridge = require('./index')
const instrument = require('./lib/instrument')

function loadConfig() {
  const config = {
    prometheusTargetsLoc:
      process.env.HYPERDHT_PROM_PROMETHEUS_TARGETS_LOC || './prometheus/targets.json',
    logLevel: (process.env.HYPERDHT_PROM_LOG_LEVEL || 'info').toLowerCase(),
    httpPort: parseInt(process.env.HYPERDHT_PROM_HTTP_PORT || 0),
    httpHost: process.env.HYPERDHT_PROM_HTTP_HOST || '127.0.0.1',
    dhtPort: parseInt(process.env.HYPERDHT_PROM_DHT_PORT || 0),
    exposeReplSwarm: process.env.HYPERDHT_PROM_EXPOSE_REPL_SWARM === 'true',
    _forceFlushOnClientReady: process.env._HYPERDHT_PROM_FORCE_FLUSH || 'false' // Tests only
  }

  config.serverLogLevel = config.logLevel === 'debug' ? 'info' : 'warn' // No need to log all metrics requests

  try {
    config.sharedSecret = idEnc.decode(process.env.HYPERDHT_PROM_SHARED_SECRET)
  } catch (e) {
    console.error('HYPERDHT_PROM_SHARED_SECRET env var must be set to a valid hypercore key')
    process.exit(1)
  }

  try {
    config.keyPairSeed = idEnc.decode(idEnc.normalize(process.env.HYPERDHT_PROM_KEY_PAIR_SEED))
  } catch (e) {
    if (process.env.HYPERDHT_PROM_KEY_PAIR_SEED) {
      console.error(
        'HYPERDHT_PROM_KEY_PAIR_SEED env var, if set, must be set to a valid hypercore key'
      )
      process.exit(1)
    }
  }

  if (process.env.HYPERDHT_PROM_BOOTSTRAP_PORT) {
    // For tests
    config.bootstrap = [
      {
        port: parseInt(process.env.HYPERDHT_PROM_BOOTSTRAP_PORT),
        host: '127.0.0.1'
      }
    ]
  }

  return config
}

async function main() {
  const {
    bootstrap,
    logLevel,
    prometheusTargetsLoc,
    sharedSecret,
    httpPort,
    httpHost,
    dhtPort,
    keyPairSeed,
    serverLogLevel,
    exposeReplSwarm,
    _forceFlushOnClientReady
  } = loadConfig()

  const logger = pino({ level: logLevel })
  logger.info('Starting up Prometheus DHT bridge')

  // Generates new if seed is undefined
  const keyPair = HyperDht.keyPair(keyPairSeed)
  const swarm = new Hyperswarm({
    port: dhtPort,
    bootstrap,
    keyPair
  })
  const protomuxRpcClient = new ProtomuxRpcClient(swarm.dht, { keyPair: swarm.keyPair })

  const server = fastify({ loggerInstance: logger })
  const bridge = new PrometheusDhtBridge(swarm, server, protomuxRpcClient, sharedSecret, {
    keyPairSeed,
    ownPromClient: promClient,
    prometheusTargetsLoc,
    _forceFlushOnClientReady,
    serverLogLevel
  })

  instrument(swarm, promClient)
  bridge.registerLogger(logger)

  if (exposeReplSwarm === true) {
    const replSwarm = require('repl-swarm')
    const seed = replSwarm({ bridge, server })
    setInterval(() => {
      logger.info(`REPL swarm available at ${seed}`)
    }, 60_000 * 60)
  }

  goodbye(async () => {
    logger.info('Shutting down')
    await server.close()
    await protomuxRpcClient.close()
    logger.info('Http server shut down--now closing the bridge')
    if (bridge.opened) await bridge.close()
    logger.info('Fully shut down')
  })

  server.listen({ host: httpHost, port: httpPort })
  await bridge.ready()
  logger.info(`DHT RPC ready at public key ${idEnc.normalize(bridge.publicKey)}`)
}

main()
