const HyperswarmStats = require('hyperswarm-stats')

const { version: PACKAGE_VERSION } = require('../package.json')

function instrument(swarm, promClient) {
  promClient.collectDefaultMetrics()

  const swarmStats = new HyperswarmStats(swarm)
  swarmStats.registerPrometheusMetrics(promClient)

  registerPackageVersion(promClient)
}

function registerPackageVersion(promClient) {
  // Gauges expect a number, so we set the version as label instead
  return new promClient.Gauge({
    name: 'package_version',
    help: 'Package version in config.json',
    labelNames: ['version'],
    collect() {
      this.labels(PACKAGE_VERSION).set(1)
    }
  })
}

module.exports = instrument
