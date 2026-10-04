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
mise --locked -E dev,macos,pi bootstrap --adopt git@github.com:tudoroancea/dotfiles.git --dry-run
mise --locked -E dev,macos,pi bootstrap --adopt git@github.com:tudoroancea/dotfiles.git
```

## new remote linux server

```bash
mise bootstrap remote \
  --host user@server \
  --install-mise \
  --adopt git@github.com:tudoroancea/dotfiles.git \
  --update \
  --remote-env server,linux,pi # raspi; use dev,linux,pi for la015
```

## env mapping

| machine    | platform      | envs              |
| ---------- | ------------- | ----------------- |
| `raspi`    | `linux-arm64` | `server,linux,pi`  |
| `la015`    | `linux-x64`   | `dev,linux,pi`     |
| `bestiav2` | `macos-arm64` | `dev,macos,pi`     |

## tool lockfiles

Generated with mise 2026.9.11. Use that version or newer with lockfile format 2 support. The platform mapping assumes a 64-bit Raspberry Pi OS installation.

Track `mise*.lock` and the entire `locks/` directory together. Each config owns its lockfile: the base uses `mise.lock`, and overlays use `mise.dev.lock`, `mise.server.lock`, `mise.macos.lock`, and `mise.pi.lock`. Linux has no tool declarations, so it needs no separate lockfile. Shared locks contain artifacts for multiple platforms; npm dependency graphs retain platform-specific optional packages.

Most configs keep `latest` selectors, but normal installs use the recorded releases. Zig and ZLS are constrained to the compatible 0.16 series. npm tools, including npm itself, use mise's embedded aube installer to replay their frozen dependency graphs. uv uses the Aqua backend so its binary URLs and checksums are locked instead of relying on an asdf plugin.

Install the recorded tools after pulling, using the machine's envs:

```bash
mise -E dev,macos,pi install --locked
```

To deliberately update releases, run these commands sequentially from this directory. They share the base and Pi lockfiles, so do not run them concurrently.

```bash
mise -E dev,macos,pi lock --global --bump --platform macos-arm64
mise -E dev,linux,pi lock --global --bump --platform linux-x64
mise -E server,linux,pi lock --global --bump --platform linux-arm64
```

Add `--dry-run` to preview updates. Omit `--bump` to fill or refresh metadata without advancing recorded releases. Review all lockfile and `locks/` changes, install with `--locked`, and test on the target machines before committing. Upgrade Zig and ZLS together by changing both config constraints.

These locks cover `[tools]`, not mise itself, apt/Homebrew bootstrap packages, shell-plugin Git checkouts, or project dependencies. `agents/pi/nub.lock` remains the separate lock for the Pi extension workspace. Dev and server declare some tools separately; update both profiles to keep their shared tools aligned.
