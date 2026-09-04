import { useState, type DragEvent, type RefObject } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { LocaleText } from "@/workbench/services/localization/browser/use-locale-text";
import type { VideoToMotionControllerState } from "../video-to-motion-controller";
import { formatBytes } from "./video-to-motion-view-helpers";
import { WorkflowStep } from "./workflow-step";

interface VideoSelectionStepProps {
  readonly detailsRef: RefObject<HTMLDetailsElement | null>;
  readonly state: VideoToMotionControllerState;
  readonly busy: boolean;
  readonly text: LocaleText;
  readonly onOpenPicker: () => void;
  readonly onSelectFiles: (files: readonly File[]) => void;
  readonly onPreviewDuration: (
    previewUrl: string,
    duration: number | null,
  ) => void;
}

/** Video picker/drop target and the selected-file preview. */
export function VideoSelectionStep({
  detailsRef,
  state,
  busy,
  text,
  onOpenPicker,
  onSelectFiles,
  onPreviewDuration,
}: VideoSelectionStepProps) {
  const [dragging, setDragging] = useState(false);
  const video = state.video;

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!busy) onSelectFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <WorkflowStep
      id="gvhmr-step-video"
      title={text("1. Select video", "1. 选择视频")}
      detailsRef={detailsRef}
      initiallyOpen
    >
      <div className="motion-import-control">
        <div
          id="video-drop-shared"
          className={cn(
            "dropzone motion-upload-shared video-upload-shared",
            dragging && "hover",
            busy && "disabled",
          )}
          role="group"
          aria-label={text("Video import area", "视频上传区")}
          aria-disabled={busy}
          onDragEnter={(event) => {
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) {
              setDragging(false);
            }
          }}
          onDrop={handleDrop}
        >
          <div className="dz-glyph">🎥</div>
          <div className="dz-title">
            {text("Drop a video file here", "拖入一个视频文件")}
          </div>
          <div className="dz-sub">MP4, MOV, MKV, AVI, WebM, M4V</div>
          <div className="row" style={{ marginTop: 10 }}>
            <Button
              id="video-pick-file"
              type="button"
              variant="secondary"
              size="sm"
              className="btn secondary small"
              disabled={busy}
              onClick={onOpenPicker}
            >
              {text("Choose video", "选择视频")}
            </Button>
          </div>
        </div>
      </div>
      {video ? (
        <section id="gvhmr-video-selection" className="video-selection">
          <video
            key={video.previewUrl}
            id="gvhmr-video-preview"
            src={video.previewUrl}
            aria-label={text("Selected video preview", "所选视频预览")}
            controls
            preload="metadata"
            onLoadedMetadata={(event) =>
              onPreviewDuration(
                video.previewUrl,
                Number.isFinite(event.currentTarget.duration)
                  ? event.currentTarget.duration
                  : null,
              )
            }
          />
          <div className="video-selection-row">
            <div className="video-selection-copy">
              <strong id="gvhmr-video-name">{video.name}</strong>
              <span id="gvhmr-video-meta" className="hint">
                {[
                  formatBytes(video.size),
                  video.mediaType || text("Video", "视频"),
                  video.duration === null
                    ? null
                    : `${video.duration.toFixed(1)} s`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="btn secondary small"
              disabled={busy}
              onClick={onOpenPicker}
            >
              {text("Replace video", "替换视频")}
            </Button>
          </div>
        </section>
      ) : null}
    </WorkflowStep>
  );
}
