-- Plugin configuration
-- Uses a simple `later()` to defer non-essential setup after first draw.
local function later(fn) vim.schedule(fn) end

-- Colorscheme ================================================================
vim.cmd('colorscheme rose-pine')

-- mini.basics ================================================================
require('mini.basics').setup({
  options = { basic = false },
  mappings = { windows = true, move_with_alt = true },
})

-- mini.icons =================================================================
local ext3_blocklist = { scm = true, txt = true, yml = true }
local ext4_blocklist = { json = true, yaml = true }
require('mini.icons').setup({
  use_file_extension = function(ext, _)
    return not (ext3_blocklist[ext:sub(-3)] or ext4_blocklist[ext:sub(-4)])
  end,
})
later(MiniIcons.mock_nvim_web_devicons)
later(MiniIcons.tweak_lsp_kind)

-- mini.notify ================================================================
require('mini.notify').setup()

-- mini.starter ===============================================================
require('mini.starter').setup()

-- mini.statusline ============================================================
require('mini.statusline').setup()

-- mini.tabline ===============================================================
require('mini.tabline').setup()

-- mini.extra =================================================================
later(function() require('mini.extra').setup() end)

-- mini.ai ====================================================================
later(function()
  require('mini.ai').setup({
    custom_textobjects = {
      B = MiniExtra.gen_ai_spec.buffer(),
    },
    search_method = 'cover',
  })
end)

-- mini.bracketed =============================================================
later(function() require('mini.bracketed').setup() end)

-- mini.bufremove =============================================================
later(function() require('mini.bufremove').setup() end)

-- mini.clue ==================================================================
later(function()
  local miniclue = require('mini.clue')
  -- stylua: ignore
  miniclue.setup({
    delay = 50,
    clues = {
      Config.leader_group_clues,
      miniclue.gen_clues.builtin_completion(),
      miniclue.gen_clues.g(),
      miniclue.gen_clues.marks(),
      miniclue.gen_clues.registers(),
      miniclue.gen_clues.windows({ submode_resize = true }),
      miniclue.gen_clues.z(),
    },
    triggers = {
      { mode = 'n', keys = '<Leader>' },
      { mode = 'x', keys = '<Leader>' },
      { mode = 'n', keys = '\\' },       -- mini.basics
      { mode = 'n', keys = '[' },        -- mini.bracketed
      { mode = 'n', keys = ']' },
      { mode = 'x', keys = '[' },
      { mode = 'x', keys = ']' },
      { mode = 'i', keys = '<C-x>' },    -- Built-in completion
      { mode = 'n', keys = 'g' },
      { mode = 'x', keys = 'g' },
      { mode = 'n', keys = "'" },        -- Marks
      { mode = 'n', keys = '`' },
      { mode = 'x', keys = "'" },
      { mode = 'x', keys = '`' },
      { mode = 'n', keys = '"' },        -- Registers
      { mode = 'x', keys = '"' },
      { mode = 'i', keys = '<C-r>' },
      { mode = 'c', keys = '<C-r>' },
      { mode = 'n', keys = '<C-w>' },    -- Window commands
      { mode = 'n', keys = 'z' },
      { mode = 'x', keys = 'z' },
    },
  })
end)

-- mini.cmdline ===============================================================
later(function() require('mini.cmdline').setup() end)

-- mini.diff ==================================================================
later(function() require('mini.diff').setup() end)

-- mini.files =================================================================
later(function()
  require('mini.files').setup({ windows = { preview = true } })

  local add_marks = function()
    MiniFiles.set_bookmark('c', vim.fn.stdpath('config'), { desc = 'Config' })
    MiniFiles.set_bookmark('w', vim.fn.getcwd, { desc = 'Working directory' })
  end
  _G.Config.new_autocmd('User', 'MiniFilesExplorerOpen', add_marks, 'Add bookmarks')
end)

-- mini.hipatterns ============================================================
later(function()
  local hipatterns = require('mini.hipatterns')
  local hi_words = MiniExtra.gen_highlighter.words
  hipatterns.setup({
    highlighters = {
      fixme = hi_words({ 'FIXME', 'Fixme', 'fixme' }, 'MiniHipatternsFixme'),
      hack  = hi_words({ 'HACK', 'Hack', 'hack' }, 'MiniHipatternsHack'),
      todo  = hi_words({ 'TODO', 'Todo', 'todo' }, 'MiniHipatternsTodo'),
      note  = hi_words({ 'NOTE', 'Note', 'note' }, 'MiniHipatternsNote'),
      hex_color = hipatterns.gen_highlighter.hex_color(),
    },
  })
end)

-- mini.pick ==================================================================
later(function() require('mini.pick').setup() end)

-- render-markdown.nvim =======================================================
later(function() require('render-markdown').setup() end)
