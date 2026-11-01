#!/usr/bin/env bash
# IDE e2e harness: launches runIde with the mock pi binary + JCEF CDP,
# waits for readiness, then drives the UI via scripts/e2e-ide.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO="$(pwd)"
export PI_IDE_E2E="$REPO/test/mock-pi/mock-pi.mjs"
export PI_IDE_E2E_PROJECT="$REPO/test/e2e-project"
if [ -z "${JAVA_HOME:-}" ]; then
  # macOS and Linux JDK 21 discovery (Windows uses scripts/e2e-ide.ps1).
  if [ "$(uname)" = "Darwin" ]; then
    export JAVA_HOME="$(echo "$HOME"/Library/Java/JavaVirtualMachines/jdk-21*/Contents/Home)"
  else
    export JAVA_HOME="$(ls -d /usr/lib/jvm/java-21* 2>/dev/null | head -1)"
  fi
fi

./gradlew runIde --console=plain > /tmp/runIde-e2e.log 2>&1 &
GRADLE_PID=$!
trap 'kill $GRADLE_PID 2>/dev/null; pkill -f "idea.required.plugins.id=dev.pi.agent" 2>/dev/null || true' EXIT

echo "waiting for JCEF CDP on :9222 …"
for _ in $(seq 1 40); do
  sleep 5
  if curl -s --max-time 3 http://127.0.0.1:9222/json/version > /dev/null 2>&1; then
    break
  fi
done

echo "waiting for the Pi Agent page …"
for _ in $(seq 1 30); do
  sleep 3
  if curl -s --max-time 3 http://127.0.0.1:9222/json/list 2>/dev/null | grep -q "127.0.0.1:."; then
    break
  fi
done

sleep 5
node scripts/e2e-ide.mjs --screenshot build/e2e-ide.png
