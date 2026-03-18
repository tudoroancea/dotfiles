# API keys ==========================================================================
source ~/gemini-cli.sh
source ~/pave_api_key.sh
source ~/zen_api_key.sh
source ~/openrouter_api_key.sh

# homebrew config =====================================================-==============
eval "$(/opt/homebrew/bin/brew shellenv)"
if type brew &>/dev/null
then
  FPATH="/opt/homebrew/share/zsh/site-functions:${FPATH}"
  autoload -Uz compinit
  compinit
fi
export PATH=/opt/homebrew:$PATH

export CPPFLAGS="-I/opt/homebrew/include -I/opt/homebrew/include/eigen3"

# openssl (idk why we need it but I wouldn't remove it just in case sth breaks)
export OPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl@3

# general tools configuration =====================================================
export PATH="/Users/tudoroancea/.local/bin:/opt/zerobrew/prefix/bin:$PATH"

# uv configuration
. "$HOME/.local/bin/env"
eval "$(uv generate-shell-completion zsh)"
export UV_PYTHON_PREFERENCE=only-managed
# Fix completions for uv run to autocomplete .py files
_uv_run_mod() {
    if [[ "$words[2]" == "run" && "$words[CURRENT]" != -* ]]; then
        _arguments '*:filename:_files -g "*.py"'
    else
        _uv "$@"
    fi
}
compdef _uv_run_mod uv

# opencode
export PATH=/Users/tudoroancea/.opencode/bin:$PATH

# bun completions
[ -s "/Users/tudoroancea/.bun/_bun" ] && source "/Users/tudoroancea/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# go
export PATH="$HOME/go/bin:$PATH"

# fzf
source <(fzf --zsh)

# compdef gt
###-begin-gt-completions-###
#
# yargs command completion script
#
# Installation: gt completion >> ~/.zshrc
#    or gt completion >> ~/.zprofile on OSX.
#
_gt_yargs_completions()
{
  local reply
  local si=$IFS
  IFS=$'
' reply=($(COMP_CWORD="$((CURRENT-1))" COMP_LINE="$BUFFER" COMP_POINT="$CURSOR" gt --get-yargs-completions "${words[@]}"))
  IFS=$si
  _describe 'values' reply
}
compdef _gt_yargs_completions gt
###-end-gt-completions-###

export PATH="$PATH:/Users/tudoroancea/.modular/bin"
eval "$(magic completion --shell zsh)"
export PATH="$PATH:/Users/tudoroancea/.lmstudio/bin"
export PATH="$PATH:$HOME/.zvm/self"
export PATH="/Users/tudoroancea/.antigravity/antigravity/bin:$PATH"
export RIPGREP_CONFIG_PATH="$HOME/.ripgreprc"

# >>> conda initialize >>>
# !! Contents within this block are managed by 'conda init' !!
__conda_setup="$('/opt/homebrew/Caskroom/miniforge/base/bin/conda' 'shell.zsh' 'hook' 2> /dev/null)"
if [ $? -eq 0 ]; then
    eval "$__conda_setup"
else
    if [ -f "/opt/homebrew/Caskroom/miniforge/base/etc/profile.d/conda.sh" ]; then
        . "/opt/homebrew/Caskroom/miniforge/base/etc/profile.d/conda.sh"
    else
        export PATH="/opt/homebrew/Caskroom/miniforge/base/bin:$PATH"
    fi
fi
unset __conda_setup
# <<< conda initialize <<<

# worktrunk
if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init zsh)"; fi

