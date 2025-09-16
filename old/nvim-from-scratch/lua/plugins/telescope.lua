return {
	{
	    "nvim-telescope/telescope.nvim",
	    version = "*",
	    dependencies = { 'nvim-lua/plenary.nvim' },
	    enabled = true,
	    lazy = false,
	    opts = {
		pickers = {
		    find_files = {
			find_command = { "fd", "--hidden", "--glob", "" },
		    },
		},
	    },
	    keys = {
	      {"<leader>ff", function() require('telescope.builtin').find_files() end, desc = "Files"},
	      { "<leader>o", function() require("telescope.builtin").buffers() end, desc = "Buffers" },
	    }

	},
{
}
}
