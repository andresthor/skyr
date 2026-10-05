import { describe, expect, test } from "vitest";
import { isPrivateAddress, redactUrl, withTimeout } from "../src/tools/net.js";

describe("isPrivateAddress", () => {
  test.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "198.18.0.1",
    "255.255.255.255",
  ])("refuses the IPv4 address %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test.each([
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
  ])("refuses the IPv6 address %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test.each(["::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1"])(
    "refuses %s, which reaches an IPv4 host",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(true);
    },
  );

  test.each(["64:ff9b::7f00:1", "64:ff9b:1::7f00:1", "2002:7f00:1::"])(
    "refuses the translated range %s whole",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(true);
    },
  );

  test.each(["", "not-an-ip", "999.999.999.999", "127.0.0.1 "])(
    "treats the unparseable input %j as private",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(true);
    },
  );

  test.each(["93.184.215.14", "8.8.8.8", "2606:4700::1", "::ffff:8.8.8.8"])(
    "allows the public address %s",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe("withTimeout", () => {
  test("aborts when the caller's signal aborts", () => {
    const caller = new AbortController();
    const signal = withTimeout(caller.signal, 60_000);
    expect(signal.aborted).toBe(false);
    caller.abort();
    expect(signal.aborted).toBe(true);
  });

  test("aborts on its own deadline without a caller signal", async () => {
    const signal = withTimeout(undefined, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signal.aborted).toBe(true);
  });
});

describe("redactUrl", () => {
  test("drops the query string, so a key in one cannot reach the model", () => {
    expect(redactUrl("https://x.dev/search?api_key=secret")).toBe(
      "https://x.dev/search",
    );
  });

  test("drops userinfo", () => {
    expect(redactUrl("https://user:pw@x.dev/a")).toBe("https://x.dev/a");
  });

  test("says so rather than echoing an unparseable URL", () => {
    expect(redactUrl("notaurl")).toBe("<invalid url>");
  });
});
