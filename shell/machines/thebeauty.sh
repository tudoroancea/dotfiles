# API keys ==========================================================================
. "$HOME/api_keys.sh"

# homebrew config =====================================================-==============
eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"

# >>> conda initialize >>> ====================================================================
# !! Contents within this block are managed by 'conda init' !!
__conda_setup="$('/home/ted/miniforge3/bin/conda' 'shell.bash' 'hook' 2> /dev/null)"
if [ $? -eq 0 ]; then
    eval "$__conda_setup"
else
    if [ -f "/home/ted/miniforge3/etc/profile.d/conda.sh" ]; then
        . "/home/ted/miniforge3/etc/profile.d/conda.sh"
    else
        export PATH="/home/ted/miniforge3/bin:$PATH"
    fi
fi
unset __conda_setup
# <<< conda initialize <<<

# general tools configuration =====================================================
eval "$(uv generate-shell-completion zsh)"
export UV_PYTHON_PREFERENCE=only-managed

# fzf
source <(fzf --zsh)

# cuda
export PATH=/usr/local/cuda-12.6/bin${PATH:+:${PATH}}
