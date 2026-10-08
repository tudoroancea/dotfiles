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
ssh -t user@server 'sudo apt-get update && sudo apt-get install -y git'
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
| `raspi`    | `linux-arm64` | `server,pi`  |
| `la015`    | `linux-x64`   | `dev,linux,pi`     |
| `bestiav2` | `macos-arm64` | `dev,macos,pi`     |

## tool lockfiles

The existing locks use format 2, generated with mise 2026.9.11; the Linux lock uses format 3, generated with mise 2026.10.3. Use mise 2026.10.3 or newer for this checkout. The platform mapping assumes a 64-bit Raspberry Pi OS installation.

Track `mise*.lock` and the entire `locks/` directory together. Each config owns its lockfile: the base uses `mise.lock`, and overlays use `mise.dev.lock`, `mise.server.lock`, `mise.macos.lock`, `mise.linux.lock`, and `mise.pi.lock`. Shared locks contain artifacts for multiple platforms; npm dependency graphs retain platform-specific optional packages.

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

### T3 Code nightly on Linux

`config.linux.toml` declares the npm package `t3` with the `nightly` dist-tag, not `latest` (the stable channel). `mise.linux.lock` references the frozen dependency graph in `locks/mise.linux/`, which records the exact nightly release and includes packages for `linux-x64` and `linux-arm64`. Selecting the Linux environment makes the `t3` command available. Nightly updates are deliberate, not automatic on every install.

To install the recorded release after pulling:

```bash
mise -E dev,linux install --locked npm:t3
mise -E dev,linux exec -- t3 --version
```

To update only T3 to the newest nightly, relock both Linux architectures, then install and verify on the current machine:

```bash
mise -E linux lock --global --bump --platform linux-x64,linux-arm64 npm:t3
mise -E dev,linux install --locked npm:t3
mise -E dev,linux exec -- t3 --version
```

Add `--dry-run` to the lock command to preview the update. Review and commit `config.linux.toml`, `mise.linux.lock`, and `locks/mise.linux/` together when adding the tool; subsequent updates normally change only the lockfile and dependency sidecars. No separate global npm install is needed. On a server, replace `dev,linux` with `server,linux` in the install and verification commands. Both Linux machine profiles in the table above already select `linux`; include the role overlay because the npm launcher needs Node.js, supplied by `dev` or `server`. Locking alone does not need Node.js. Mise may retain `nightly` as the version in `mise.linux.lock`; the concrete release is frozen in the referenced `aube-lock.yaml`.

These locks cover `[tools]`, not mise itself, apt/Homebrew bootstrap packages, shell-plugin Git checkouts, or project dependencies. `agents/pi/nub.lock` remains the separate lock for the Pi extension workspace. Dev and server declare some tools separately; update both profiles to keep their shared tools aligned.
