-- Bootstrap lazy.nvim
local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"
if not (vim.uv or vim.loop).fs_stat(lazypath) then
    local lazyrepo = "https://github.com/folke/lazy.nvim.git"
    local out = vim.fn.system({ "git", "clone", "--filter=blob:none", "--branch=stable", lazyrepo, lazypath })
    if vim.v.shell_error ~= 0 then
        vim.api.nvim_echo({
            { "Failed to clone lazy.nvim:\n", "ErrorMsg" },
            { out,                            "WarningMsg" },
            { "\nPress any key to exit..." },
        }, true, {})
        vim.fn.getchar()
        os.exit(1)
    end
end
vim.opt.rtp:prepend(lazypath)

-- Make sure to setup `mapleader` and `maplocalleader` before
-- loading lazy.nvim so that mappings are correct.
-- This is also a good place to setup other settings (vim.opt)
vim.g.mapleader = " "
vim.g.maplocalleader = "\\"

-- Sync clipboard between OS and Neovim.
--  Schedule the setting after `UiEnter` because it can increase startup-time.
--  Remove this option if you want your OS clipboard to remain independent.
--  See `:help 'clipboard'`
vim.schedule(function()
    vim.opt.clipboard = 'unnamedplus'
end)

-- Enable break indent
vim.opt.breakindent = true

-- Save undo history
vim.opt.undofile = true

-- Configure how new splits should be opened
vim.opt.splitright = true
vim.opt.splitbelow = true

-- Make line numbers default
vim.opt.number = true
-- Show which line your cursor is on
vim.opt.cursorline = true
-- You can also add relative line numbers, to help with jumping.
--  Experiment for yourself to see if you like it!
vim.opt.relativenumber = true

vim.opt.wrap = false

-- Don't show the mode, since it's already in the status line
vim.opt.showmode = false

vim.o.background = "light"

vim.keymap.set("n", "<leader>w", "<cmd>w<cr>")
vim.keymap.set({ "n", "v" }, "<C-h>", "<C-w>h")
vim.keymap.set({ "n", "v" }, "<C-j>", "<C-w>j")
vim.keymap.set({ "n", "v" }, "<C-k>", "<C-w>k")
vim.keymap.set({ "n", "v" }, "<C-l>", "<C-w>l")
vim.keymap.set({ "n", "v" }, "<A-h>", "<cmd>bprevious<cr>")
vim.keymap.set({ "n", "v" }, "<A-l>", "<cmd>bnext<cr>")
vim.keymap.set({ "n", "v" }, "<M-h>", "<cmd>bprevious<cr>")
vim.keymap.set({ "n", "v" }, "<M-l>", "<cmd>bnext<cr>")
vim.keymap.set("n", "<leader>/", "gcc")
vim.keymap.set("x", "<leader>/", "gc")

-- Setup lazy.nvim
require("lazy").setup("plugins")
