
# Install brew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Enable brew
(
  echo
  echo 'eval "$(/opt/homebrew/bin/brew shellenv)"'
) >>/Users/mrf/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

brew update
brew upgrade
brew install wakeonlan zig hyperfine clang-format tinymist ffmpeg btop neovim node zsh lazygit ripgrep fzf fd curl fastfetch git gh gcc cmake luajit tmux tree typst tee-sitter logi-options+ ruff basedpyright
brew install --cask 1password-cli 1password xquartz alacritty ghostty zed@preview slack telegram whatsapp visual-studio-code raycast foxglove-studio zerotier-one orbstack obsidian notion notion-calendar


git clone --recurse-submodules https://github.com/tudoroancea/dotfiles ~/dotfiles


# change default shell
chsh -s /opt/homebrew/bin/zsh
# install oh-my-zsh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
# clone oh-my-zsh plugins
git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
git clone https://github.com/joshskidmore/zsh-fzf-history-search ${ZSH_CUSTOM:=~/.oh-my-zsh/custom}/plugins/zsh-fzf-history-search
ln -s ~/dotfiles/.p10k.zsh .p10k.zsh
# symlink zshrc
ln -s ~/dotfiles/.zshrc ~/.zshrc

# install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# setup neovim
ln -s ~/dotfiles/nvim-kickstart ~/.config/nvim
nvim --headless "+Lazy! install" +MasonInstall +q!

# lazygit
ln -s ~/dotfiles/lazygit/config.yml ~/Library/Application\ Support/lazygit/config.yml

# vscode
ln -s ~/dotfiles/vscode/settings.json ~/Library/Application\ Support/Code/User/settings.json
ln -s ~/dotfiles/vscode/keybindings.json ~/Library/Application\ Support/Code/User/keybindings.json

# zed
ln -s ~/dotfiles/zed/keymap.json ~/.config/zed/keymap.json
ln -s ~/dotfiles/zed/settings.json ~/.config/zed/settings.json
ln -s ~/dotfiles/zed/tasks.json ~/.config/zed/tasks.json

# ghostty 
ln -s ~/dotfiles/ghostty ~/.config/ghostty

# alacritty
ln -s ~/dotfiles/alacritty ~/.config/alacritty

# tmux
ln -s ~/dotfiles/.tmux.conf ~/.tmux.conf

# TODO: API keys
# TODO: gitconfig
# TODO: macOS defaults
