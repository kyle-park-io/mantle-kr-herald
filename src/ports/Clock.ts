/** Injectable current-time source (ISO 8601). Enables deterministic tests. */
export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();
