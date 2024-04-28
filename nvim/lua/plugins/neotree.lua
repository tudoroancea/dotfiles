return {
  "nvim-neo-tree/neo-tree.nvim",
  opts = function(_, config)
    config.filesystem.filtered_items = {
      always_show = { ".gitignore", ".gitmodules", ".venv", ".vscode", ".github", ".idea" },
    }
    -- require("neo-tree").setup {
    --   filesystem = {
    --     filtered_items = {
    --       always_show = { ".gitignore", ".gitmodules", ".venv", ".vscode" },
    --       -- visible = true,
    --       -- hide_hidden = false,
    --     },
    --   },
    -- }
  end,
}
