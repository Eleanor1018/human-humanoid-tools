export type StreamResolution = "auto" | "1280x720" | "1920x1080";

function portNumber(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error("Port must be between 1 and 65535");
  }
  return Number(value);
}

export function runtimeEndpoint(
  server: string,
  port: string,
  localProtocol = "http:",
): string {
  const explicitScheme = server.includes("://");
  const url = new URL(
    explicitScheme ? server.trim() : `http://${server.trim()}`,
  );
  if (!explicitScheme) {
    url.protocol = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ? localProtocol
      : "https:";
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  ) {
    throw new Error("Enter a Runtime server hostname or HTTP(S) origin");
  }
  url.port = String(portNumber(port));
  return url.origin;
}

function turnUrl(value: string): URL | null {
  if (!/^turns?:/.test(value)) return null;
  return new URL(value.replace(/^(turns?):/, "$1://"));
}

export function configuredStreamPort(servers: readonly RTCIceServer[]): string {
  const ports = new Set<string>();
  for (const server of servers)
    for (const value of [server.urls].flat()) {
      const url = turnUrl(value);
      if (url)
        ports.add(url.port || (url.protocol === "turns:" ? "5349" : "3478"));
    }
  return ports.size === 1 ? [...ports][0] : "";
}

export function clientIceServers(
  servers: readonly RTCIceServer[],
  streamPort: string | null,
): RTCIceServer[] {
  if (!streamPort) return [...servers];
  const port = String(portNumber(streamPort));
  let configured = false;
  const result = servers.map((server) => ({
    ...server,
    urls: [server.urls].flat().map((value) => {
      const url = turnUrl(value);
      if (!url) return value;
      configured = true;
      url.port = port;
      return url.href.replace("://", ":");
    }),
  }));
  if (!configured) throw new Error("The Runtime has no TURN server configured");
  return result;
}

export function streamDimensions(
  resolution: StreamResolution,
  width: number,
  height: number,
) {
  if (resolution === "1280x720") return { width: 1280, height: 720 };
  if (resolution === "1920x1080") return { width: 1920, height: 1080 };
  return {
    width: Math.max(320, Math.min(1920, Math.round(width))),
    height: Math.max(320, Math.min(1080, Math.round(height))),
  };
}
