# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# Only check for new completion files once per day
autoload -Uz compinit
for dump in ~/.zcompdump(N.mh+24); do
  compinit
done
compinit -C

# set locale
export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

# general functions and aliases
source $HOME/dotfiles/shell/aliases.sh

# machine specific config
if [[ "$(uname -s)" == "Darwin" ]]; then
  MACHINE_NAME="$(scutil --get ComputerName 2>/dev/null)"
else
  MACHINE_NAME="$(hostnamectl --static 2>/dev/null)"
fi
source "$HOME/dotfiles/shell/machines/${MACHINE_NAME}.sh"


# (oh my) zsh customization
export EDITOR="nvim"
export ZSH="$HOME/.oh-my-zsh"
ENABLE_CORRECTION="false"
COMPLETION_WAITING_DOTS="true"
export PYTHON_VENV_NAME=".venv" # customize the default venv name used by vrun
ZSH_THEME="powerlevel10k/powerlevel10k"
# oh my zsh plugins
plugins=(
  git  # for gst, gc, etc.
  brew  # for bubu, etc.
  zsh-interactive-cd
  zsh-autosuggestions
  zsh-syntax-highlighting
  zsh-fzf-history-search
)
source $ZSH/oh-my-zsh.sh

# Enable Powerlevel10k instant prompt. Should stay close to the end of ~/.zshrc.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh
