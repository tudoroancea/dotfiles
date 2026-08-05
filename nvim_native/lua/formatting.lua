local M = {}

-- User-configurable: filetype -> shell command (stdin/stdout)
M.formatters = {
	lua = "stylua -",
	python = "ruff format --stdin-filename % -",
}

local oxfmt_filetypes = {
	"javascript",
	"javascriptreact",
	"typescript",
	"typescriptreact",
	"json",
	"jsonc",
	"json5",
	"css",
	"scss",
	"less",
	"graphql",
	"toml",
	"yaml",
	"html",
	"xhtml",
	"vue",
	"svelte",
	"markdown",
	"markdown.mdx",
	"handlebars",
	"mjml",
}

for _, filetype in ipairs(oxfmt_filetypes) do
	M.formatters[filetype] = "oxfmt --stdin-filepath %"
end

vim.filetype.add({
	extension = {
		handlebars = "handlebars",
		mdx = "markdown.mdx",
		mjml = "mjml",
		pcss = "css",
		postcss = "css",
	},
})

vim.api.nvim_create_autocmd("BufWritePre", {
	group = vim.api.nvim_create_augroup("format_on_save", { clear = true }),
	callback = function(args)
		local bufnr = args.buf
		if vim.b[bufnr].skip_format_once then
			vim.b[bufnr].skip_format_once = nil
			return
		end
		local ft = vim.bo[bufnr].filetype
		local cmd = M.formatters[ft]

		if cmd then
			-- Replace % with actual buffer path for tools that need it
			local bufname = vim.api.nvim_buf_get_name(bufnr)
			local resolved = cmd:gsub("%%", vim.fn.shellescape(bufname))

			local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
			local input = table.concat(lines, "\n")

			local output = vim.fn.system(resolved, input)

			if vim.v.shell_error == 0 then
				local formatted = vim.split(output, "\n", { plain = true })
				-- Remove trailing empty line that shell commands often append
				if formatted[#formatted] == "" then
					table.remove(formatted)
				end
				vim.api.nvim_buf_set_lines(bufnr, 0, -1, false, formatted)
			end
		else
			-- No external formatter: try LSP
			for _, cl in ipairs(vim.lsp.get_clients({ bufnr = bufnr })) do
				if cl:supports_method("textDocument/formatting") then
					vim.lsp.buf.format({ bufnr = bufnr, async = false })
					break
				end
			end
		end
	end,
})

return M
