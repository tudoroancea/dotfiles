#!/bin/bash
cd ~/dotfiles

# Use full paths for cron environment
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:$PATH"

# Check if antigravity-claude-proxy is running in pm2
if ! pm2 list | grep -q "antigravity-claude-proxy" | grep -q "online"; then
    pm2 start "bun x antigravity-claude-proxy start" --name antigravity-claude-proxy
    sleep 2  # give it a moment to start
fi

# Run the pi command
pi --model claude-sonnet-4-5 --provider google-antigravity -p "say hi"
