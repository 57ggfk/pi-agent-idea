#!/usr/bin/env bash
# Real-pi IDE e2e: launches runIde with the user's own pi (no mock) and drives
# a real prompt against openrouter/free ("Free Models Router").
# Requires: openrouter credential in ~/.pi/agent/auth.json and the
# openrouter/free model registered in ~/.pi/agent/models.json.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="$(pwd)"
export PI_IDE_E2E="real"
export PI_IDE_E2E_PROJECT="${PI_IDE_E2E_PROJECT:-$REPO/test/e2e-project}"
export JAVA_HOME="${JAVA_HOME:-$(echo "$HOME"/Library/Java/JavaVirtualMachines/jdk-21*/Contents/Home)}"
source scripts/node-env.sh

./gradlew runIde --console=plain > /tmp/runIde-real-e2e.log 2>&1 &
GRADLE_PID=$!
trap 'kill $GRADLE_PID 2>/dev/null; pkill -f "idea.required.plugins.id=dev.pi.agent" 2>/dev/null || true' EXIT

echo "waiting for JCEF CDP on :9222 …"
for _ in $(seq 1 40); do
  sleep 5
  if curl -s --max-time 3 http://127.0.0.1:9222/json/version > /dev/null 2>&1; then break; fi
done
echo "waiting for the Pi Agent page …"
for _ in $(seq 1 30); do
  sleep 3
  if curl -s --max-time 3 http://127.0.0.1:9222/json/list 2>/dev/null | grep -q "127.0.0.1:."; then break; fi
done
sleep 5
node scripts/e2e-ide-real.mjs
