## Magento patch bot

A Cloudflare Worker that checks [magento.watch](https://magento.watch) for new Adobe Commerce / Magento Open Source security bulletins and posts them to Microsoft Teams. Each subscription gets only the bulletins that affect its Magento versions.

### How it works

Once a day (06:00 UTC) the cron trigger starts a Cloudflare Workflow. The workflow:

1. Loads the subscriptions from KV.
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
```

The first deploy creates the `STATE` KV namespace and writes its id into `wrangler.toml`. Commit that change, otherwise the next deploy from a clean checkout creates a new, empty namespace.

To get a Teams webhook URL, add the "Post to a channel when a webhook request is received" workflow to the channel (Teams > channel > Workflows).

### Configuration

Subscriptions are stored in KV under the key `config`. Edit the value in the Cloudflare dashboard (Workers & Pages > KV > namespace > `config`). No deploy is needed, the next run uses the new value.

```json
{
  "subscriptions": [
    {
      "name": "client-a",
      "product": "open-source",
      "versions": ["2.4.8-p5", "2.4.7-*"],
      "unsupportedLines": true,
      "enabled": true,
      "channel": { "type": "teams", "url": "secret:CLIENT_A_TEAMS_URL" }
    }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | Unique name, used in logs and delivery status. |
| `product` | no | `open-source` (default), `commerce` or `b2b`. |
| `versions` | yes | Exact version (`2.4.8-p5`), whole line (`2.4.8-*`) or everything (`*`). |
| `unsupportedLines` | no | Also notify about lines that got no fix. Default `true`. |
| `enabled` | no | Default `true`. |
| `channel.type` | yes | Only `teams` for now. |
| `channel.url` | yes | Webhook URL (`https://...`) or `secret:NAME`. |

With `secret:NAME` the URL is read from a Worker secret, so it does not show up in KV:

```sh
npx wrangler secret put CLIENT_A_TEAMS_URL
```

If the `config` key does not exist, the bot uses one default subscription: all Open Source versions, posted to the `TEAMS_WEBHOOK_URL` secret. If neither exists, bulletins wait in the queue.

Config errors are listed in `GET /status`.

### Secrets and variables

| Name | Type | Description |
|---|---|---|
| `ADMIN_TOKEN` | secret, required | Bearer token for `/status`. |
| `TEAMS_WEBHOOK_URL` | secret, optional | Used only when there is no `config` key in KV. |
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
npm run dev
curl http://localhost:8787/__scheduled
curl -H "Authorization: Bearer test" http://localhost:8787/status
```

`wrangler dev` uses a local KV and a local Workflows engine. Retry delays are real, so a failed step really waits 15 or 30 minutes.

Other scripts: `npm run typecheck`, `npm run deploy`.
