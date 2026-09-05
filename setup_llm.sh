#!/usr/bin/env bash
set -euo pipefail

MODEL="qwen2.5:1.5b"
OLLAMA_LOG="/tmp/ollama.log"
CLOUDFLARED_LOG="/tmp/cloudflared.log"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root inside the VPS/container."
  echo "If this account has no root privileges, run it from the provider root console."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "Installing required system packages..."
apt-get update
apt-get install -y ca-certificates curl

if ! command -v ollama >/dev/null 2>&1; then
  echo "Installing Ollama..."
  curl -fsSL https://ollama.com/install.sh | sh
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Installing cloudflared..."
  arch="$(dpkg --print-architecture)"
  case "$arch" in
    amd64)
      cloudflared_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
      ;;
    arm64)
      cloudflared_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
      ;;
    *)
      echo "Unsupported Debian architecture: $arch"
      exit 1
      ;;
  esac

  curl -fL "$cloudflared_url" -o /tmp/cloudflared
  install -m 0755 /tmp/cloudflared /usr/local/bin/cloudflared
  rm -f /tmp/cloudflared
fi

if ! pgrep -x ollama >/dev/null 2>&1; then
  echo "Starting Ollama..."
  nohup ollama serve >"$OLLAMA_LOG" 2>&1 &
fi

echo "Waiting for Ollama API..."
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  echo "Ollama did not start. Recent log:"
  tail -50 "$OLLAMA_LOG" || true
  exit 1
fi

echo "Downloading model: $MODEL"
ollama pull "$MODEL"

echo "Running local model test..."
curl -fsS http://127.0.0.1:11434/api/generate \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"prompt\":\"Reply with exactly: LLM is running.\",\"stream\":false}"
echo

if ! pgrep -af 'cloudflared tunnel --url' >/dev/null 2>&1; then
  echo "Starting temporary Cloudflare Quick Tunnel..."
  nohup cloudflared tunnel --url http://127.0.0.1:11434 >"$CLOUDFLARED_LOG" 2>&1 &
fi

echo "Waiting for the Cloudflare URL..."
tunnel_url=""
for _ in $(seq 1 30); do
  tunnel_url="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$CLOUDFLARED_LOG" | head -1 || true)"
  if [ -n "$tunnel_url" ]; then
    break
  fi
  sleep 1
done

if [ -z "$tunnel_url" ]; then
  echo "Cloudflare tunnel did not print a URL. Recent log:"
  tail -50 "$CLOUDFLARED_LOG" || true
  exit 1
fi

echo
echo "LLM is running locally at: http://127.0.0.1:11434"
echo "Temporary public test URL: $tunnel_url"
echo
echo "Test with:"
echo "curl -X POST $tunnel_url/api/generate -H 'Content-Type: application/json' -d '{\"model\":\"$MODEL\",\"prompt\":\"Say hello\",\"stream\":false}'"
echo
echo "Warning: this Quick Tunnel is public and temporary. Stop it after testing."