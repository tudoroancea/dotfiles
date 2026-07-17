source $HOME/zen_api_key.sh
source $HOME/pave_api_key.sh

export PATH="$PATH:/opt/pi"
export PATH="$PATH:/opt/nvim-linux-x86_64/bin"
export PATH="$PATH:/opt/btop/bin"
export PATH="$PATH:/opt/lazygit"
export PATH="$PATH:/opt/fzf"
. "$HOME/.local/bin/env"

eval "$(uv generate-shell-completion zsh)"
# export UV_PYTHON_PREFERENCE=only-managed

# bun completions
[ -s "/home/ted/.bun/_bun" ] && source "/home/ted/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"


# nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init zsh)"; fi

# nub
export PATH="$HOME/.nub/bin:$PATH"
export PATH="$($HOME/.nub/bin/nub bin -g):$PATH"

# go
export PATH="/opt/go/bin:$PATH"
export PATH="$HOME/go/bin:$PATH"

