import { searchWeb } from "$lib/server/websearch/searchWeb";
import { generateQuery } from "$lib/server/websearch/generateQuery";
import { getWebSearchProvider } from "./searchWeb";
import { WEBSEARCH_ALLOWLIST, WEBSEARCH_BLOCKLIST, ENABLE_LOCAL_FETCH } from "$env/static/private";

import type { Conversation } from "$lib/types/Conversation";
import type { MessageUpdate } from "$lib/types/MessageUpdate";
import type { Message } from "$lib/types/Message";
import type { WebSearch, WebSearchSource } from "$lib/types/WebSearch";
import type { Assistant } from "$lib/types/Assistant";

import { z } from "zod";
import JSON5 from "json5";
import { isURLLocal } from "../isURLLocal";

const MAX_N_PAGES_SCRAPE = 6 as const;

const listSchema = z.array(z.string()).default([]);

const allowList = listSchema.parse(JSON5.parse(WEBSEARCH_ALLOWLIST));
const blockList = listSchema.parse(JSON5.parse(WEBSEARCH_BLOCKLIST));

export async function runWebSearch(
	conv: Conversation,
	messages: Message[],
	updatePad: (upd: MessageUpdate) => void,
	ragSettings?: Assistant["rag"]
) {
	const prompt = messages[messages.length - 1].content;
	const searchProvider = getWebSearchProvider();
	const webSearch: WebSearch = {
		prompt,
		searchQuery: "",
		results: [],
		contextSources: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		provider: searchProvider,
	};

	function appendUpdate(message: string, args?: string[], type?: "error" | "update") {
		updatePad({ type: "webSearch", messageType: type ?? "update", message, args });
	}

	try {
		// if the assistant specified direct links, skip the websearch
		if (ragSettings && ragSettings?.allowedLinks.length > 0) {
			appendUpdate("Using links specified in Assistant");

			let linksToUse = [...ragSettings.allowedLinks];

			if (ENABLE_LOCAL_FETCH !== "true") {
				const localLinks = await Promise.all(
					linksToUse.map(async (link) => {
						try {
							const url = new URL(link);
							return await isURLLocal(url);
						} catch (e) {
							return true;
						}
					})
				);

				linksToUse = linksToUse.filter((_, index) => !localLinks[index]);
			}

			webSearch.results = linksToUse.map((link) => {
				return { link, hostname: new URL(link).hostname, title: "", text: "" };
			});
		} else {
			if (webSearch.provider.generateQuery) {
				webSearch.searchQuery = await generateQuery(messages);
			} else {
				webSearch.searchQuery = prompt;
			}
			appendUpdate(`Searching ${searchProvider.name}`, [webSearch.searchQuery]);

			let filters = "";
			if (ragSettings && ragSettings?.allowedDomains.length > 0) {
				appendUpdate("Filtering on specified domains");
				filters += ragSettings.allowedDomains.map((item) => "site:" + item).join(" OR ");
			}

			// handle the global lists
			filters +=
				allowList.map((item) => "site:" + item).join(" OR ") +
				" " +
				blockList.map((item) => "-site:" + item).join(" ");

			webSearch.searchQuery = filters + " " + webSearch.searchQuery;

			const results = await searchWeb(webSearch.searchQuery);
			webSearch.results =
				(results.organic_results &&
					results.organic_results.map(
						(el: {
							title?: string;
							link: string;
							browserLink?: string;
							text?: string;
							favicon?: string;
						}) => {
							try {
								const { title, link, browserLink, text, favicon } = el;
								const { hostname } = new URL(link);

								const final_favicon =
									favicon ?? `https://www.google.com/s2/favicons?sz=64&domain_url=${hostname}`;

								return { title, link, browserLink, hostname, text, favicon: final_favicon };
							} catch (e) {
								// Ignore Errors
								return null;
							}
						}
					)) ??
				[];
		}

		webSearch.results = webSearch.results.filter((value) => value !== null);
		webSearch.results = webSearch.results
			.filter(({ link }) => !blockList.some((el) => link.includes(el))) // filter out blocklist links
			.slice(0, MAX_N_PAGES_SCRAPE); // limit to first 10 links only

		let paragraphChunks: { source: WebSearchSource; text: string }[] = [];
		if (webSearch.results.length > 0) {
			appendUpdate("Browsing results");
			const promises = webSearch.results.map(async (result) => {
				const { link } = result;
				const browserLink = result.browserLink ?? link;
				let text = result.text ?? "";
				if (!text) {
					try {
						text = await webSearch.provider.urlParser(link);
						appendUpdate("Browsing webpage", [browserLink]);
					} catch (e) {
						appendUpdate("Failed to parse webpage", [(e as Error).message, link], "error");
						// ignore errors
					}
				}
				return { source: result, text };
			});
			paragraphChunks = await Promise.all(promises);
			console.log("PARA", paragraphChunks);
		} else {
			throw new Error("No results found for this search query");
		}

		appendUpdate("Extracting relevant information");
		for (let idx = 0; idx < paragraphChunks.length; idx++) {
			const { source } = paragraphChunks[idx];
			const { text } = paragraphChunks[idx];
			const contextWithId = { idx, text };
			const usedSource = webSearch.contextSources.find((cSource) => cSource.link === source.link);

			if (usedSource) {
				usedSource.context.push(contextWithId);
			} else {
				webSearch.contextSources.push({ ...source, context: [contextWithId] });
			}
		}

		updatePad({
			type: "webSearch",
			messageType: "sources",
			message: "sources",
			sources: webSearch.contextSources,
		});
	} catch (searchError) {
		if (searchError instanceof Error) {
			appendUpdate("An error occurred", [JSON.stringify(searchError.message)], "error");
		}
	}

	return webSearch;
}
