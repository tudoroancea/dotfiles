return {
  "folke/snacks.nvim",
  priority = 1000,
  enabled = false,
  lazy = false,
  ---@class snacks.Config
  opts = {
    ---@class snacks.bigfile.Config
    bigfile = { enabled = true },
    ---@class snacks.dashboard.Config
    dashboard = {
      enabled = true,
      sections = {
        { section = "header" },
        { icon = " ", title = "Keymaps", section = "keys", indent = 2, padding = 1 },
        { icon = " ", title = "Recent Files", section = "recent_files", indent = 2, padding = 1 },
        { icon = " ", title = "Projects", section = "projects", indent = 2, padding = 1 },
        { section = "startup" },
      },
    },
    keys = {
      { "<leader>h", function() require("snacks").dashboard() end, desc = "Dashboard" },
    },
  },
}
