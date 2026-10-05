import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  assertPublicUrl,
  type FetchDeps,
  htmlToMarkdown,
  type Lookup,
  webFetch,
} from "../src/tools/web-fetch.js";

const publicLookup: Lookup = async () => [
  { address: "93.184.215.14", family: 4 },
];

const lookupTable =
  (table: Record<string, string>): Lookup =>
  async (host) => {
    const address = table[host] ?? "93.184.215.14";
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  };

type Call = { url: string; ua: string };

/** Records what was requested and answers from `handler`, so no test touches the network. */
function stubFetch(handler: (url: string) => Response): {
  calls: Call[];
  deps: FetchDeps;
} {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      ua: headers.get("user-agent") ?? "",
    });
    return handler(String(input));
  };
  return { calls, deps: { fetch, lookup: publicLookup } };
}

const html = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html" } });

describe("assertPublicUrl", () => {
  test("a public host passes", async () => {
    await expect(
      assertPublicUrl(new URL("https://x.dev/a"), publicLookup),
    ).resolves.toBeUndefined();
  });

  test("a public IPv6 literal is looked up without its brackets", async () => {
    const seen: string[] = [];
    const lookup: Lookup = async (host) => {
      seen.push(host);
      return [{ address: "2606:4700::1", family: 6 }];
    };
    await assertPublicUrl(new URL("https://[2606:4700::1]/a"), lookup);
    expect(seen).toEqual(["2606:4700::1"]);
  });

  test("localhost is refused without a lookup", async () => {
    await expect(
      assertPublicUrl(new URL("http://localhost:3000/a"), publicLookup),
    ).rejects.toThrow(/refused localhost/);
  });

  test("a .internal name is refused", async () => {
    await expect(
      assertPublicUrl(new URL("http://db.internal/a"), publicLookup),
    ).rejects.toThrow(/refused db\.internal/);
  });

  test("a host resolving to a private address is refused", async () => {
    await expect(
      assertPublicUrl(
        new URL("http://sneaky.dev/a"),
        lookupTable({ "sneaky.dev": "169.254.169.254" }),
      ),
    ).rejects.toThrow(/private or local address/);
  });

  test("a non-http scheme is refused", async () => {
    await expect(
      assertPublicUrl(new URL("file:///etc/passwd"), publicLookup),
    ).rejects.toThrow(/file: is not supported/);
  });
});

