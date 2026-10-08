#!/usr/bin/env bash
set -euo pipefail

# Work from this checkout regardless of where the script was invoked.
cd "$(dirname "${BASH_SOURCE[0]}")"

lock_paths=(mise.dev.lock mise.linux.lock mise.pi.lock locks/mise.dev locks/mise.linux locks/mise.pi)

# Require a branch and clean lock paths so existing edits are not committed.
branch=$(git symbolic-ref --short HEAD)
if [[ -n "$(git status --porcelain -- "${lock_paths[@]}")" ]]; then
  echo "Commit or stash existing changes to agent/T3 lockfiles and sidecars first." >&2
  exit 1
fi

# Resolve the latest agents for both development machines.
mise -E dev lock --global --bump --minimum-release-age=0 --platform macos-arm64,linux-x64 npm:@openai/codex claude
mise -E pi lock --global --bump --minimum-release-age=0 --platform macos-arm64,linux-x64,linux-arm64 npm:@earendil-works/pi-coding-agent
# Resolve the newest T3 nightly and lock both Linux architectures.
mise -E linux lock --global --bump --minimum-release-age=0 --platform linux-x64,linux-arm64 npm:t3

# Install the recorded versions locally and check each agent starts.
mise install --locked npm:@openai/codex claude npm:@earendil-works/pi-coding-agent
for agent in codex claude pi; do
  mise exec -- "$agent" --version
done

# Commit only changed lockfiles and sidecars, leaving unrelated staging intact.
git add -A -- "${lock_paths[@]}"
if ! git diff --cached --quiet -- "${lock_paths[@]}"; then
  git commit --only -m "Update agent and T3 locks" -- "${lock_paths[@]}"
fi
# Push this branch before deploying, even if no new lock commit was needed.
git push origin "HEAD:refs/heads/$branch"
revision=$(git rev-parse HEAD)

# Pass the branch and pushed commit safely to LA015's remote Bash script.
printf -v remote_command 'bash -s -- %q %q' "$branch" "$revision"
ssh LA015ts "$remote_command" <<'REMOTE'
set -euo pipefail
# Make mise available in the non-interactive SSH shell and enter its checkout.
export PATH="$HOME/.local/bin:$PATH"
cd "$HOME/.config/mise"

# Refuse to change branches or overwrite remote edits.
if [[ "$(git symbolic-ref --short HEAD)" != "$1" ]]; then
  echo "LA015 is on a different branch; refusing to update it." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "LA015's mise checkout has local changes; refusing to update it." >&2
  exit 1
fi
# Fast-forward the remote checkout and require the exact pushed commit.
git pull --ff-only origin "$1"
if [[ "$(git rev-parse HEAD)" != "$2" ]]; then
  echo "LA015 is not at the pushed commit; refusing to install different locks." >&2
  exit 1
fi

# Install and verify all four tools using LA015's miserc.toml environment.
mise install --locked npm:@openai/codex claude npm:@earendil-works/pi-coding-agent npm:t3
for tool in codex claude pi t3; do
  mise exec -- "$tool" --version
done

# Update the remote T3 service to the installed version.
mise exec -- t3 service install
REMOTE
