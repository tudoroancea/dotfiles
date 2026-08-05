return {
	cmd = function(dispatchers, config)
		local cmd = "oxlint"
		if (config or {}).root_dir then
			local local_cmd = vim.fs.joinpath(config.root_dir, "node_modules", ".bin", cmd)
			if vim.fn.executable(local_cmd) == 1 then
				cmd = local_cmd
			end
		end
		return vim.lsp.rpc.start({ cmd, "--lsp" }, dispatchers)
	end,
	filetypes = {
		"javascript",
		"javascriptreact",
		"typescript",
		"typescriptreact",
		"vue",
		"svelte",
		"astro",
	},
	root_dir = function(bufnr, on_dir)
		local root = vim.fs.root(bufnr, {
			".oxlintrc.json",
			".oxlintrc.jsonc",
			"oxlint.config.ts",
			"package.json",
			".git",
		})
		on_dir(root or vim.fn.getcwd())
	end,
}
