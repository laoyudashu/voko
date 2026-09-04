#!/bin/bash
set -euo pipefail

user_name="${VOKO_TEST_USER:-tjyu}"
user_home="$(getent passwd "$user_name" | cut -d: -f6)"
archive="${VOKO_ZEROCLAW_ARCHIVE:-/tmp/voko-zc-linux.tar.gz}"

test -n "$user_home"
test -f "$archive"
install_dir="$(mktemp -d /tmp/voko-zeroclaw-install.XXXXXX)"
tar -xzf "$archive" -C "$install_dir" zeroclaw
install -d -m 0755 -o "$user_name" -g "$user_name" "$user_home/.local/bin"
install -m 0755 -o "$user_name" -g "$user_name" "$install_dir/zeroclaw" "$user_home/.local/bin/zeroclaw"

runuser -l "$user_name" -c '
  set -e
  export PATH="$HOME/.local/bin:$PATH"
  test -n "$DEEPSEEK_API_KEY"
  zero_alias="$(zeroclaw agents list 2>/dev/null | awk "NF && \$1 !~ /Alias/ {print \$1; exit}")"
  test -n "$zero_alias"
  # ACP dispatch requires an explicit runtime identity even when the CLI can
  # fall back to its built-in default. Persist it so readiness and the real
  # Gateway enforce the same Agent definition.
  if ! grep -q "^\[runtime_profiles\.default\]" "$HOME/.zeroclaw/config.toml"; then
    zeroclaw config init runtime_profiles.default >/dev/null
  fi
  if ! zeroclaw config get "agents.$zero_alias.runtime_profile" --json >/dev/null 2>&1; then
    zeroclaw config set "agents.$zero_alias.runtime_profile" default >/dev/null
  fi
  zeroclaw security status --agent "$zero_alias" --json >/dev/null
  zeroclaw service install >/tmp/voko-zeroclaw-service-install.log 2>&1 || true
  zeroclaw service start >/tmp/voko-zeroclaw-service-start.log 2>&1 || zeroclaw service restart >/tmp/voko-zeroclaw-service-restart.log 2>&1
  for i in $(seq 1 30); do curl -fsS http://127.0.0.1:42617/health >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS http://127.0.0.1:42617/health >/dev/null
  pair_text="$(zeroclaw gateway get-paircode --new 2>&1)"
  pair_code="$(printf "%s" "$pair_text" | grep -Eo "[0-9]{6}" | tail -1)"
  test -n "$pair_code"
  pair_json="$(curl -fsS -X POST http://127.0.0.1:42617/pair -H "X-Pairing-Code: $pair_code")"
  token="$(printf "%s" "$pair_json" | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>process.stdout.write(JSON.parse(s).token||\"\"))")"
  test -n "$token"
  install -d -m 700 "$HOME/.config/voko/credentials"
  umask 077
  printf "%s\n" "$token" > "$HOME/.config/voko/credentials/zeroclaw-acp-token"
  chmod 600 "$HOME/.config/voko/credentials/zeroclaw-acp-token"
  node /tmp/provision-test-provider-gateways.js --apply --hermes --zeroclaw \
    --bind-zeroclaw-agent AUTO-REG-LINUX-20260828 \
    --zeroclaw-agent-name TEST-LINUX-ZEROCLAW --zeroclaw-alias "$zero_alias"
  npm install -g /tmp/voko-gateway-final.tgz >/tmp/voko-package-install.log 2>&1
  install -d -m 700 "$HOME/.config/voko/logs"
  voko stop >"$HOME/.config/voko/logs/test-stop.log" 2>&1 || true
  nohup voko start --no-open >"$HOME/.config/voko/logs/test-start.log" 2>&1 &
  echo zero_version=$(zeroclaw --version | tr " " _)
  echo zero_gateway=ready
  echo zero_token_file=private
  echo voko_restart=started
'
