export PATH="$PATH:/opt/nvim-linux-x86_64/bin"
export PATH="$PATH:/opt/btop/bin"
export PATH="$PATH:/opt/lazygit"
. "$HOME/.local/bin/env"

eval "$(uv generate-shell-completion zsh)"
export UV_PYTHON_PREFERENCE=only-managed
