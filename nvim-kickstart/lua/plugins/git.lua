return {
  {
    'echasnovski/mini-git',
    lazy = false,
    main = 'mini.git',
    opts = {
      -- General CLI execution
      job = {
        -- Timeout (in ms) for each job before force quit
        timeout = 3000,
      },

      -- Options for `:Git` command
      command = {
        -- Default split direction
        split = 'auto',
      },
    },
  },
  {
    'echasnovski/mini.diff',
    lazy = false,
    opts = {
      view = {
        style = 'sign',
        signs = {
          add = '✚',
          change = '',
          delete = '✖',
        },
      },
      mappings = {},
    },
    -- -- Actions
    -- -- visual mode
    -- map('v', '<leader>gs', function()
    --   gitsigns.stage_hunk { vim.fn.line '.', vim.fn.line 'v' }
    -- end, { desc = '[G]it: [s]tage hunk' })
    -- map('v', '<leader>gr', function()
    --   gitsigns.reset_hunk { vim.fn.line '.', vim.fn.line 'v' }
    -- end, { desc = '[G]it: [r]eset hunk' })
    -- -- normal mode
    -- map('n', '<leader>gs', gitsigns.stage_hunk, { desc = '[G]it: [s]tage hunk' })
    -- map('n', '<leader>gr', gitsigns.reset_hunk, { desc = '[G]it: [r]eset hunk' })
    -- map('n', '<leader>gS', gitsigns.stage_buffer, { desc = '[G]it: [S]tage buffer' })
    -- map('n', '<leader>gu', gitsigns.undo_stage_hunk, { desc = '[G]it: [u]ndo stage hunk' })
    -- map('n', '<leader>gR', gitsigns.reset_buffer, { desc = '[G]it: [R]eset buffer' })
    -- map('n', '<leader>gp', gitsigns.preview_hunk, { desc = '[G]it: [p]review hunk' })
    -- map('n', '<leader>gb', gitsigns.blame_line, { desc = '[G]it: [b]lame line' })
    -- map('n', '<leader>gd', gitsigns.diffthis, { desc = '[G]it: [d]iff against index' })
    -- map('n', '<leader>gD', function()
    --   gitsigns.diffthis '@'
    -- end, { desc = '[G]it: [D]iff against last commit' })
    -- -- Toggles
    -- map('n', '<leader>tb', gitsigns.toggle_current_line_blame, { desc = '[T]oggle git show [b]lame line' })
    -- map('n', '<leader>tD', gitsigns.toggle_deleted, { desc = '[T]oggle git show [D]eleted' })
  },
  {
    'kdheepak/lazygit.nvim',
    lazy = true,
    cmd = {
      'LazyGit',
      'LazyGitConfig',
      'LazyGitCurrentFile',
      'LazyGitFilter',
      'LazyGitFilterCurrentFile',
    },
    -- optional for floating window border decoration
    dependencies = { 'nvim-lua/plenary.nvim' },
    -- setting the keybinding for LazyGit with 'keys' is recommended in
    -- order to load the plugin when the command is run for the first time
    keys = {
      { '<leader>gg', ':LazyGit<cr>', desc = 'LazyGit' },
    },
  },
}
