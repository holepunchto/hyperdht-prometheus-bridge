# hyper-dht-prometheus

A bridge to scrape Prometheus metrics from self-registering services, all using direct, end-to-end encrypted peer-to-peer connections (not http).

Service discovery is done with a decentralised hash table ([HyperDHT](https://github.com/holepunchto/hyperdht)). This means that both this service and the clients it scrapes can live behind a firewall and need no reverse proy nor DNS entries.

An advantage is the small amount of configuration required. [Clients](https://github.com/holepunchto/hyper-dht-prom-client) register themselves with the hyper-dht-prometheus service, so no manual list of targets needs to be maintained. All a client needs to register itself, is the hyper-dht-prometheus service's public key, and a shared secret.

## Deployment

hyper-dht-prometheus is meant to be deployed alongside Prometheus. It manages a single `targets.json` file referenced from the main prometheus configuration (See [prometheus/prometheus.yml](prometheus/prometheus.yml) for an example).

The hyper-dht-prometheus service fulfils two complementary roles:

- It maintains a `targets.json` file with aliases to all services which Prometheus should scrape.
- It provides an HTTP server which receives Prometheus requests and forwards them to the instances of hyper-dht-prom-client.

### Run

Configuration is done through environment variables:

- `DHT_PROM_KEY_PAIR_SEED`: 32-byte seed passed to `HyperDHT.keyPair()`, set as hex or z32. Set this to have a consistent public key (otherwise random, which is only useful for tests).
- `DHT_PROM_SHARED_SECRET`: 32-byte secret key, set as hex or z32.
- `DHT_PROM_LOG_LEVEL`: defaults to info
- `DHT_PROM_HTTP_PORT`: port where the http server listens. Defaults to a random port.
- `DHT_PROM_HTTP_HOST`: host where the http server listens. Defaults to 127.0.0.1

#### CLI

Install:

```
npm i -g hyper-dht-prometheus
```

Run:

```
DHT_PROM_PROMETHEUS_TARGETS_LOC=path/to/prometheus/targets.json DHT_PROM_HTTP_PORT=30000 DHT_PROM_SHARED_SECRET=<A 64 character hex string> hyper-dht-prometheus
```

## Test

```
npm test
```

Integration tests are also included:

```
npm run integration
```

Note: the integration tests run [./prep-integration-test.sh](./prep-integration-test.sh), which downloads Prometheus and copies the executable to the ./prometheus directory.

## Fork

Forked on 2026-06-17 from https://gitlab.com/dcent-tech/dht-prometheus/,
licensed under Apache-2.0. See NOTICE.
