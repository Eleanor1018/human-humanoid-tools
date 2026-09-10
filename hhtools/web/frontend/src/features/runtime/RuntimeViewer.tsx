import { useEffect, useRef, useState } from "react";
import { Stage } from "../../stage/Stage";
import type {
  StageMotionPayload,
  StageRobotPayload,
  StageRobotTrajectoryPayload,
} from "../../stage/types";
import { RuntimeConnection } from "./api";

export interface PreviewSession {
  session_id: string;
  frame_count: number;
  duration_seconds: number;
  request: { mode: "data" | "webrtc"; ttl_seconds: number };
}

interface SceneData {
  motion: StageMotionPayload | null;
  robot: StageRobotPayload | null;
  robot_trajectory: StageRobotTrajectoryPayload | null;
}

export function RuntimeViewer({
  connection,
  session,
  onError,
}: {
  connection: RuntimeConnection;
  session: PreviewSession;
  onError(error: unknown): void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const [scene, setScene] = useState<SceneData | null>(null);
  const [status, setStatus] = useState("connecting");
  const [playing, setPlaying] = useState(true);
  const [frame, setFrame] = useState(0);
  const [stats, setStats] = useState({ fps: 0, bytes: 0, jitter: 0 });
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const sequence = useRef(0);
  const cameraDistance = useRef(3);
  const path = `/api/runtime/v1/previews/${session.session_id}`;

  useEffect(() => {
    const timer = setInterval(() => {
      void connection.json(`${path}/renew`, "POST").catch(onError);
    }, session.request.ttl_seconds * 500);
    return () => clearInterval(timer);
  }, [connection, path, session.request.ttl_seconds, onError]);

  useEffect(() => {
    let disposed = false;
    setScene(null);
    setStatus("connecting");
    if (session.request.mode === "data") {
      void connection
        .json<SceneData>(`${path}/data`)
        .then((data) => {
          if (!disposed) {
            setScene(data);
            setStatus("ready");
          }
        })
        .catch(onError);
      return () => {
        disposed = true;
      };
    }
    const peer = new RTCPeerConnection({ iceServers: [] });
    const events = peer.createDataChannel("viewport");
    channel.current = events;
    events.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as { frame?: number };
      if (typeof message.frame === "number" && !disposed)
        setFrame(message.frame);
    };
    peer.addTransceiver("video", { direction: "recvonly" });
    peer.ontrack = (event) => {
      if (video.current) {
        video.current.srcObject = new MediaStream([event.track]);
        void video.current.play().catch(onError);
      }
    };
    peer.onconnectionstatechange = () => {
      if (!disposed) setStatus(peer.connectionState);
    };
    const connect = async () => {
      await peer.setLocalDescription(await peer.createOffer());
      if (peer.iceGatheringState !== "complete") {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("ICE gathering timed out")),
            10000,
          );
          peer.onicegatheringstatechange = () => {
            if (peer.iceGatheringState === "complete") {
              clearTimeout(timeout);
              resolve();
            }
          };
        });
      }
      if (disposed) return;
      const answer = await connection.json<RTCSessionDescriptionInit>(
        `${path}/offer`,
        "POST",
        {
          type: "offer",
          sdp: peer.localDescription?.sdp,
        },
      );
      if (!disposed) await peer.setRemoteDescription(answer);
    };
    void connect().catch((error: unknown) => {
      if (!disposed) onError(error);
    });
    const statsTimer = setInterval(() => {
      void peer
        .getStats()
        .then((report) => {
          report.forEach((item) => {
            if (
              !disposed &&
              item.type === "inbound-rtp" &&
              item.kind === "video"
            ) {
              setStats({
                fps: Number(item.framesPerSecond ?? 0),
                bytes: Number(item.bytesReceived ?? 0),
                jitter: Number(item.jitter ?? 0),
              });
            }
          });
        })
        .catch(() => undefined);
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(statsTimer);
      channel.current = null;
      events.close();
      peer.close();
      if (video.current) video.current.srcObject = null;
    };
  }, [connection, path, session.request.mode, onError]);

  function send(action: string, values: Record<string, number> = {}) {
    if (channel.current?.readyState === "open")
      channel.current.send(
        JSON.stringify({ action, sequence: ++sequence.current, ...values }),
      );
  }

  if (session.request.mode === "data") {
    return scene ? (
      <Stage
        motion={scene.motion}
        robot={scene.robot}
        robotTrajectory={scene.robot_trajectory}
        presentation={scene.robot ? "h2r-result" : "motion"}
      />
    ) : (
      <div className="runtime-empty" role="status">
        Loading scene
      </div>
    );
  }
  return (
    <div className="runtime-stream">
      <div
        className="runtime-stream-image"
        onWheel={(event) => {
          cameraDistance.current = Math.max(
            0.2,
            Math.min(
              100,
              cameraDistance.current * Math.exp(event.deltaY * 0.001),
            ),
          );
          send("zoom", { value: cameraDistance.current });
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          pointer.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={() => {
          pointer.current = null;
        }}
        onPointerMove={(event) => {
          if (!pointer.current) return;
          send("orbit", {
            x: (event.clientX - pointer.current.x) * 0.4,
            y: (event.clientY - pointer.current.y) * 0.2,
          });
          pointer.current = { x: event.clientX, y: event.clientY };
        }}
      >
        <video
          ref={video}
          autoPlay
          playsInline
          muted
          aria-label="Server rendered viewport"
        />
        {status !== "connected" && (
          <span className="runtime-stream-state" role="status">
            {status}
          </span>
        )}
      </div>
      <div className="runtime-stream-controls">
        <button
          type="button"
          title={playing ? "Pause" : "Play"}
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => {
            send(playing ? "pause" : "play");
            setPlaying(!playing);
          }}
        >
          <img
            src={`/icons/playback/${playing ? "pause" : "play"}.svg`}
            alt=""
          />
        </button>
        <input
          aria-label="Frame"
          type="range"
          min="0"
          max={Math.max(0, session.frame_count - 1)}
          value={frame}
          onChange={(event) => {
            const value = Number(event.target.value);
            setFrame(value);
            send("seek", { value });
          }}
        />
        <output>
          {frame + 1} / {session.frame_count}
        </output>
        <small>
          {stats.fps.toFixed(0)} fps · {(stats.bytes / 1048576).toFixed(1)} MB ·{" "}
          {(stats.jitter * 1000).toFixed(0)} ms jitter
        </small>
      </div>
    </div>
  );
}
