-- Write and quit
vim.keymap.set("n", "<leader>w", "<cmd>write<cr>", { silent = true, desc = "Write buffer" })
vim.keymap.set("n", "<leader>W", function()
	local bufnr = vim.api.nvim_get_current_buf()
	vim.b[bufnr].skip_format_once = true

	local ok, err = pcall(vim.cmd.write)
	vim.b[bufnr].skip_format_once = nil

	if not ok then
		error(err)
	end
end, { silent = true, desc = "Write buffer without formatting" })
vim.keymap.set("n", "<leader>q", "<cmd>quit<cr>", { silent = true, desc = "Quit window" })
vim.keymap.set("n", "<leader>Q", "<cmd>quitall<cr>", { silent = true, desc = "Quit neovim" })

-- Redo
vim.keymap.set("n", "U", "<c-r>", { silent = true, desc = "Redo" })

-- Language Server Protocol navigation
vim.keymap.set("n", "gd", vim.lsp.buf.definition, { desc = "Go to definition" })
vim.keymap.set("n", "K", vim.lsp.buf.hover, { desc = "Show hover information" })

-- Buffers
vim.keymap.set("n", "<leader>bl", "<cmd>buffers<cr>", { silent = true, desc = "List buffers" })
vim.keymap.set("n", "<leader>bd", "<cmd>bdelete<cr>", { silent = true, desc = "Delete buffer" })
vim.keymap.set("n", "<leader>bb", "<cmd>buffer #<cr>", { silent = true, desc = "Switch to alternate buffer" })
vim.keymap.set("n", "[b", "<cmd>bprevious<cr>", { silent = true, desc = "Previous buffer" })
vim.keymap.set("n", "]b", "<cmd>bnext<cr>", { silent = true, desc = "Next buffer" })

-- Reload every local Lua module before sourcing init.lua again.
vim.keymap.set("n", "<leader>r", function()
	for _, module in ipairs({
		"options",
		"lsp",
		"colorscheme",
		"netrw",
		"statusline",
		"find",
		"grep",
		"autocommands",
		"diagnostics",
		"formatting",
		"keymaps",
	}) do
		package.loaded[module] = nil
	end
	dofile(vim.env.MYVIMRC)
	vim.notify("Neovim config reloaded")
end, { silent = true, desc = "Reload Neovim config" })

-- Swap between split windows
vim.keymap.set("n", "<C-h>", "<cmd>wincmd h<cr>", { silent = true, desc = "Move to left split" })
vim.keymap.set("n", "<C-j>", "<cmd>wincmd j<cr>", { silent = true, desc = "Move to below split" })
vim.keymap.set("n", "<C-k>", "<cmd>wincmd k<cr>", { silent = true, desc = "Move to above split" })
vim.keymap.set("n", "<C-l>", "<cmd>wincmd l<cr>", { silent = true, desc = "Move to right split" })
