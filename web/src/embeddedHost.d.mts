export function postEmbeddedHostMessage(message: Record<string, unknown>): void;
export function installEmbeddedExternalLinkHandler(): () => void;
export function setEmbeddedFrameChallenge(challenge: string): void;
export function createNativeProject(name: string): Promise<{ id: string; name: string; workspacePath: string }>;
