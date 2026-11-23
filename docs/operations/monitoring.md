# Monitoring (Grafana in the admin page)

The admin page has a tab **Leistung**. It shows a Grafana dashboard with:

* response times and request rates by route
* errors
* event-loop lag, memory, CPU and garbage collection
* open sockets and live games
* matches of the last 24 hours (with people, bots only, single-player)
* the database: query times, the connection pool, database size and table rows, full-table scans, and the most expensive queries (`pg_stat_statements`)

```
browser ──/admin/grafana/…──▶ game server (admins only) ──X-WEBAUTH-USER──▶ grafana ──▶ prometheus
                                                                                         ├─▶ hochciv-app:9464 /metrics  (utils/metrics.js)
                                                                                         └─▶ postgres-exporter ──▶ hochciv-db
```

| Part | Where | What it does |
|---|---|---|
| `utils/metrics.js` | game server | Collects the figures with `prom-client` and serves them on their own port, `METRICS_PORT` (default `9464`, `off` turns it off). nginx doesn't proxy that port, so only containers on the internal network reach it. |
| `utils/grafana.js` | game server | Passes `/admin/grafana/…` to Grafana (`GRAFANA_URL`) for admins, superadmins and the review admin. It replaces any `X-WEBAUTH-*` header the browser sends, sets the admin's name and role (super admin → Grafana Admin, everyone else → Viewer), and only forwards Grafana's own cookies. |
| `monitoring/prometheus/prometheus.yml` | Prometheus | Scrapes the server and the exporter every 15 s and keeps the data for `PROMETHEUS_RETENTION` (default `30d`). |
| `monitoring/grafana/…` | Grafana | Provisions the data source and the dashboard `hochciv-overview` (`dashboards/hochciv.json`). It has no login of its own (auth proxy) and runs on the internal network only. |
| `postgres-exporter` | container | Reads the statistics views as `hochciv_app`, which `scripts/db-setup.js` gives the read-only role `pg_monitor`. |
| `pg_stat_statements` | Postgres | Loaded through the database's `command` (`shared_preload_libraries`). `scripts/db-setup.js` then creates the extension. |

On the host, `monitoring-setup` copies `monitoring/` from the server image into a volume, so the host needs nothing besides `docker-compose.yml` and `.env`. Locally, `docker-compose.local.yml` mounts `./monitoring` directly, and Prometheus is also reachable at `http://127.0.0.1:9090`.

## Setting it up on a host

Watchtower only replaces the server image. The new containers and the database's new start command need one manual step on the host:

```sh
docker compose pull
docker compose up -d        # restarts hochciv-db once (pg_stat_statements), starts prometheus, grafana, postgres-exporter
```

Do the same for staging with `docker-compose.staging.yml`. The database restart takes a few seconds, and the server reconnects on its own.

To leave monitoring off on a host, set `GRAFANA_URL=` (empty) in `.env`. The tab then says that monitoring isn't set up.

## Changing the dashboard

`monitoring/grafana/dashboards/hochciv.json` is provisioned read-only. To change it:

1. Edit it in Grafana as super admin and save a copy.
2. Export the copy as JSON.
3. Replace the file and keep `uid: hochciv-overview`.

The change reaches a host with the next image and `docker compose up -d` (monitoring-setup copies the files again).
