--- Make it so that I can see files starting with a dot
---@type LazySpec
return {
  "nvim-telescope/telescope.nvim",
  event = "VeryLazy",
  enabled = true,
  lazy = false,
  version = false, -- set this if you want to always pull the latest change
  opts = {
    pickers = {
      find_files = {
        find_command = { "fd", "--hidden", "--glob", "" },
      },
    },
  },
}
