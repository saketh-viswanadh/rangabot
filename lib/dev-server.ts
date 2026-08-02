export function devServerEnvironment(platform: NodeJS.Platform, environment: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  if (platform !== "darwin") return { ...environment };
  return {
    ...environment,
    WATCHPACK_POLLING: environment.WATCHPACK_POLLING ?? "true",
    WATCHPACK_POLLING_INTERVAL: environment.WATCHPACK_POLLING_INTERVAL ?? "1000",
  };
}
