local cmp = require 'cmp'
local luasnip = require 'luasnip'

cmp.setup {
  snippet = {
    expand = function(args)
      luasnip.lsp_expand(args.body)
    end,
  },
  completion = { completeopt = 'menu,menuone,noinsert' },
  mapping = cmp.mapping.preset.insert {
    ['<C-n>'] = cmp.mapping.select_next_item(),
    ['<C-p>'] = cmp.mapping.select_prev_item(),
    ['<C-b>'] = cmp.mapping.scroll_docs(-4),
    ['<C-f>'] = cmp.mapping.scroll_docs(4),
    ['<C-y>'] = cmp.mapping.confirm { select = true },
    ['<C-Space>'] = cmp.mapping.complete {},
  },
  sources = {
    { name = 'lazydev', group_index = 0 },
    { name = 'nvim_lsp' },
    { name = 'luasnip' },
    { name = 'path' },
  },
}

require('lazydev').setup {
  library = {
    { path = 'luvit-meta/library', words = { 'vim%.uv' } },
  },
}

local function enable_lsp(name, config)
  vim.api.nvim_create_autocmd('FileType', {
    pattern = config.filetypes,
    callback = function(ev)
      vim.lsp.start(vim.tbl_extend('force', {
        name = name,
        cmd = config.cmd,
        root_dir = vim.fs.dirname(vim.fs.find(config.root_files, { upward = true })[1]),
        capabilities = require('cmp_nvim_lsp').default_capabilities(),
      }, config.opts or {}))
    end,
  })
end

enable_lsp('clangd', {
  filetypes = { 'c', 'cpp', 'objc', 'objcpp' },
  cmd = { 'clangd' },
  root_files = { '.clangd', '.clang-format', 'compile_commands.json', '.git' },
})

enable_lsp('basedpyright', {
  filetypes = { 'python' },
  cmd = { 'basedpyright-langserver', '--stdio' },
  root_files = { 'pyproject.toml', 'setup.py', '.git' },
  opts = {
    settings = {
      basedpyright = {
        analysis = {
          typeCheckingMode = 'off',
          diagnosticMode = 'openFilesOnly',
          venvPath = '.',
          venv = '.venv',
        },
      },
    },
  },
})

enable_lsp('lua_ls', {
  filetypes = { 'lua' },
  cmd = { 'lua-language-server' },
  root_files = { '.stylua.toml', '.luarc.json', '.git' },
  opts = {
    settings = {
      Lua = {
        completion = { callSnippet = 'Replace' },
      },
    },
  },
})

enable_lsp('jsonls', {
  filetypes = { 'json', 'jsonc' },
  cmd = { 'vscode-json-language-server', '--stdio' },
  root_files = { '.git', 'package.json' },
})

enable_lsp('ts_ls', {
  filetypes = { 'javascript', 'javascriptreact', 'typescript', 'typescriptreact' },
  cmd = { 'typescript-language-server', '--stdio' },
  root_files = { 'tsconfig.json', 'package.json', '.git' },
})

vim.api.nvim_create_autocmd('LspAttach', {
  group = vim.api.nvim_create_augroup('kickstart-lsp-attach', { clear = true }),
  callback = function(event)
    local map = function(keys, func, desc)
      vim.keymap.set('n', keys, func, { buffer = event.buf, desc = 'LSP: ' .. desc })
    end

    map('gd', require('telescope.builtin').lsp_definitions, '[G]oto [D]efinition')
    map('gr', require('telescope.builtin').lsp_references, '[G]oto [R]eferences')
    map('gI', require('telescope.builtin').lsp_implementations, '[G]oto [I]mplementation')
    map('<leader>D', require('telescope.builtin').lsp_type_definitions, 'Type [D]efinition')
    map('<leader>ds', require('telescope.builtin').lsp_document_symbols, '[D]ocument [S]ymbols')
    map('<leader>ws', require('telescope.builtin').lsp_dynamic_workspace_symbols, '[W]orkspace [S]ymbols')
    map('<leader>rn', vim.lsp.buf.rename, '[R]ename')
    map('<leader>ca', vim.lsp.buf.code_action, '[C]ode [A]ction')
    map('K', vim.lsp.buf.hover, 'Hover Documentation')
    map('gD', vim.lsp.buf.declaration, '[G]oto [D]eclaration')

    local client = vim.lsp.get_client_by_id(event.data.client_id)
    if client and client.supports_method(vim.lsp.protocol.Methods.textDocument_documentHighlight) then
      local highlight_augroup = vim.api.nvim_create_augroup('kickstart-lsp-highlight', { clear = false })
      vim.api.nvim_create_autocmd({ 'CursorHold', 'CursorHoldI' }, {
        buffer = event.buf,
        group = highlight_augroup,
        callback = vim.lsp.buf.document_highlight,
      })
      vim.api.nvim_create_autocmd({ 'CursorMoved', 'CursorMovedI' }, {
        buffer = event.buf,
        group = highlight_augroup,
        callback = vim.lsp.buf.clear_references,
      })
    end

    if client and client.supports_method(vim.lsp.protocol.Methods.textDocument_inlayHint) then
      map('<leader>th', function()
        vim.lsp.inlay_hint.enable(not vim.lsp.inlay_hint.is_enabled { bufnr = event.buf })
      end, '[T]oggle Inlay [H]ints')
    end
  end,
})
