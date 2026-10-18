/**
 * Which environment turns voice on. The environment and tenant are spliced into the Corti
 * hostnames the client secret is posted to, so a value that could move the request off
 * corti.app must leave voice unregistered rather than send the secret elsewhere.
 */
import { describe, expect, test } from "vitest";
import { resolveSttCredentials } from "../src/voice/credentials.js";
import { CREDS } from "./voice.js";

const ENV = {
  CORTI_ENVIRONMENT: CREDS.environment,
  CORTI_TENANT_NAME: CREDS.tenant,
  CORTI_CLIENT_ID: CREDS.clientId,
  CORTI_CLIENT_SECRET: CREDS.clientSecret,
};

describe("resolveSttCredentials", () => {
  test.each([
    "evil.example/x?",
    "a.b",
    "eu@evil.example",
    "eu#",
    "eu:443",
    "",
    "   ",
  ])(
    "an environment of %j could leave the corti.app host, so voice stays unregistered",
    (environment) => {
      expect(
        resolveSttCredentials({ ...ENV, CORTI_ENVIRONMENT: environment }),
      ).toBeUndefined();
    },
  );

  test.each(["evil.example/x?", "a/b", "t@evil", "t#x", "t?x", "", "   "])(
    "a tenant of %j is not a realm name, so voice stays unregistered",
    (tenant) => {
      expect(
        resolveSttCredentials({ ...ENV, CORTI_TENANT_NAME: tenant }),
      ).toBeUndefined();
    },
  );

  test.each([
    { environment: "eu", tenant: "tenant.name" },
    { environment: "us-1", tenant: "my_tenant" },
    { environment: "EU", tenant: "base" },
  ])(
    "environment $environment with tenant $tenant is accepted",
    ({ environment, tenant }) => {
      expect(
        resolveSttCredentials({
          ...ENV,
          CORTI_ENVIRONMENT: environment,
          CORTI_TENANT_NAME: tenant,
        }),
      ).toEqual({ ...CREDS, environment, tenant });
    },
  );

  test("surrounding whitespace is trimmed before the check", () => {
    expect(
      resolveSttCredentials({ ...ENV, CORTI_ENVIRONMENT: " eu\n" }),
    ).toEqual({ ...CREDS, environment: "eu" });
  });

  test.each(Object.keys(ENV))("without %s there are no credentials", (name) => {
    const env: NodeJS.ProcessEnv = { ...ENV };
    delete env[name];
    expect(resolveSttCredentials(env)).toBeUndefined();
  });
});
