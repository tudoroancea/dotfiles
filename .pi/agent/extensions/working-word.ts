import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const WORDS = [
	"Accomplishing",
	"Actioning",
	"Actualizing",
	"Baking",
	"Booping",
	"Brewing",
	"Calculating",
	"Cerebrating",
	"Channelling",
	"Churning",
	"Clauding",
	"Coalescing",
	"Cogitating",
	"Combobulating",
	"Computing",
	"Concocting",
	"Conjuring",
	"Considering",
	"Contemplating",
	"Cooking",
	"Crafting",
	"Creating",
	"Crunching",
	"Deciphering",
	"Deliberating",
	"Determining",
	"Discombobulating",
	"Divining",
	"Doing",
	"Effecting",
	"Elucidating",
	"Enchanting",
	"Envisioning",
	"Finagling",
	"Flibbertigibbeting",
	"Forging",
	"Forming",
	"Frolicking",
	"Generating",
	"Germinating",
	"Hatching",
	"Herding",
	"Honking",
	"Hustling",
	"Ideating",
	"Imagining",
	"Incubating",
	"Inferring",
	"Jiving",
	"Manifesting",
	"Marinating",
	"Meandering",
	"Moseying",
	"Mulling",
	"Mustering",
	"Musing",
	"Noodling",
	"Percolating",
	"Perusing",
	"Philosophising",
	"Pondering",
	"Pontificating",
	"Processing",
	"Puttering",
	"Puzzling",
	"Reticulating",
	"Ruminating",
	"Scheming",
	"Schlepping",
	"Shimmying",
	"Shucking",
	"Simmering",
	"Smooshing",
	"Spelunking",
	"Spinning",
	"Stewing",
	"Sussing",
	"Synthesizing",
	"Thinking",
	"Tinkering",
	"Transmuting",
	"Unfurling",
	"Unravelling",
	"Vibing",
	"Wandering",
	"Whirring",
	"Wibbling",
	"Wizarding",
	"Working",
	"Wrangling",
];

const pickWord = () => {
	return WORDS[Math.floor(Math.random() * WORDS.length)];
};

export default function workingWordExtension(pi: ExtensionAPI) {
	const clearWorkingMessage = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingMessage();
	};

	pi.on("session_start", async (_event, ctx) => {
		clearWorkingMessage(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		clearWorkingMessage(ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingMessage(`${pickWord()}...`);
	});

	pi.on("agent_end", async (_event, ctx) => {
		clearWorkingMessage(ctx);
	});
}
