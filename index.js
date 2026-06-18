const ReadyResource = require('ready-resource')
const idEnc = require('hypercore-id-encoding')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const AliasRpcServer = require('dht-prom-alias-rpc')

const ScraperClient = require('dht-prom-client/scraper')
const { writePromTargets, readPromTargets } = require('./lib/prom-targets')
const debounceify = require('debounceify')

const DEFAULT_PROM_TARGETS_LOC = './targets.json'

class PrometheusDhtBridge extends ReadyResource {
  constructor(
    swarm,
    server,
    protomuxRpcClient,
    sharedSecret,
    {
      ownPromClient,
      _forceFlushOnClientReady = false,
      prometheusTargetsLoc = DEFAULT_PROM_TARGETS_LOC,
      entryExpiryMs = 3 * 60 * 60 * 1000,
      checkExpiredsIntervalMs = 60 * 60 * 1000,
      serverLogLevel = 'warn'
    } = {}
  ) {
    super()

    if (
      !protomuxRpcClient.keyPair ||
      !b4a.equals(swarm.keyPair.publicKey, protomuxRpcClient.keyPair.publicKey)
    ) {
      // This keeps our authentication easy: services which register to the
      // scraper simply need to check that its public key is the same key they
      // contacted to register themselves (relying on the keypair authentication)
      throw new Error('The protomux-rpc-client keyPair option should be set to the swarm keyPair')
    }

    this.swarm = swarm
    this.secret = sharedSecret // Shared with clients
    this.protomuxRpcClient = protomuxRpcClient

    this.entryExpiryMs = entryExpiryMs
    this.checkExpiredsIntervalMs = checkExpiredsIntervalMs
    this._checkExpiredsInterval = null

    this.server = server
    this.server.get(
      '/scrape/:alias/metrics',
      { logLevel: serverLogLevel },
      this._handleGet.bind(this)
    )

    ownPromClient = ownPromClient || null
    if (ownPromClient) {
      this.server.get('/metrics', { logLevel: serverLogLevel }, async function (req, reply) {
        const metrics = await ownPromClient.register.metrics()
        reply.send(metrics)
      })
    }

    this.promTargetsLoc = prometheusTargetsLoc
    this.aliasRpcServer = new AliasRpcServer(this.swarm, this.secret, this.putAlias.bind(this))

    this.aliases = new Map()
    this._writeAliases = debounceify(this._writeAliasesUndebounced.bind(this))

    // for tests, to ensure we're connected to the scraper on first scrape
    this._forceFlushOnClientReady = _forceFlushOnClientReady
  }

  get dht() {
    return this.swarm.dht
  }

  get publicKey() {
    return this.swarm.keyPair.publicKey
  }

  async _open() {
    // It is important that the aliases are first loaded
    // otherwise the old aliases might get overwritten
    await this._loadAliases()
    await this.swarm.listen()
    this._checkExpiredsInterval = setInterval(
      () => this.cleanupExpireds(),
      this.checkExpiredsIntervalMs
    )
  }

  async _close() {
    // Should be first (no expireds cleanup during closing)
    if (this._checkExpiredsInterval) {
      clearInterval(this._checkExpiredsInterval)
    }

    // DEVNOTE: no need to close the entries explicitly
    // since they have no state, but we could consider
    // exposing a force-close at protomux-rpc-client level
    // to clean up the open connections rather than rely on the gc

    await this.swarm.destroy()

    if (this.opened) await this._writeAliases()
  }

  putAlias(alias, targetPubKey, hostname, service, { write = true } = {}) {
    if (!this.opened && write) throw new Error('Cannot put aliases before ready')

    targetPubKey = idEnc.decode(idEnc.normalize(targetPubKey))
    const current = this.aliases.get(alias)

    if (current) {
      if (b4a.equals(current.targetKey, targetPubKey)) {
        current.setExpiry(Date.now() + this.entryExpiryMs)
        const updated = false // Idempotent
        return updated
      }
    }

    const entry = new AliasesEntry(
      new ScraperClient(this.protomuxRpcClient, targetPubKey),
      hostname,
      service,
      Date.now() + this.entryExpiryMs
    )

    this.aliases.set(alias, entry)
    this.emit('set-alias', { alias, entry })
    const updated = true

    if (write === true) {
      this._writeAliases().catch(safetyCatch)
    }

    return updated
  }

