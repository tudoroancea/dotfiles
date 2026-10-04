# setup

## new macbook

```bash
# install Command Line Tools (for git)
xcode-select -p || xcode-select --install
git --version

# Install mise and expose it
curl -fsSL https://mise.run | sh
export PATH="$HOME/.local/bin:$PATH"
mise --version

# configure github credentials
mise use -g gh
mise x gh -- gh auth login --hostname github.com --git-protocol ssh --web
mise x gh -- gh auth setup-git --hostname github.com

# run bootstrap
mise bootstrap --adopt git@github.com:tudoroancea/dotfiles.git --dry-run
mise bootstrap --adopt git@github.com:tudoroancea/dotfiles.git
```

## new remote linux server

```bash
mise bootstrap remote \
  --host user@server \
  --install-mise \
  --adopt git@github.com:tudoroancea/dotfiles.git \
  --update \
  --env linux,... # edit here the exact overlay list
```

## env mapping

| machine    | envs              |
| ---------- | ----------------- |
| `raspi`    | `server,linux,pi` |
| `la015`    | `dev,linux,pi`    |
| `bestiav2` | `dev,macos,pi`    |
