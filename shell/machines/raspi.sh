# API keys ==========================================================================
source ~/pave_api_key.sh

# general tools configuration =====================================================
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

# fzf
[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh

# >>> mamba initialize >>>
# !! Contents within this block are managed by 'mamba init' !!
export MAMBA_EXE='/home/raspi/y/micromamba';
export MAMBA_ROOT_PREFIX='/home/raspi/y';
__mamba_setup="$("$MAMBA_EXE" shell hook --shell zsh --root-prefix "$MAMBA_ROOT_PREFIX" 2> /dev/null)"
if [ $? -eq 0 ]; then
    eval "$__mamba_setup"
else
    alias micromamba="$MAMBA_EXE"  # Fallback on help from mamba activate
fi
unset __mamba_setup
# <<< mamba initialize <<<

# bun completions
[ -s "/home/raspi/.bun/_bun" ] && source "/home/raspi/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

export PATH="$PATH:$HOME/pi"

# opencode
export PATH=/home/raspi/.opencode/bin:$PATH
