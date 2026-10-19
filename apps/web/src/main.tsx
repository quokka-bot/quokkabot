import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app.js";
import { entryFromModuleUrl, NewVersion } from "./app-version.js";
import "./desktop.js";
import "./style.css";

// The Mac app hides the title bar: the sidebar leaves room for the window buttons and the top strips drag the window.
if (window.quokkabotDesktop?.platform === "darwin") document.documentElement.classList.add("desktop-mac");

const root = document.getElementById("root");
if (!root) throw new Error("Quokka Bot root element is missing");
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true }, mutations: { retry: false } } });
createRoot(root).render(<QueryClientProvider client={client}><BrowserRouter><App />{import.meta.env.PROD && <NewVersion entry={entryFromModuleUrl(import.meta.url)} />}</BrowserRouter></QueryClientProvider>);
