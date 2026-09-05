# VPS Connection and LLM Setup Notes

## Connection status

Replit Shell se the remote service ka SSH connection successfully verify ho chuka hai.

- SSH host: `tramway.proxy.rlwy.net`
- SSH port: `44838`
- SSH user: `admin`
- Railway TCP forwarding: external port `44838` → container port `22`
- Verified commands: `whoami`, `hostname`, and remote shell access
- SSH host fingerprint verified during first connection

Connect command:

```bash
ssh -p 44838 admin@tramway.proxy.rlwy.net
```

The older URL `altaria.proxy.rlwy.net:36192` was a web-terminal route:

```text
external 36192 → container 8080 → ttyd
```

It must not be used for SSH. The current TCP route is the correct SSH route.

## Important limitation

The assistant can prepare commands and files, but cannot type into the user's already-open interactive SSH session or read its password. Run the setup script on the remote VPS after transferring it from Replit Shell.

## Planned test setup

The setup script installs:

- Ollama
- Qwen 2.5 1.5B, a small Apache-2.0-licensed open-weight model
- Cloudflare `cloudflared`
- A temporary Quick Tunnel to Ollama's local API

The script also:

1. Starts Ollama.
2. Downloads the model.
3. Sends a local test prompt.
4. Starts a temporary Cloudflare tunnel.
5. Prints the generated `trycloudflare.com` URL.

The Quick Tunnel URL is temporary and public. Use it only for a short test, do not send private data through it, and stop it when finished.

## Run from Replit Shell

From the workspace root, copy the script to the VPS:

```bash
scp -P 44838 setup_llm.sh admin@tramway.proxy.rlwy.net:/home/admin/setup_llm.sh
```

Then run it remotely:

```bash
ssh -p 44838 admin@tramway.proxy.rlwy.net 'bash /home/admin/setup_llm.sh'
```

The command prints the temporary Cloudflare URL at the end. Keep that SSH command running long enough to copy the URL. The tunnel process is started in the background.

## Test the public URL

If the script prints a URL such as:

```text
https://example-name.trycloudflare.com
```

Test it with:

```bash
curl -X POST https://example-name.trycloudflare.com/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen2.5:1.5b","prompt":"Reply with exactly: LLM is running.","stream":false}'
```

Replace the example hostname with the URL printed by the script.

## Stop the test services

On the VPS:

```bash
pkill -f 'cloudflared tunnel --url' || true
pkill -x ollama || true
```
