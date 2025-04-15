# load zsh profiler
# zmodload zsh/zprof

# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# Only check for new completion files once per day
autoload -Uz compinit
if [ $(date +'%j') != $(stat -f '%Sm' -t '%j' ~/.zcompdump 2>/dev/null) ]; then
  compinit
else
  compinit -C
fi

# set locale
export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

# source cargo installation (for uv)
. "$HOME/.local/bin/env"

# general functions and aliases ====================================================
alias reloadzsh="source ~/.zshrc"
alias ll="ls -la"
alias l="ls -lah"
alias cdt="cd ~/tmp"
cl() {
  cd "$1" && l
}
mcd() {
  mkdir -p "$1"
  cd "$1"
}
waw() {
  echo "  where :"
  where "$1"
  echo "  which :"
  which "$1"
  echo " version :"
  $(which "$1") --version
}
alias rmr="rm -r"
alias rmrf="rm -rf"
alias py="python3"
alias pdb="python3 -m pdb"
alias lg=lazygit
alias c='code'
alias z='zed'
alias nv=nvim
alias v=nvim
alias va='NVIM_APPNAME=nvim-astronvim nvim'
alias vk='NVIM_APPNAME=nvim-kickstart nvim'
alias vs='NVIM_APPNAME=nvim-from-scratch nvim'
vv() {
  # Assumes all configs exist in directories named ~/.config/nvim-*
  local config=$(fd --max-depth 1 --glob 'nvim*' ~/.config | fzf --prompt="Neovim Configs > " --height=~50% --layout=reverse --border --exit-0)

  # If I exit fzf without selecting a config, don't open Neovim
  [[ -z $config ]] && echo "No config selected" && return

  # Open Neovim with the selected config
  NVIM_APPNAME=$(basename $config) nvim $@
}
ccopy() {
    cat "$1" | pbcopy
}
alias dotf="cd ~/dotfiles && nvim"
alias fda='fd -u'
alias sizes='du -h -d 1 .'
submodule_rm() {
  git submodule deinit -f -- "$1"
  git rm -f "$1"
  rm -rf .git/modules/"$1"
}

# mamba aliases
alias ma=mamba
alias mact='mamba activate'
alias mde='mamba deactivate'
alias mls='mamba list'
alias mels='mamba env list'
alias mcen='mamba create -n'
alias mup='mamba update'
alias min='mamba install'
alias miny='mamba install -y'
alias mind='mamba install -d'

# project specific aliases and configurations ===============================================
alias brains2='cd ~/dev/brains2 && conda activate brains2 && . install/setup.sh'
alias purge="./scripts/purge.sh"
alias build="./scripts/build.sh"
# alias test="./scripts/test.sh"

# homebrew config =====================================================-==============
eval "$(/opt/homebrew/bin/brew shellenv)"
if type brew &>/dev/null
then
  FPATH="/opt/homebrew/share/zsh/site-functions:${FPATH}"
  autoload -Uz compinit
  compinit
fi
export PATH=/opt/homebrew:$PATH

# openssl (idk why we need it but I wouldn't remove it just in case sth breaks)
export OPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl@3

# >>> conda initialize >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
# !! Contents within this block are managed by 'conda init' !!
__conda_setup="$('/Users/tudoroancea/miniforge3/bin/conda' 'shell.zsh' 'hook' 2> /dev/null)"
if [ $? -eq 0 ]; then
    eval "$__conda_setup"
else
    if [ -f "/Users/tudoroancea/miniforge3/etc/profile.d/conda.sh" ]; then
        . "/Users/tudoroancea/miniforge3/etc/profile.d/conda.sh"
    else
        export PATH="/Users/tudoroancea/miniforge3/bin:$PATH"
    fi
fi
unset __conda_setup

if [ -f "/Users/tudoroancea/miniforge3/etc/profile.d/mamba.sh" ]; then
    . "/Users/tudoroancea/miniforge3/etc/profile.d/mamba.sh"
fi
# <<< conda initialize <<<

# general tools configuration =====================================================

# uv configuration
eval "$(uv generate-shell-completion zsh)"
export UV_PYTHON_PREFERENCE=only-managed
export UV_PYTHON=3.12


# bun completions
[ -s "/Users/tudoroancea/.bun/_bun" ] && source "/Users/tudoroancea/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# fzf 
source <(fzf --zsh)

# API keys for OpenAI and Anthropic 
. "$HOME/api_keys.sh"

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

# (oh my) zsh customization ==========================================================
export EDITOR="nvim"
export ZSH="/Users/tudoroancea/.oh-my-zsh"
ENABLE_CORRECTION="false"
COMPLETION_WAITING_DOTS="true"
VSCODE=code # vscode flavor used by oh my zsh plugin
export PYTHON_VENV_NAME=".venv" # customize the default venv name used by vrun

# 0, 1 - Blinking block
# 2 - Solid block
# 3 - Blinking underline
# 4 - Solid underline
# 5 - Blinking line
# 6 - Solid line
VI_MODE_SET_CURSOR=true
VI_MODE_CURSOR_NORMAL=1
VI_MODE_CURSOR_VISUAL=1
VI_MODE_CURSOR_INSERT=5
VI_MODE_CURSOR_OPPEND=0
MODE_INDICATOR="%F{white}+%f"
INSERT_MODE_INDICATOR="%F{yellow}+%f"
ZSH_THEME="powerlevel10k/powerlevel10k"
# oh my zsh plugins
plugins=(
  git  # for gst, gc, etc.
  brew  # for bubu, etc.
  vscode  # for vsc, vscd, etc.
  python
  tmux
  zsh-interactive-cd
  zsh-autosuggestions
  zsh-syntax-highlighting
  zsh-fzf-history-search
)
source $ZSH/oh-my-zsh.sh

# starship prompt
# eval "$(starship init zsh)"

# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# run zsh profiling
# zprof

# Added by LM Studio CLI (lms)
export PATH="$PATH:/Users/tudoroancea/.lmstudio/bin"

# Added by Windsurf
export PATH="/Users/tudoroancea/.codeium/windsurf/bin:$PATH"