describe("webFetch", () => {
  test("an invalid URL throws before any request", async () => {
    const { calls, deps } = stubFetch(() => html("<p>no</p>"));
    await expect(webFetch("notaurl", "1", undefined, deps)).rejects.toThrow(
      /"notaurl" is not a valid URL/,
    );
    expect(calls).toEqual([]);
  });

  test("HTML becomes markdown without script or style content", async () => {
    const { deps } = stubFetch(() =>
      html(
        "<h1>Title</h1><script>evil()</script><style>a{}</style><p>Body</p>",
      ),
    );
    const { text } = await webFetch("https://x.dev/a", "1", undefined, deps);
    expect(text).toContain("# Title");
    expect(text).toContain("Body");
    expect(text).not.toContain("evil()");
    expect(text).not.toContain("a{}");
  });

  test("markdown is returned unconverted", async () => {
    const { deps } = stubFetch(
      () =>
        new Response("# Already\n\n- a\n- b\n", {
          headers: { "content-type": "text/markdown" },
        }),
    );
    const { text } = await webFetch("https://x.dev/a", "1", undefined, deps);
    expect(text).toContain("# Already\n\n- a\n- b");
  });

  test("invisible characters never reach the model", async () => {
    const { deps } = stubFetch(() => html("<p>pay‮me​\u{E0041}now</p>"));
    const { text } = await webFetch("https://x.dev/a", "1", undefined, deps);
    expect(text).toContain("paymenow");
  });

  test("a redirect to a metadata address is refused on the second hop", async () => {
    const calls: string[] = [];
    const deps: FetchDeps = {
      lookup: lookupTable({ "metadata.dev": "169.254.169.254" }),
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { location: "http://metadata.dev/latest" },
        });
      },
    };
    await expect(
      webFetch("https://x.dev/a", "1", undefined, deps),
    ).rejects.toThrow(/refused metadata\.dev/);
    expect(calls).toEqual(["https://x.dev/a"]);
  });

  test("more than five redirects throws", async () => {
    let n = 0;
    const { deps } = stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://x.dev/${++n}` },
        }),
    );
    await expect(
      webFetch("https://x.dev/a", "1", undefined, deps),
    ).rejects.toThrow(/more than 5 redirects/);
  });

  test("a Cloudflare challenge is retried once with the plain user agent", async () => {
    let first = true;
    const { calls, deps } = stubFetch(() => {
      if (first) {
        first = false;
        return new Response("nope", {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
        });
      }
      return html("<p>through</p>");
    });
    const { text } = await webFetch("https://x.dev/a", "1", undefined, deps);
    expect(text).toContain("through");
    expect(calls.map((c) => c.ua)).toEqual([
      expect.stringContaining("Chrome"),
      "skyr",
    ]);
  });

  test("a non-2xx final response throws with the query string redacted", async () => {
    const { deps } = stubFetch(() => new Response("gone", { status: 404 }));
    await expect(
      webFetch("https://x.dev/a?api_key=secret", "1", undefined, deps),
    ).rejects.toThrow("web_fetch: HTTP 404 from https://x.dev/a");
  });

  test("a PDF is refused by content type", async () => {
    const { deps } = stubFetch(
      () =>
        new Response("%PDF-1.4", {
          headers: { "content-type": "application/pdf" },
        }),
    );
    await expect(
      webFetch("https://x.dev/a.pdf", "1", undefined, deps),
    ).rejects.toThrow(/unsupported content type application\/pdf/);
  });

  test("an iso-8859-1 body decodes by its declared charset", async () => {
    const { deps } = stubFetch(
      () =>
        new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
          headers: { "content-type": "text/plain; charset=iso-8859-1" },
        }),
    );
    const { text } = await webFetch("https://x.dev/a", "1", undefined, deps);
    expect(text).toContain("café");
  });

  test("a body over the cap throws and cancels the reader", async () => {
    let cancelled = false;
    const { deps } = stubFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: (c) => c.enqueue(new Uint8Array(1024 * 1024)),
            cancel: () => {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/plain" } },
        ),
    );
    await expect(
      webFetch("https://x.dev/big", "1", undefined, deps),
    ).rejects.toThrow(/response larger than 5 MB/);
    expect(cancelled).toBe(true);
  });

  test("a content-length over the cap throws before reading", async () => {
    const { deps } = stubFetch(
      () =>
        new Response("small body, big claim", {
          headers: {
            "content-type": "text/plain",
            "content-length": String(9 * 1024 * 1024),
          },
        }),
    );
    await expect(
      webFetch("https://x.dev/big", "1", undefined, deps),
    ).rejects.toThrow(/response larger than 5 MB/);
  });

  test("a long page is cut, and all of it is written beside the cut", async () => {
    const body = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
    const { deps } = stubFetch(
      () => new Response(body, { headers: { "content-type": "text/plain" } }),
    );
    const { text, details } = await webFetch(
      "https://x.dev/long",
      "call/2",
      undefined,
      deps,
    );
    expect(details.truncated).toBe(true);
    expect(details.spillPath).toBeDefined();
    expect(text).toContain(
      "Showing 2000 of 4002 lines of converted, capped text",
    );
    expect(text).toContain(details.spillPath ?? "<none>");
    // the slash in the id must not have been read as a directory
    expect(details.spillPath).toMatch(/call_2\.md$/);
    await expect(readFile(details.spillPath ?? "", "utf8")).resolves.toContain(
      "line 3999",
    );
  });

  test("the details report the text the model received", async () => {
    const { deps } = stubFetch(() => html("<p>short</p>"));
    const { text, details } = await webFetch(
      "https://x.dev/a",
      "1",
      undefined,
      deps,
    );
    expect(details).toMatchObject({
      url: "https://x.dev/a",
      truncated: false,
      bytes: Buffer.byteLength(text),
    });
  });

  test("a caller's abort propagates rather than becoming a tool error", async () => {
    const caller = new AbortController();
    const deps: FetchDeps = {
      lookup: publicLookup,
      fetch: async () => {
        caller.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    };
    await expect(
      webFetch("https://x.dev/a", "1", caller.signal, deps),
    ).rejects.toThrow(/aborted/);
  });

  test("a transport failure names the URL and the cause, not 'fetch failed'", async () => {
    const deps: FetchDeps = {
      lookup: publicLookup,
      fetch: async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: new Error("ECONNREFUSED"),
        });
      },
    };
    await expect(
      webFetch("https://x.dev/a?key=secret", "1", undefined, deps),
    ).rejects.toThrow(
      "web_fetch: could not reach https://x.dev/a (ECONNREFUSED)",
    );
  });
});

describe("htmlToMarkdown", () => {
  test("drops svg and iframe content", () => {
    const md = htmlToMarkdown(
      "<p>keep</p><svg><text>drop</text></svg><iframe>drop</iframe>",
    );
    expect(md).toContain("keep");
    expect(md).not.toContain("drop");
  });
});
