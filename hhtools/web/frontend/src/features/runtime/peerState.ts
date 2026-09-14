/** Bound ICE/transport waits and remove listeners on every exit path. */
export function waitForPeer(
  peer: RTCPeerConnection,
  event: "icegatheringstatechange" | "connectionstatechange",
  signal: AbortSignal,
  timeoutMs = 15000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      peer.removeEventListener(event, update);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason);
    const update = () => {
      if (["failed", "closed"].includes(peer.connectionState))
        finish(new Error("WebRTC connection failed"));
      else if (
        event === "icegatheringstatechange"
          ? peer.iceGatheringState === "complete"
          : peer.connectionState === "connected"
      ) finish();
    };
    const timer = setTimeout(
      () => finish(new Error(
        event === "icegatheringstatechange"
          ? "ICE gathering timed out"
          : "WebRTC connection timed out",
      )),
      timeoutMs,
    );
    peer.addEventListener(event, update);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else update();
  });
}
