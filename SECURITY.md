# Security and local configuration

Commit only `.env.example`, with empty values or obvious placeholders. Local `.env` variants, keys, generated data and private runtime logs are ignored. Never paste credentials into issues, screenshots or logs.

If a credential reaches a public commit, revoke or rotate it at the provider. Removing it from the latest files does not invalidate earlier copies.

Start local demos on loopback. Forecast reads public market data and uses a server-side database connection; Jev simulates orders and has no signing or transaction-submission path. Model API requests require explicit opt-in and a request-count cap. Demo and replay output are not evidence of live profitability.
