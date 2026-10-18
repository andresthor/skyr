/**
 * Which environment turns voice on. The environment and tenant are spliced into the Corti
 * hostnames the client secret is posted to, so a value that could move the request off
 * corti.app must leave voice unregistered — named as invalid, never told to be "set".
 */
import { describe, expect, test } from "vitest";
import { resolveSttCredentials } from "../src/voice/credentials.js";
import { credentialsNotice } from "../src/voice/errors.js";
import { CREDS } from "./voice.js";

const ENV = {
  CORTI_ENVIRONMENT: CREDS.environment,
  CORTI_TENANT_NAME: CREDS.tenant,
  CORTI_CLIENT_ID: CREDS.clientId,
  CORTI_CLIENT_SECRET: CREDS.clientSecret,
} as const;

describe("resolveSttCredentials", () => {
  test.each(["evil.example/x?", "a.b", "eu@evil.example", "eu#", "eu:443"])(
    "an environment of %j could leave the corti.app host, so voice stays unregistered",
    (environment) => {
      expect(
        resolveSttCredentials({ ...ENV, CORTI_ENVIRONMENT: environment }),
      ).toEqual({ invalid: "CORTI_ENVIRONMENT" });
    },
  );

  test.each(["a/b", "t@evil", "t#x", "t?x"])(
    "a tenant of %j is not a realm name, so voice stays unregistered",
    (tenant) => {
      expect(
        resolveSttCredentials({ ...ENV, CORTI_TENANT_NAME: tenant }),
      ).toEqual({ invalid: "CORTI_TENANT_NAME" });
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
      ).toEqual({ creds: { ...CREDS, environment, tenant } });
    },
  );

  test("surrounding whitespace is trimmed before the check", () => {
    expect(
      resolveSttCredentials({ ...ENV, CORTI_ENVIRONMENT: " eu\n" }),
    ).toEqual({ creds: { ...CREDS, environment: "eu" } });
  });

  test.each(Object.keys(ENV))(
    "without %s the result names only the unset variables",
    (name) => {
      const env: NodeJS.ProcessEnv = { ...ENV };
      delete env[name];
      expect(resolveSttCredentials(env)).toEqual({
        missing: [name as keyof typeof ENV],
      });
    },
  );

  test("a half-set environment lists exactly the unset variables, never the set ones", () => {
    expect(
      resolveSttCredentials({
        CORTI_TENANT_NAME: ENV.CORTI_TENANT_NAME,
        CORTI_CLIENT_SECRET: ENV.CORTI_CLIENT_SECRET,
      }),
    ).toEqual({ missing: ["CORTI_ENVIRONMENT", "CORTI_CLIENT_ID"] });
  });

  test("a blank value counts as unset", () => {
    expect(resolveSttCredentials({ ...ENV, CORTI_CLIENT_ID: "  " })).toEqual({
      missing: ["CORTI_CLIENT_ID"],
    });
  });

  test("an unset variable takes priority over an invalid one", () => {
    expect(
      resolveSttCredentials({
        CORTI_TENANT_NAME: "tenant.name",
        CORTI_CLIENT_ID: "id",
        CORTI_CLIENT_SECRET: "secret",
      }),
    ).toEqual({ missing: ["CORTI_ENVIRONMENT"] });
  });
});

describe("credentialsNotice", () => {
  test("the missing line names every unset variable and nothing else", () => {
    expect(
      credentialsNotice({
        missing: ["CORTI_TENANT_NAME", "CORTI_CLIENT_SECRET"],
      }),
    ).toBe("voice: set CORTI_TENANT_NAME and CORTI_CLIENT_SECRET to dictate");
    expect(
      credentialsNotice({
        missing: [
          "CORTI_ENVIRONMENT",
          "CORTI_TENANT_NAME",
          "CORTI_CLIENT_ID",
          "CORTI_CLIENT_SECRET",
        ],
      }),
    ).toBe(
      "voice: set CORTI_ENVIRONMENT, CORTI_TENANT_NAME, CORTI_CLIENT_ID and CORTI_CLIENT_SECRET to dictate",
    );
  });

  test("an invalid line names the variable and the form it must take", () => {
    expect(credentialsNotice({ invalid: "CORTI_ENVIRONMENT" })).toBe(
      `voice: CORTI_ENVIRONMENT must be letters, digits or "-"; voice is off`,
    );
    expect(credentialsNotice({ invalid: "CORTI_TENANT_NAME" })).toBe(
      `voice: CORTI_TENANT_NAME must be letters, digits, "_", "." or "-"; voice is off`,
    );
  });
});
