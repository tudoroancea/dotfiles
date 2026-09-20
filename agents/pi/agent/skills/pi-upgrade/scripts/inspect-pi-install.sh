#!/usr/bin/env bash

set -u

package='@earendil-works/pi-coding-agent'

command_path=$(command -v pi 2>/dev/null || true)
resolved_path=''
if [[ -n "$command_path" ]]; then
  resolved_path=$(realpath "$command_path" 2>/dev/null || printf '%s' "$command_path")
fi

version='unavailable'
if [[ -n "$command_path" ]]; then
  version=$(pi --version 2>/dev/null || printf 'unavailable')
fi

installer='unknown'
installer_evidence='no supported global package manager claimed the resolved executable'

if command -v nub >/dev/null 2>&1; then
  nub_entry=$(nub list --global "$package" --parseable 2>/dev/null | head -n 1 || true)
  if [[ -n "$nub_entry" && ( "$resolved_path" == *'/global-nub/'* || "$command_path" == *'/pnpm/'* ) ]]; then
    installer='nub'
    installer_evidence="$nub_entry"
  fi
fi

if [[ "$installer" == 'unknown' ]] && command -v pnpm >/dev/null 2>&1; then
  pnpm_root=$(pnpm root --global 2>/dev/null || true)
  if [[ -n "$pnpm_root" && "$resolved_path" == "$pnpm_root/"* ]]; then
    installer='pnpm'
    installer_evidence="$pnpm_root"
  fi
fi

if [[ "$installer" == 'unknown' ]] && command -v npm >/dev/null 2>&1; then
  npm_root=$(npm root --global 2>/dev/null || true)
  if [[ -n "$npm_root" && "$resolved_path" == "$npm_root/"* ]]; then
    installer='npm'
    installer_evidence="$npm_root"
  fi
fi

if [[ "$installer" == 'unknown' ]] && command -v bun >/dev/null 2>&1; then
  bun_bin=$(bun pm bin --global 2>/dev/null || true)
  if [[ -n "$bun_bin" && "$command_path" == "$bun_bin/"* ]]; then
    installer='bun'
    installer_evidence="$bun_bin"
  fi
fi

if [[ "$installer" == 'unknown' ]] && command -v yarn >/dev/null 2>&1; then
  yarn_dir=$(yarn global dir 2>/dev/null || true)
  if [[ -n "$yarn_dir" && "$resolved_path" == "$yarn_dir/"* ]]; then
    installer='yarn'
    installer_evidence="$yarn_dir"
  fi
fi

latest='unavailable'
if command -v nub >/dev/null 2>&1; then
  latest=$(nub view "$package" version 2>/dev/null || printf 'unavailable')
elif command -v npm >/dev/null 2>&1; then
  latest=$(npm view "$package" version 2>/dev/null || printf 'unavailable')
fi

printf 'pi.command=%s\n' "${command_path:-unavailable}"
printf 'pi.resolved=%s\n' "${resolved_path:-unavailable}"
printf 'pi.version=%s\n' "$version"
printf 'pi.latest=%s\n' "$latest"
printf 'pi.installer=%s\n' "$installer"
printf 'pi.installer_evidence=%s\n' "$installer_evidence"
