return {
  'stevearc/resession.nvim',
  lazy = false,
  event = 'VimEnter',
  config = function()
    local resession = require 'resession'
    resession.setup {
      -- Options for automatically saving sessions on a timer
      autosave = {
        enabled = false,
        -- How often to save (in seconds)
        interval = 60,
        -- Notify when autosaved
        notify = true,
      },
      -- Custom logic for determining if the buffer should be included
      buf_filter = require('resession').default_buf_filter,
      -- Custom logic for determining if a buffer should be included in a tab-scoped session
      tab_buf_filter = function(tabpage, bufnr)
        return true
      end,
    }
    local function get_session_name()
      local name = vim.fn.getcwd()
      local branch = vim.trim(vim.fn.system 'git branch --show-current')
      if vim.v.shell_error == 0 then
        return name .. branch
      else
        return name
      end
    end
    vim.api.nvim_create_autocmd('VimEnter', {
      callback = function()
        -- Only load the session if nvim was started with no args
        if vim.fn.argc(-1) == 0 then
          resession.load(get_session_name(), { dir = 'dirsession', silence_errors = true })
        end
      end,
    })
    vim.api.nvim_create_autocmd('VimLeavePre', {
      callback = function()
        resession.save(get_session_name(), { dir = 'dirsession', notify = false })
      end,
    })
  end,
}
