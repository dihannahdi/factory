import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { store } from "./lib/store.svelte";
import { boot } from "./lib/stream";

setInterval(() => store.tick(), 1000);
mount(App, { target: document.getElementById("app")! });
void boot();
