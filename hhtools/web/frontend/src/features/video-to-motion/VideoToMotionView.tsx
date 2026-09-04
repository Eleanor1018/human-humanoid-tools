import { ImportDropzone } from "@/components/ImportDropzone";
import { InspectorPage } from "@/components/Inspector";
import { Button } from "@/components/ui/button";
import { WorkflowPipeline, WorkflowStep } from "@/components/WorkflowSteps";

const pipeline = ["Select Video", "Environment", "Generate", "Motion Result"];
const fieldClass =
  "min-h-8 w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:text-muted-foreground";

export function VideoToMotionView() {
  return (
    <InspectorPage title="Video → Motion">
      <WorkflowPipeline label="Video to Motion pipeline" steps={pipeline} />
      <div className="flex shrink-0 flex-col">
        <WorkflowStep title="1. Select video" status="Not selected" defaultOpen>
          <ImportDropzone
            label="Video import area"
            icon="/icons/sidebar/video-to-motion.svg"
            title="Drop a video file here"
            hint="MP4, MOV, MKV, AVI"
          >
            <Button size="sm" disabled>
              Choose video
            </Button>
          </ImportDropzone>
        </WorkflowStep>

        <WorkflowStep title="2. Environment" status="Not confirmed">
          <div className="grid gap-2.5">
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Weights
              <select className={fieldClass} defaultValue="official" disabled>
                <option value="official">Official weights</option>
                <option value="custom">Custom checkpoint</option>
              </select>
            </label>
            <Button size="sm" disabled>
              Confirm environment
            </Button>
          </div>
        </WorkflowStep>

        <WorkflowStep title="3. Generate" status="Waiting">
          <div className="grid gap-2.5">
            <label className="flex min-h-8 items-center justify-between gap-3 text-xs font-medium text-foreground">
              Static camera
              <input type="checkbox" defaultChecked disabled className="size-4 accent-primary" />
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-foreground">
              Focal length
              <input className={fieldClass} placeholder="Auto" disabled />
            </label>
            <Button variant="primary" size="sm" disabled>
              Start GVHMR
            </Button>
          </div>
        </WorkflowStep>

        <WorkflowStep title="4. Motion result" status="Empty">
          <div className="grid gap-2.5">
            <Button size="sm" disabled>
              Import existing .pt
            </Button>
            <p className="text-xs text-muted-foreground">No motion result yet.</p>
          </div>
        </WorkflowStep>
      </div>
    </InspectorPage>
  );
}
