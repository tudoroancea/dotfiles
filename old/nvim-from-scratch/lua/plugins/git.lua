return {
    {
    "echasnovski/mini.nvim",  version = "*", lazy = false,
    config = function()
	    require('mini.git').setup()  
	    require('mini.diff').setup()  

    end, 
    },
}
