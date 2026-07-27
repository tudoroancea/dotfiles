import { render } from "preact";
import { App } from "./app.js";

const root = document.getElementById("app");
if (!root) throw new Error("Missing #app mount point");
render(<App />, root);
