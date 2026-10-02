# blotter-host

The multi-tenant host and router for [blotter.host](https://blotter.host) and its tenant subdomains.

`blotter-host` provides the shared server layer that routes requests to the appropriate tenant, serves tenant-facing views, and supports the operational services behind the Blotter host platform.

## Local development

```bash
npm install
npm run dev
```

Start the production server with `npm start`. Configuration is documented in `.env.example`.

## Project layout

- `server.js` — application entry point and HTTP routes
- `views/` — shared and tenant-facing templates
- `src/` — database, ingestion, scheduling, and logging modules
- `tenants.json` — tenant registry
- `test/` — automated route and service tests

## License

See the repository license and contribution guidance before making changes.
