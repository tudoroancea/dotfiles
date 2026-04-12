export GEMFURY_TOKEN="DNruk-h7GTz1EeMJL9vxJeBdxd3Qr3Hko"
export UV_INDEX_MOREAU_USERNAME="$GEMFURY_TOKEN"
export UV_INDEX_MOREAU_PASSWORD=""
export PATH="$PATH:$HOME/.local/bin"
. "$HOME/.local/bin/env"

# uv
eval "$(uv generate-shell-completion zsh)"
export UV_PYTHON_PREFERENCE=only-managed

# bun completions
[ -s "/home/ted/.bun/_bun" ] && source "/home/ted/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# worktrunk
if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init zsh)"; fi
