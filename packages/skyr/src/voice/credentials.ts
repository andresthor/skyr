/** Corti speech-to-text credentials. The one place that decides whether voice exists at all. */

export interface SttCredentials {
  environment: string;
  tenant: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Resolve STT credentials from the environment. All four must be set; anything
 * less leaves voice unregistered. Browser sign-in will become a second source here.
 */
export function resolveSttCredentials(
  env: NodeJS.ProcessEnv = process.env,
): SttCredentials | undefined {
  const environment = env.CORTI_ENVIRONMENT?.trim();
  const tenant = env.CORTI_TENANT_NAME?.trim();
  const clientId = env.CORTI_CLIENT_ID?.trim();
  const clientSecret = env.CORTI_CLIENT_SECRET?.trim();
  if (!environment || !tenant || !clientId || !clientSecret) return undefined;
  // both are spliced into hostnames and URL paths
  if (!/^[a-z0-9-]+$/i.test(environment) || !/^[\w.-]+$/.test(tenant))
    return undefined;
  return { environment, tenant, clientId, clientSecret };
}
