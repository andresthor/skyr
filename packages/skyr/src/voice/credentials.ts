/**
 * Corti speech-to-text credentials, read from the environment and nowhere else: the one module
 * that decides whether voice exists at all.
 */

export interface SttCredentials {
  environment: string;
  tenant: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Resolving the environment: full credentials, or — when voice cannot register — the
 * names of the variables that are unset (`missing`; values are never echoed), or the
 * one variable that failed its pattern (`invalid`). Both patterns are hostname-grade:
 * the environment and tenant are spliced into corti.app hostnames and URL paths.
 */
export type CredentialResult =
  | { creds: SttCredentials }
  | { missing: string[] }
  | { invalid: CheckedVariable };

/** The variables that must match a pattern as well as be set. */
type CheckedVariable = "CORTI_ENVIRONMENT" | "CORTI_TENANT_NAME";

export function resolveSttCredentials(
  env: NodeJS.ProcessEnv = process.env,
): CredentialResult {
  const environment = env.CORTI_ENVIRONMENT?.trim();
  const tenant = env.CORTI_TENANT_NAME?.trim();
  const clientId = env.CORTI_CLIENT_ID?.trim();
  const clientSecret = env.CORTI_CLIENT_SECRET?.trim();
  if (!environment || !tenant || !clientId || !clientSecret) {
    const missing = [
      ...(!environment ? ["CORTI_ENVIRONMENT"] : []),
      ...(!tenant ? ["CORTI_TENANT_NAME"] : []),
      ...(!clientId ? ["CORTI_CLIENT_ID"] : []),
      ...(!clientSecret ? ["CORTI_CLIENT_SECRET"] : []),
    ];
    return { missing };
  }
  // both are spliced into hostnames and URL paths
  if (!/^[a-z0-9-]+$/i.test(environment))
    return { invalid: "CORTI_ENVIRONMENT" };
  if (!/^[\w.-]+$/.test(tenant)) return { invalid: "CORTI_TENANT_NAME" };
  return { creds: { environment, tenant, clientId, clientSecret } };
}

/** What each checkable variable must look like, for the notice that names an invalid one. */
const CRED_FORMS: Record<CheckedVariable, string> = {
  CORTI_ENVIRONMENT: 'letters, digits or "-"',
  CORTI_TENANT_NAME: 'letters, digits, "_", "." or "-"',
};

/** The stub's one line, naming only the variable that kept voice from registering. */
export function credentialsNotice(
  from: Exclude<CredentialResult, { creds: SttCredentials }>,
): string {
  if ("missing" in from) {
    // en-GB: no comma before "and"
    const listed = new Intl.ListFormat("en-GB", { type: "conjunction" }).format(
      from.missing,
    );
    return `voice: set ${listed} to dictate`;
  }
  return `voice: ${from.invalid} must be ${CRED_FORMS[from.invalid]}; voice is off`;
}
