return {
  "nvim-neo-tree/neo-tree.nvim",
  version = "*",
  opts = {
    filesystem = {
      window = {
        mappings = {
          ["<C-J>"] = "move_cursor_down",
          ["<C-K>"] = "move_cursor_up",
        },
      },
      filtered_items = {
        visible = true,
        show_hidden_count = true,
        hide_dotfiles = false,
        hide_gitignored = true,
        hide_by_name = {
          ".git",
          ".DS_Store",
        },
        never_show = {},
      },
    },
  },
}
