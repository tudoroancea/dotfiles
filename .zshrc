# load zsh profiler
# zmodload zsh/zprof

# only check if we have to regenerate the zcompdump once a day
autoload -Uz compinit
for dump in ~/.zcompdump(N.mh+24); do
  compinit
done
compinit -C

# set locale
export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

# functions and aliases ====================================================
# minimal list
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
alias zrc="$EDITOR ~/.zshrc"
alias vimrc="$EDITOR ~/.vimrc"
alias py="python3"
alias lg=lazygit
alias nv=nvim
ccopy() {
    cat "$1" | pbcopy
}
alias dotf="cd ~/dotfiles && nvim"
# custom mkv
# mkv () {
# 	local name="${1:-venv}"
# 	local venvpath="${name:P}"
# 	uv venv "${name}" || return
# 	echo "Created venv in '${venvpath}'" >&2
# 	vrun "${name}"
# }

# advanced aliases
alias fda='fd -u'
alias sizes='du -h -d 1 .'

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
alias up='uv pip'

export ROS_DOMAIN_ID=69
alias pave='mamba deactivate && mamba activate pave_gnc && cd ~/Developer/pave_gnc && . install/setup.sh'

submodule_rm() {
  git submodule deinit -f -- "$1"
  git rm -f "$1"
  rm -rf .git/modules/"$1"
}

# general shell config ================================================
# rosetta terminal setup
if [ $(arch) = "i386" ]; then
    alias brew86="/usr/local/bin/brew"
fi

# homebrew config =====================================================
eval "$(/opt/homebrew/bin/brew shellenv)"
if type brew &>/dev/null
then
  FPATH="/opt/homebrew/share/zsh/site-functions:${FPATH}"
  autoload -Uz compinit
  compinit
fi
export PATH=/opt/homebrew:$PATH


# brains config
export BRAINS_ROOT_DIR="$HOME/brains"
export BRAINS_EXTERNAL_ROOT_DIR="$HOME/brains_external"
source $BRAINS_ROOT_DIR/aliases.sh
source $BRAINS_EXTERNAL_ROOT_DIR/aliases.sh
export FSDS="$HOME/Formula-Student-Driverless-Simulator"

# MOSEK path
export PATH=/Users/tudoroancea/mosek/10.1/tools/platform/osxaarch64/bin:$PATH

# zig path
export PATH="$HOME/zig:$PATH"

# ikos path
export PATH="$PATH:$HOME/Developer/ikos/bin"

# openssl (idk why we need it but I wouldn't remove it just in case sth breaks)
export OPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl@3

# >>> conda initialize >>>
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

# (oh my) zsh customization ===================================
export EDITOR="nvim"
export ZSH="/Users/tudoroancea/.oh-my-zsh"
ENABLE_CORRECTION="false"
COMPLETION_WAITING_DOTS="true"
VSCODE=code-insiders # vscode flavor used by oh my zsh plugin
export PYTHON_VENV_NAME=".venv" # customize the default venv name used by vrun

# oh my zsh plugins
plugins=(
  git  # for gst, gc, etc.
  brew  # for bubu, etc.
  vscode  # for vsc, vscd, etc.
  python
  zsh-autosuggestions
  zsh-syntax-highlighting
)
source $ZSH/oh-my-zsh.sh

# starship prompt
eval "$(starship init zsh)"


# source cargo installation
. "$HOME/.cargo/env"

# bun
# export BUN_INSTALL="$HOME/.bun"
# export PATH="$BUN_INSTALL/bin:$PATH"
# bun completions
# [ -s "/Users/tudoroancea/.bun/_bun" ] && source "/Users/tudoroancea/.bun/_bun"

. "$HOME/api_keys.sh"

# run zsh profiling
# zprof
