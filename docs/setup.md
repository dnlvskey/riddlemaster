# Connect your Mind

The chat runs in HelloMinds. The investigation workspace runs on your computer, so the Mind needs an HTTPS address to reach it.

## 1. Start Riddlemaster

Follow the README's local setup and leave `npm start` running.

## 2. Select a Mind

Use a dedicated Mind with available Cognition:

```sh
npm run minds:inspect
```

Copy its ID into `MINDS_MIND_ID` in your local `.env`. If you need a new Mind, replace `YOUR_UNIQUE_NAME` below with an available name:

```sh
node --env-file-if-exists=.env scripts/minds-setup.js create YOUR_UNIQUE_NAME
```

The creation command saves the new Mind's ID locally.

## 3. Give it access to the workspace

For local development, install [Cloudflare's official cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and open another terminal:

```sh
cloudflared tunnel --url http://127.0.0.1:4317 --protocol http2
```

Copy the HTTPS address printed by cloudflared into `RIDDLEMASTER_PUBLIC_URL` in `.env`. Set `RIDDLEMASTER_NATIVE_BRIDGE=true`. Keep both terminals running.

The tunnel lets your Mind reach the protected tools; the investigation page stays local. Its address changes when you restart the tunnel.

## 4. Link the Skill

```sh
node --env-file-if-exists=.env scripts/minds-setup.js skill
```

This asks your dedicated Mind to create or update a private Riddlemaster Skill and link it to your workspace. Check the separate setup conversation in HelloMinds. Wait for the actual saved Skill and private link to be confirmed; a message saying that setup started is not enough.

If you restart the tunnel with a new address, update `.env` and run this command again. The private link also needs renewing after seven days. Nothing is published to Bazaar by this command.

## 5. Send a clue

Open your dedicated Mind's native chat. Send a public puzzle link, text or a supported file. Open its **Open investigation** link in a browser on the computer running Riddlemaster.

On the website, click **Check this idea** to continue with the selected hypothesis.

## Limits

- One owner and one dedicated Mind per local workspace.
- Public static pages and supported images; login-only pages, video and JavaScript-only content are not supported.
- Attachments up to 4 MB. Images up to 10 million pixels and one frame.
- Real calls use your Mind's Cognition. There is no promise of solving every puzzle.
- First-time Skill creation on another real account is still unverified.

Never share `.env`, your local `data/` directory or raw setup messages. The repository contains no account credentials or saved player investigations.
