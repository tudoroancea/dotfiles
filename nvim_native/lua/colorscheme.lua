vim.pack.add({ { src = "https://github.com/rose-pine/neovim", name = "rose-pine" } })
require("rose-pine").setup()
vim.vim.cmd.colorscheme("rose-pine")
vim.api.nvim_set_hl(0, "Normal", { bg = "none" })
