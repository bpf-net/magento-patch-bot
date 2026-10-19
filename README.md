## Magento patch bot

A Cloudflare Worker that checks [magento.watch](https://magento.watch) for new Adobe Commerce / Magento Open Source security bulletins and posts them to Microsoft Teams. Each subscription gets only the bulletins that affect its Magento versions.

### How it works

Once a day (06:00 UTC) the cron trigger starts a Cloudflare Workflow. The workflow:

1. Loads the subscriptions from the D1 table `subscriptions`.
2. Downloads the bulletin list from the magento.watch API. If the request fails, it retries 3 times, every 30 minutes. If all attempts fail, it sends an alert card to every Teams webhook and stops until the next cron run.
3. Saves new bulletins to KV and adds them to the delivery queue.
4. Checks each bulletin against each subscription and posts an Adaptive Card to Teams. If a post fails, it retries 3 times, every 15 minutes. If it still fails, the remaining bulletins for that webhook wait for the next cron run. Different webhooks are handled in parallel, bulletins for one webhook are sent in order (oldest first).

A bulletin stays in the queue for up to 7 days. Bulletins older than 120 days are ignored.

On the very first run the bot marks everything already listed on magento.watch as seen, so it does not send old bulletins.

### Version matching

magento.watch gives two kinds of fix data:

- `fixedIn`: releases that contain the fix, per distribution (`magento-community`, `magento-commerce`).
- `isolatedPatches`: patches and the versions they apply to. Since 2026 Adobe ships most fixes this way.

A version is affected if it is older than the fixed release in the same line, or if it is at or below a version the isolated patch applies to. Lines older than every listed line are reported as "unsupported line" (can be turned off per subscription). If a bulletin has no version data at all, the bot sends it anyway.

Supported version formats: `2.4.8`, `2.4.8-p5`, `2.4.8-2026-sep`, `2.4.9-beta1`, `2.4.9-rc2`.

### Setup

Requirements: Node.js or Bun, a Cloudflare account (the Free plan is enough).

```sh
npm install
npx wrangler login
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
npx wrangler d1 migrations apply magento-patch-bot --remote
```

The first deploy creates the `STATE` KV namespace and the `magento-patch-bot` D1 database and writes their ids into `wrangler.toml`. Commit that change, otherwise the next deploy from a clean checkout creates new, empty ones. Run the migration right after the first deploy, before the first cron run.

To get a Teams webhook URL, add the "Post to a channel when a webhook request is received" workflow to the channel (Teams > channel > Workflows).

### Configuration

Subscriptions are rows in the D1 table `subscriptions`: what to check (product and versions) and where to send it (Teams webhook). Edit them in the Cloudflare dashboard (Storage & Databases > D1 > `magento-patch-bot` > Console) or with `wrangler d1 execute`. No deploy is needed, the next run uses the new data.

```sh
npx wrangler d1 execute magento-patch-bot --remote --command "
  INSERT INTO subscriptions (name, product, versions, webhook_url)
  VALUES ('client-a', 'open-source', '2.4.8-p5, 2.4.7-*', 'secret:CLIENT_A_TEAMS_URL')"
```

| Column | Default | Description |
|---|---|---|
| `name` | | Unique name (primary key), used in logs and delivery status. |
| `product` | `open-source` | `open-source`, `commerce` or `b2b`. |
| `versions` | | Comma-separated list. Exact version (`2.4.8-p5`), whole line (`2.4.8-*`) or everything (`*`). |
| `webhook_url` | | Teams webhook URL (`https://...`) or `secret:NAME`. |
| `unsupported_lines` | `1` | `1` also notifies about lines that got no fix. |
| `enabled` | `1` | `0` turns the subscription off. |

With `secret:NAME` the URL is read from a Worker secret, so it does not show up in the database:

```sh
npx wrangler secret put CLIENT_A_TEAMS_URL
```

If the table is empty, the bot uses one default subscription: all Open Source versions, posted to the `TEAMS_WEBHOOK_URL` secret. If neither exists, bulletins wait in the queue.

Invalid rows are listed in `GET /status`. While any row is invalid, nothing is sent and bulletins wait in the queue.

### Secrets and variables

| Name | Type | Description |
|---|---|---|
| `ADMIN_TOKEN` | secret, required | Bearer token for `/status`. |
| `TEAMS_WEBHOOK_URL` | secret, optional | Used only when the `subscriptions` table is empty. |
| `MAGENTO_WATCH_API` | variable, optional | API base URL. Default `https://magento.watch/api/v1`. |

### Endpoints

- `GET /health` returns `{"ok": true}`. No auth.
- `GET /status` returns the bot state (seen bulletins, queue, last run, last errors) and the config with webhook URLs masked. Needs `Authorization: Bearer <ADMIN_TOKEN>`.

Delivery history for each bulletin is stored in KV under `bulletin:<ID>`, for example `bulletin:APSB26-153`.

### Local development

Put local secrets in `.dev.vars` (it is in `.gitignore`):

```
ADMIN_TOKEN=test
TEAMS_WEBHOOK_URL=https://...
```

Then:

```sh
npx wrangler d1 migrations apply magento-patch-bot --local
npm run dev
curl http://localhost:8787/__scheduled
curl -H "Authorization: Bearer test" http://localhost:8787/status
```

`wrangler dev` uses a local KV, D1 and Workflows engine. Retry delays are real, so a failed step really waits 15 or 30 minutes.

Other scripts: `npm run typecheck`, `npm run deploy`.
