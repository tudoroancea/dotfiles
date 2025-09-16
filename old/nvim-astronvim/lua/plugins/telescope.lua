--- Make it so that I can see files starting with a dot
---@type LazySpec
return {
  "nvim-telescope/telescope.nvim",
  event = "VeryLazy",
  enabled = true,
  lazy = false,
  version = "*",
  opts = {
    pickers = {
      find_files = {
        find_command = { "fd", "--hidden", "--glob", "" },
      },
    },
  },
}