  async _handleGet(req, reply) {
    const alias = req.params.alias

    const entry = this.aliases.get(alias)

    if (!entry) {
      reply.code(404)
      reply.send('Unknown alias')
      return
    }

    if (this._forceFlushOnClientReady && !entry.hasHandledGet) {
      // TODO: revert back to flushing when bug fixed there
      // await entry.scrapeClient.swarm.flush()
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    entry.hasHandledGet = true

    const scrapeClient = entry.scrapeClient

    let res
    try {
      res = await scrapeClient.requestMetrics()
    } catch (e) {
      this.emit('upstream-error', e)
      reply.code(502)
      reply.send('Upstream unavailable')
      return
    }

    if (res.success) {
      reply.send(res.metrics)
    } else {
      reply.code(502)
      reply.send(`Upstream error: ${res.errorMessage}`)
    }
  }

  async _writeAliasesUndebounced() {
    // should never throw
    try {
      await writePromTargets(this.promTargetsLoc, this.aliases)
      this.emit('aliases-updated', this.promTargetsLoc)
    } catch (e) {
      this.emit('write-aliases-error', e)
    }
  }

  async _loadAliases() {
    // should never throw
    try {
      const aliases = await readPromTargets(this.promTargetsLoc)

      for (const [alias, { z32PubKey, hostname, service }] of aliases) {
        // Write false since we load an existing state
        // (otherwise we overwrite them 1 by 1, and can lose
        // entries if we restart/crash during setup)
        this.putAlias(alias, z32PubKey, hostname, service, { write: false })
      }
    } catch (e) {
      // An error is expected if the file does not yet exist
      // (typically first run only)
      this.emit('load-aliases-error', e)
    }
  }

  // Should be kept sync (or think hard)
  cleanupExpireds() {
    const toRemove = []
    for (const [alias, entry] of this.aliases) {
      if (entry.isExpired) toRemove.push(alias)
    }

    for (const alias of toRemove) {
      const entry = this.aliases.get(alias)
      this.aliases.delete(alias)
      this.emit('alias-expired', { publicKey: entry.targetKey, alias })
    }

    if (toRemove.length > 0) {
      this._writeAliases().catch(safetyCatch)
    }
  }

  registerLogger(logger) {
    this.on('set-alias', ({ alias, entry }) => {
      const scrapeClient = entry.scrapeClient
      const publicKey = scrapeClient.targetKey
      const { service, hostname } = entry

      logger.info(
        `Registered alias: ${alias} -> ${idEnc.normalize(publicKey)} (${service} on host ${hostname})`
      )
    })

    this.on('aliases-updated', (loc) => {
      logger.info(`Updated the aliases file at ${loc}`)
    })

    this.on('alias-expired', ({ alias, publicKey }) => {
      logger.info(`Alias entry expired: ${alias} -> ${idEnc.normalize(publicKey)}`)
    })

    this.on('load-aliases-error', (e) => {
      // Expected first time the service starts (creates it then)
      logger.error(`failed to load aliases file: ${e.stack}`)
    })

    this.on('upstream-error', (e) => {
      logger.info(`upstream error: ${e.stack}`)
    })

    this.on('write-aliases-error', (e) => {
      logger.error(`Failed to write aliases file ${e.stack}`)
    })

    this.aliasRpcServer.registerLogger(logger)
  }
}

class AliasesEntry {
  constructor(scrapeClient, hostname, service, expiry) {
    this.scrapeClient = scrapeClient
    this.hostname = hostname
    this.service = service
    this.expiry = expiry
    this.hasHandledGet = false
  }

  get targetKey() {
    return this.scrapeClient.targetKey
  }

  get isExpired() {
    return this.expiry < Date.now()
  }

  setExpiry(expiry) {
    this.expiry = expiry
  }
}

module.exports = PrometheusDhtBridge
