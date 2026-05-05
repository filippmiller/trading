export class ProviderNotConfiguredError extends Error {
  readonly code = "PROVIDER_NOT_CONFIGURED";

  constructor(provider: string, envVars: string[]) {
    super(`${provider} provider is not configured. Set ${envVars.join(", ")}.`);
    this.name = "ProviderNotConfiguredError";
  }
}

export class ProviderCapabilityError extends Error {
  readonly code = "PROVIDER_CAPABILITY_UNAVAILABLE";

  constructor(provider: string, capability: string) {
    super(`${provider} provider does not support ${capability}.`);
    this.name = "ProviderCapabilityError";
  }
}
