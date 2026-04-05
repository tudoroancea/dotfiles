-- Minimal Neovim config using builtin features wherever possible.
--
-- Structure:
-- init.lua          Bootstrap plugins + global helpers
-- plugin/           Auto-sourced at startup
--   10_options.lua  Built-in Neovim behavior
--   20_keymaps.lua  Custom mappings
--   30_plugins.lua  Plugin configuration
-- after/lsp/        Language server configs (`:h vim.lsp.config`)
-- after/ftplugin/   Filetype overrides

-- Package management using Neovim's builtin :h packages ======================
local pack_path = vim.fn.stdpath('data') .. '/site/pack/plugins/start'

local plugins = {
  { name = 'mini.nvim',            url = 'https://github.com/nvim-mini/mini.nvim' },
  { name = 'rose-pine',            url = 'https://github.com/rose-pine/neovim' },
  { name = 'lazygit.nvim',         url = 'https://github.com/kdheepak/lazygit.nvim' },
  { name = 'render-markdown.nvim', url = 'https://github.com/MeanderingProgrammer/render-markdown.nvim' },
}

local any_installed = false
for _, plugin in ipairs(plugins) do
  local path = pack_path .. '/' .. plugin.name
  if not vim.uv.fs_stat(path) then
    vim.cmd('echo "Installing ' .. plugin.name .. '..." | redraw')
    vim.fn.system({ 'git', 'clone', '--filter=blob:none', plugin.url, path })
    any_installed = true
  end
end
if any_installed then
  vim.cmd('packloadall | helptags ALL')
  vim.cmd('echo "All plugins installed" | redraw')
end

vim.api.nvim_create_user_command('PluginUpdate', function()
  for _, plugin in ipairs(plugins) do
    local path = pack_path .. '/' .. plugin.name
    if vim.uv.fs_stat(path) then
      vim.notify('Updating ' .. plugin.name .. '...')
      vim.fn.system({ 'git', '-C', path, 'pull', '--ff-only' })
    end
  end
  vim.cmd('helptags ALL')
  vim.notify('All plugins updated!')
end, {})

vim.api.nvim_create_user_command('PluginClean', function()
  local expected = {}
  for _, p in ipairs(plugins) do expected[p.name] = true end
  local handle = vim.uv.fs_scandir(pack_path)
  if not handle then return end
  while true do
    local name = vim.uv.fs_scandir_next(handle)
    if not name then break end
    if not expected[name] then
      vim.notify('Removing ' .. name)
      vim.fn.delete(pack_path .. '/' .. name, 'rf')
    end
  end
  vim.notify('Cleanup complete!')
end, {})

-- Global config table =========================================================
_G.Config = {}

local gr = vim.api.nvim_create_augroup('custom-config', {})
_G.Config.new_autocmd = function(event, pattern, callback, desc)
  vim.api.nvim_create_autocmd(event, { group = gr, pattern = pattern, callback = callback, desc = desc })
end
