# setup
You can clone this repo with 
```bash
git clone --recurse-submodules https://github.com/tudoroancea/dotfiles ~/dotfiles
```
and then follow the following steps to install the different components:

## zsh
```bash
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-syntax-highlighting
git clone https://github.com/zsh-users/zsh-autosuggestions ${ZSH_CUSTOM:-~/.oh-my-zsh/custom}/plugins/zsh-autosuggestions
curl -sS https://starship.rs/install.sh | sh
ln -s ~/dotfiles/.zshrc ~/.zshrc
```

## tmux
```bash
ln -s ~/dotfiles/.tmux.conf ~/.tmux.conf
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

For them to work you have to provide env vars for the desired providers (either `GROQ_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`). 
The safest way to do that is 

