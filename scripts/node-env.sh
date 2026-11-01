# Prepend the newest nvm-managed Node to PATH so tooling spawned from this
# shell (npm build steps, e2e drivers) finds it. Override with NODE_VERSION.
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -d "$NVM_DIR/versions/node" ]; then
  NODE_VERSION="${NODE_VERSION:-$(ls "$NVM_DIR/versions/node" | sort -V | tail -1)}"
  export PATH="$NVM_DIR/versions/node/$NODE_VERSION/bin:$PATH"
fi
