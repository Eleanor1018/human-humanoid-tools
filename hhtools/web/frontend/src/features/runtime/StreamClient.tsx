import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { RuntimeConnection } from "./api";
import { waitForPeer } from "./peerState";
import {
  clientIceServers,
  configuredStreamPort,
  runtimeEndpoint,
  streamDimensions,
  type StreamResolution,
} from "./connectionSettings";
import { collectDroppedFiles } from "@/lib/dropFiles";
import type { UploadFile } from "@/lib/api";
import "./stream.css";

const API = "/api/runtime/v1/gui-sessions";
interface Session {
  session_id: string;
  state: string;
  request: { width: number; height: number };
}
interface Chooser {
  chooser_id: string;
  multiple: boolean;
  directory: boolean;
}
interface Download {
  download_id: string;
  filename: string;
  size_bytes: number;
}
interface Status {
  chooser: Chooser | null;
  downloads: Download[];
}

function Icon({ name }: { name: string }) {
  return (
    <span
      className="stream-icon"
      style={{
        maskImage: `url(/icons/${name}.svg)`,
        WebkitMaskImage: `url(/icons/${name}.svg)`,
      }}
      aria-hidden="true"
    />
  );
}

/** No workflow state lives here: the connected browser runs the existing App. */
export function StreamClient() {
  const [server, setServer] = useState(window.location.hostname);
  const [signalPort, setSignalPort] = useState(
    window.location.port ||
      (window.location.protocol === "https:" ? "443" : "80"),
  );
  const [streamPort, setStreamPort] = useState<string | null>(null);
  const [detectedStreamPort, setDetectedStreamPort] = useState("");
  const [resolution, setResolution] = useState<StreamResolution>("1280x720");
  const [token, setToken] = useState("");
  const [state, setState] = useState("Disconnected");
  const [error, setError] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [chooser, setChooser] = useState<Chooser | null>(null);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [uploading, setUploading] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const connection = useRef<RuntimeConnection | null>(null);
  const peer = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const attemptController = useRef<AbortController | null>(null);
  const activeSession = useRef<{
    client: RuntimeConnection;
    session: Session;
  } | null>(null);
  const cleanup = useRef<Promise<void>>(Promise.resolve());
  const move = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void new RuntimeConnection(window.location.origin)
      .json<{ ice_servers: RTCIceServer[] }>(
        `${API}/capabilities`, "GET", undefined,
        { signal: controller.signal, timeoutMs: 10000 },
      )
      .then((capabilities) => {
        if (!controller.signal.aborted)
          setDetectedStreamPort(configuredStreamPort(capabilities.ice_servers));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  function send(event: Record<string, unknown>) {
    if (
      channel.current?.readyState === "open" &&
      channel.current.bufferedAmount < 65536
    )
      channel.current.send(JSON.stringify(event));
  }

  function dispose() {
    send({ action: "release" });
    channel.current?.close();
    peer.current?.close();
    channel.current = null;
    peer.current = null;
    move.current = null;
    if (video.current) video.current.srcObject = null;
  }

  function release(owned: typeof activeSession.current): Promise<void> {
    if (!owned) return cleanup.current;
    const pending = cleanup.current.then(async () => {
      await owned.client.json(
        `${API}/${owned.session.session_id}`,
        "DELETE",
        undefined,
        { timeoutMs: 10000 },
      );
    });
    cleanup.current = pending.catch(() => undefined);
    return pending;
  }

  useEffect(() => {
    const tick = window.setInterval(() => {
      if (move.current) {
        send(move.current);
        move.current = null;
      }
    }, 25);
    return () => {
      generation.current++;
      attemptController.current?.abort();
      clearInterval(tick);
      dispose();
      void release(activeSession.current).catch(() => undefined);
      activeSession.current = null;
    };
  }, []);

  useEffect(() => {
    if (!session || state !== "Connected") return;
    const client = connection.current!;
    const controller = new AbortController();
    let active = true;
    const refresh = async () => {
      try {
        const status = await client.json<Status>(
          `${API}/${session.session_id}`,
          "GET",
          undefined,
          { signal: controller.signal, timeoutMs: 10000 },
        );
        if (active) {
          setChooser(status.chooser);
          setDownloads(status.downloads);
        }
      } catch (reason) {
        if (active) void close(String(reason));
      }
    };
    const poll = setInterval(() => void refresh(), 4000);
    const renew = setInterval(() => {
      void client
        .json(`${API}/${session.session_id}/renew`, "POST", undefined, {
          signal: controller.signal,
          timeoutMs: 10000,
        })
        .catch((reason) => {
          if (active) void close(String(reason));
        });
    }, 30000);
    void refresh();
    return () => {
      active = false;
      controller.abort();
      clearInterval(poll);
      clearInterval(renew);
    };
  }, [session, state]);

  useEffect(() => {
    if (state !== "disconnected") return;
    const timer = setTimeout(() => void close("WebRTC connection lost"), 15000);
    return () => clearTimeout(timer);
  }, [state]);

  useEffect(() => {
    if (!session || !surface.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      send({
        action: "resize",
        ...streamDimensions(
          resolution,
          entry.contentRect.width,
          entry.contentRect.height,
        ),
      });
    });
    observer.observe(surface.current);
    return () => observer.disconnect();
  }, [session, state, resolution]);

  useEffect(() => {
    const element = surface.current;
    if (!session || !element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      send({
        action: "wheel",
        ...coordinates(event.clientX, event.clientY),
        delta_x: Math.max(-5000, Math.min(5000, event.deltaX)),
        delta_y: Math.max(-5000, Math.min(5000, event.deltaY)),
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [session]);

  async function connect() {
    if (busy) return;
    const attempt = ++generation.current;
    attemptController.current?.abort();
    const controller = new AbortController();
    attemptController.current = controller;
    const signal = controller.signal;
    const deadline = setTimeout(
      () => controller.abort(
        new DOMException("Connection attempt timed out", "TimeoutError"),
      ),
      120000,
    );
    signal.addEventListener(
      "abort",
      () => {
        if (attempt === generation.current) void close(String(signal.reason));
      },
      { once: true },
    );
    const previous = activeSession.current;
    setBusy(true);
    setError("");
    setState("Connecting");
    setSession(previous?.session ?? null);
    setChooser(null);
    setDownloads([]);
    dispose();
    try {
      await cleanup.current;
      signal.throwIfAborted();
      const client = previous?.client ?? new RuntimeConnection(
        runtimeEndpoint(server, signalPort, window.location.protocol),
        token,
      );
      await client.connect(undefined, { signal, timeoutMs: 10000 });
      const capabilities = await client.json<{
        webrtc: { available: boolean; reason?: string };
        ice_servers: RTCIceServer[];
      }>(`${API}/capabilities`, "GET", undefined, { signal, timeoutMs: 10000 });
      if (!capabilities.webrtc.available)
        throw new Error(
          capabilities.webrtc.reason || "Streaming backend unavailable",
        );
      setDetectedStreamPort(configuredStreamPort(capabilities.ice_servers));
      const iceServers = clientIceServers(capabilities.ice_servers, streamPort);
      const created = previous?.session ?? await client.json<Session>(
        API,
        "POST",
        streamDimensions(
          resolution,
          window.innerWidth,
          window.innerHeight - 48,
        ),
        { signal, timeoutMs: 50000 },
      );
      if (attempt !== generation.current || signal.aborted) {
        await release({ client, session: created });
        signal.throwIfAborted();
        return;
      }
      connection.current = client;
      activeSession.current = { client, session: created };
      setSession(created);
      const rtc = new RTCPeerConnection({
        iceServers,
      });
      peer.current = rtc;
      rtc.addTransceiver("video", { direction: "recvonly" });
      const input = rtc.createDataChannel("gui-input", { ordered: true });
      channel.current = input;
      input.onopen = () => {
        if (attempt !== generation.current) return;
        if (surface.current)
          send({
            action: "resize",
            ...streamDimensions(
              resolution,
              surface.current.clientWidth,
              surface.current.clientHeight,
            ),
          });
      };
      input.onmessage = (event) => {
        if (attempt !== generation.current) return;
        try {
          const message = JSON.parse(String(event.data)) as {
            chooser?: Chooser | null;
            download?: Download;
            error?: string;
          };
          if ("chooser" in message) setChooser(message.chooser ?? null);
          if (message.download)
            setDownloads((items) => [
              ...items.filter(
                (item) => item.download_id !== message.download!.download_id,
              ),
              message.download!,
            ]);
          if (message.error) setError(message.error);
        } catch {
          setError("Invalid stream event");
        }
      };
      rtc.ontrack = (event) => {
        if (attempt !== generation.current) return;
        if (video.current) {
          video.current.srcObject = new MediaStream([event.track]);
          void video.current.play().catch(() => undefined);
        }
      };
      rtc.onconnectionstatechange = () => {
        if (attempt === generation.current) {
          if (["failed", "closed"].includes(rtc.connectionState)) {
            void close("WebRTC connection failed");
            return;
          }
          setState(
            rtc.connectionState === "connected"
              ? "Connected"
              : rtc.connectionState,
          );
        }
      };
      await rtc.setLocalDescription(await rtc.createOffer());
      await waitForPeer(rtc, "icegatheringstatechange", signal);
      const answer = await client.json<RTCSessionDescriptionInit>(
        `${API}/${created.session_id}/offer`,
        "POST",
        rtc.localDescription,
        { signal, timeoutMs: 25000 },
      );
      signal.throwIfAborted();
      await rtc.setRemoteDescription(answer);
      await waitForPeer(rtc, "connectionstatechange", signal);
    } catch (reason) {
      if (attempt === generation.current) await close(String(reason));
    } finally {
      clearTimeout(deadline);
      if (attempt === generation.current) setBusy(false);
    }
  }

  async function close(message = "") {
    const closedGeneration = ++generation.current;
    attemptController.current?.abort();
    attemptController.current = null;
    const owned = activeSession.current;
    activeSession.current = null;
    dispose();
    setSession(null);
    setBusy(false);
    setState("Disconnected");
    setChooser(null);
    setDownloads([]);
    setTyping(false);
    setError(message);
    try {
      await release(owned);
    } catch (reason) {
      if (closedGeneration === generation.current)
        setError(
          [message, `Session cleanup failed: ${String(reason)}`]
            .filter(Boolean)
            .join(". "),
        );
    }
  }

  function coordinates(clientX: number, clientY: number) {
    const rect = video.current!.getBoundingClientRect();
    const width = video.current!.videoWidth || session!.request.width;
    const height = video.current!.videoHeight || session!.request.height;
    const scale = Math.min(rect.width / width, rect.height / height);
    return {
      x: Math.max(
        0,
        Math.min(
          width - 1,
          (clientX - rect.left - (rect.width - width * scale) / 2) / scale,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          height - 1,
          (clientY - rect.top - (rect.height - height * scale) / 2) / scale,
        ),
      ),
    };
  }

  function pointer(event: PointerEvent<HTMLDivElement>, action: string) {
    if (!session) return;
    event.preventDefault();
    if (action === "down") {
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const input = {
      action,
      ...coordinates(event.clientX, event.clientY),
      button: ["left", "middle", "right"][event.button] || "left",
    };
    if (action === "move") move.current = input;
    else {
      move.current = null;
      send(input);
    }
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>, down: boolean) {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v")
      return;
    event.preventDefault();
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      if (down) send({ action: "text", text: event.key });
    } else send({ action: down ? "key_down" : "key_up", key: event.key });
  }

  async function upload(
    files: FileList | UploadFile[] | null,
    drop?: { x: number; y: number },
  ) {
    if (!files?.length || (!chooser && !drop) || !session) return;
    setUploading(0);
    setError("");
    try {
      const selected = [...files];
      const manifest = selected.map((file) => ({
        relative_path:
          (file as UploadFile)._relpath || file.webkitRelativePath || file.name,
        size_bytes: file.size,
      }));
      const transfer = await connection.current!.json<{
        upload_id: string;
        chunk_bytes: number;
      }>(`${API}/${session.session_id}/uploads`, "POST", {
        chooser_id: drop ? "drop" : chooser!.chooser_id,
        files: manifest,
        ...drop,
      });
      const total = selected.reduce((sum, file) => sum + file.size, 0);
      let sent = 0;
      for (let index = 0; index < selected.length; index++) {
        const file = selected[index]!;
        for (
          let offset = 0;
          offset < Math.max(1, file.size);
          offset += transfer.chunk_bytes
        ) {
          const chunk = file.slice(offset, offset + transfer.chunk_bytes);
          const query = new URLSearchParams({
            member: manifest[index]!.relative_path,
            offset: String(offset),
          });
          await connection.current!.response(
            `${API}/${session.session_id}/uploads/${transfer.upload_id}/content?${query}`,
            {
              method: "PUT",
              body: chunk,
              headers: { "Content-Type": "application/octet-stream" },
            },
          );
          sent += chunk.size;
          setUploading(sent / Math.max(1, total));
        }
      }
      await connection.current!.json(
        `${API}/${session.session_id}/uploads/${transfer.upload_id}/complete`,
        "POST",
      );
      setChooser(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setUploading(null);
      if (picker.current) picker.current.value = "";
    }
  }

  async function download(item: Download) {
    try {
      const picker = (
        window as Window & {
          showSaveFilePicker?: (options: {
            suggestedName: string;
          }) => Promise<FileSystemFileHandle>;
        }
      ).showSaveFilePicker;
      const handle = picker
        ? await picker({ suggestedName: item.filename })
        : null;
      if (!handle && item.size_bytes > 256 * 1024 ** 2) {
        throw new Error(
          "This browser requires a streaming file picker for large downloads",
        );
      }
      const response = await connection.current!.response(
        `${API}/${session!.session_id}/downloads/${item.download_id}`,
      );
      if (handle) {
        if (!response.body) throw new Error("Download stream unavailable");
        await response.body.pipeTo(await handle.createWritable());
      } else {
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement("a");
        link.href = url;
        link.download = item.filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError")
        return;
      setError(String(reason));
    }
  }

  return (
    <main className={`stream-client${session ? "" : " stream-client--login"}`}>
      {session && (
        <header className="stream-toolbar">
          <strong>HHTools</strong>
          <span className="stream-state" data-connected={state === "Connected"}>
            {state}
          </span>
          <div className="stream-tools">
            {session && (
              <button
                title="Text input"
                aria-label="Text input"
                onClick={() => setTyping((value) => !value)}
              >
                T
              </button>
            )}
            <button
              title="Reconnect"
              aria-label="Reconnect"
              disabled={busy}
              onClick={() => void connect()}
            >
              <Icon name="common/refresh-cw" />
            </button>
            {session && (
              <button
                title="Close session"
                aria-label="Close session"
                onClick={() => void close()}
              >
                <Icon name="common/close" />
              </button>
            )}
          </div>
        </header>
      )}
      {!session && (
        <section className="stream-login">
          <h1>HHTools WebRTC Streaming Client</h1>
          <form
            className="stream-connect"
            onSubmit={(event) => {
              event.preventDefault();
              void connect();
            }}
          >
            <div className="stream-login-row">
              <label className="stream-login-label" htmlFor="stream-server">
                Server:
              </label>
              <div className="stream-login-field">
                <input
                  id="stream-server"
                  type="text"
                  spellCheck={false}
                  value={server}
                  onChange={(event) => {
                    setServer(event.target.value);
                    setDetectedStreamPort("");
                  }}
                  disabled={busy}
                  required
                />
              </div>
            </div>
            <div
              className="stream-login-row stream-login-ports"
              role="group"
              aria-label="Ports"
            >
              <span className="stream-login-label">Ports:</span>
              <div className="stream-login-port">
                <label htmlFor="stream-signal-port">Signal</label>
                <input
                  id="stream-signal-port"
                  title="Runtime API port"
                  type="number"
                  min="1"
                  max="65535"
                  step="1"
                  required
                  disabled={busy}
                  value={signalPort}
                  onChange={(event) => {
                    setSignalPort(event.target.value);
                    setDetectedStreamPort("");
                  }}
                />
              </div>
              <span className="stream-port-divider" aria-hidden="true">
                /
              </span>
              <div className="stream-login-port">
                <label htmlFor="stream-media-port">Stream</label>
                <input
                  id="stream-media-port"
                  title="TURN port"
                  type="number"
                  min="1"
                  max="65535"
                  step="1"
                  placeholder="Auto"
                  disabled={busy}
                  value={streamPort ?? detectedStreamPort}
                  onChange={(event) => setStreamPort(event.target.value)}
                />
              </div>
            </div>
            <div className="stream-login-row">
              <label className="stream-login-label" htmlFor="stream-resolution">
                Resolution:
              </label>
              <div className="stream-login-field">
                <select
                  id="stream-resolution"
                  value={resolution}
                  disabled={busy}
                  onChange={(event) =>
                    setResolution(event.target.value as StreamResolution)
                  }
                >
                  <option value="1280x720">1280 x 720 (HD)</option>
                  <option value="1920x1080">1920 x 1080 (FHD)</option>
                  <option value="2560x1440" disabled>
                    2560 x 1440 (QHD)
                  </option>
                  <option value="3840x2160" disabled>
                    3840 x 2160 (4K UHD)
                  </option>
                  <option value="auto">Fit to window</option>
                </select>
              </div>
            </div>
            <details className="stream-auth">
              <summary>Authentication</summary>
              <label htmlFor="stream-token">Access token</label>
              <input
                id="stream-token"
                type="password"
                autoComplete="off"
                disabled={busy}
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </details>
            <button
              className="stream-connect-button"
              type="submit"
              disabled={busy}
            >
              {busy ? "Connecting" : "Connect"}
            </button>
            {busy && (
              <button
                type="button"
                className="stream-cancel-button"
                onClick={() => void close()}
              >
                <Icon name="common/close" />
                Cancel
              </button>
            )}
            {error && (
              <p className="stream-login-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </section>
      )}
      <div
        ref={surface}
        className="stream-surface"
        hidden={!session}
        tabIndex={0}
        aria-label="Remote HHTools application"
        onPointerDown={(event) => pointer(event, "down")}
        onPointerUp={(event) => pointer(event, "up")}
        onPointerMove={(event) => pointer(event, "move")}
        onPointerCancel={() => send({ action: "release" })}
        onContextMenu={(event) => event.preventDefault()}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const point = coordinates(event.clientX, event.clientY);
          void collectDroppedFiles(event.dataTransfer)
            .then((files) => upload(files, point))
            .catch((reason) => setError(String(reason)));
        }}
        onKeyDown={(event) => keyboard(event, true)}
        onKeyUp={(event) => keyboard(event, false)}
        onBlur={() => send({ action: "release" })}
        onPaste={(event) => {
          event.preventDefault();
          send({
            action: "text",
            text: event.clipboardData.getData("text/plain").slice(0, 16000),
          });
        }}
      >
        <video ref={video} autoPlay playsInline muted />
      </div>
      {typing && session && (
        <form
          className="stream-transfer"
          onSubmit={(event) => {
            event.preventDefault();
            send({ action: "text", text });
            setText("");
          }}
        >
          <input
            aria-label="Text to enter"
            value={text}
            maxLength={16000}
            onChange={(event) => setText(event.target.value)}
          />
          <button type="submit">Enter</button>
        </form>
      )}
      {chooser && (
        <div className="stream-transfer">
          <button
            disabled={uploading !== null}
            onClick={() => {
              if (picker.current) {
                picker.current.toggleAttribute(
                  "webkitdirectory",
                  chooser.directory,
                );
                picker.current.click();
              }
            }}
          >
            <Icon name="common/upload" />
            {chooser.directory ? "Choose folder" : "Choose files"}
          </button>
          <input
            ref={picker}
            type="file"
            hidden
            multiple={chooser.multiple}
            onChange={(event) => void upload(event.target.files)}
          />
          {uploading !== null && (
            <progress value={uploading} max={1} aria-label="File transfer" />
          )}
        </div>
      )}
      {downloads.length > 0 && (
        <div className="stream-downloads">
          {downloads.map((item) => (
            <button key={item.download_id} onClick={() => void download(item)}>
              <Icon name="robot/file" />
              {item.filename}
            </button>
          ))}
        </div>
      )}
      {error && session && (
        <div className="stream-error" role="alert">
          {error}
          <button
            title="Dismiss"
            aria-label="Dismiss"
            onClick={() => setError("")}
          >
            <Icon name="common/close" />
          </button>
        </div>
      )}
    </main>
  );
}
