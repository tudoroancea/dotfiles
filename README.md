# setup

You can clone this repo with

```bash
git clone --recurse-submodules https://github.com/tudoroancea/dotfiles ~/dotfiles
```

and then follow the following steps to install the different components:

## zsh

```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
git clone --depth=1 https://github.com/romkatv/powerlevel10k.git ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
git clone https://github.com/joshskidmore/zsh-fzf-history-search ${ZSH_CUSTOM:=~/.oh-my-zsh/custom}/plugins/zsh-fzf-history-search
# (old prompt): curl -sS https://starship.rs/install.sh | sh
ln -s ~/dotfiles/.zshrc ~/.zshrc
ln -s ~/dotfiles/.p10k.zsh ~/.p10k.zsh
```

## tmux

```bash
ln -s ~/dotfiles/.tmux.conf ~/.tmux.conf
```

## ghostty

```bash
ln -s ~/dotfiles/ghostty ~/.config/ghostty
```

## alacritty

```bash
ln -s ~/dotfiles/alacritty ~/.config/alacritty
```

## nvim

Install `nvim` with either

```bash
sudo apt update && sudo apt install neovim
```

on linux or

```bash
brew install neovim
```

on macOS and then install the config with

```bash
ln -s ~/dotfiles/nvim ~/.config/nvim
```

## vscode

Once you have installed your vscode of choice, you can do the following:

- on Linux:

```bash
ln -s ~/dotfiles/vscode/settings.json ~/.config/Code/User/settings.json
ln -s ~/dotfiles/vscode/keybindings.json ~/.config/Code/User/keybindings.json
```

- on macOS:

```bash
ln -s ~/dotfiles/vscode/settings.json ~/Library/Application\ Support/Code/User/settings.json
ln -s ~/dotfiles/vscode/keybindings.json ~/Library/Application\ Support/Code/User/keybindings.json
```

## AI completions

```shell
echo "ANTHROPIC_API_KEY=..." >> ~/api_keys.sh
echo "OPENAI_API_KEY=..." >> ~/api_keys.sh
```

## lazygit

on macOS:

```shell
ln -s ~/dotfiles/lazygit/config.yml ~/Library/Application\ Support/lazygit/config.yml
```

and on Linux:

```shell
ln -s ~/dotfiles/lazygit/config.yml ~/.config/lazygit/config.yml
```

# SSH configuration on Linux
see the following [tutorial](https://hostman.com/tutorials/how-to-install-and-configure-ssh-on-ubuntu-22-04/)
