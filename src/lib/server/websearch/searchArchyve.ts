import { ARCHYVE_API_KEY } from "$env/static/private";
import { ARCHYVE_CLIENT_ID } from "$env/static/private";
import { ARCHYVE_QUERY_URL } from "$env/static/private";

export async function searchArchyve(query: string) {
	const abortController = new AbortController();
	setTimeout(() => abortController.abort(), 10000);

	// insert the query into the URL template
	const query_url = ARCHYVE_QUERY_URL.replace("<query>", query);

	// search Archyve for relevant documents
	const jsonResponse = await fetch(query_url, {
		headers: {
			Authorization: `Bearer ${ARCHYVE_API_KEY}`,
			"X-Client-Id": ARCHYVE_CLIENT_ID,
			Accept: "application/json",
		},
		signal: abortController.signal,
	})
		.then(
			(response) =>
				response.json() as Promise<{
					hits: { url: string; browser_url: string; distance: number }[];
				}>
		)
		.catch((error) => {
			console.error("Failed to fetch or parse JSON", error);
			throw new Error("Failed to fetch or parse JSON");
		});

	console.log("RESPONSE", jsonResponse);
	if (!jsonResponse.hits.length) {
		throw new Error(`Response doesn't contain key "hits"`);
	}
	const hits = jsonResponse.hits.slice(0, 10).sort((a, b) => a.distance - b.distance);

	const favicon = new URL(query_url).origin + "/favicon.png";
	const results: { link: string }[] = hits.map((hit) => {
		return { link: hit.url, browserLink: hit.browser_url, favicon };
	});

	console.log("RESULTS", results);
	return { organic_results: results };
}
