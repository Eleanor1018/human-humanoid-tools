import { Field, fieldClass } from "@/components/Field";
import { ImportDropzone } from "@/components/ImportDropzone";
import { InspectorPage } from "@/components/Inspector";
import { Button } from "@/components/ui/button";
import { WorkflowPipeline, WorkflowStep } from "@/components/WorkflowSteps";

const pipeline = ["Select Data", "Configure", "Analyze", "Results"];

export function AnalysisView() {
  return (
    <InspectorPage title="Data Analysis">
      <WorkflowPipeline label="Data Analysis pipeline" steps={pipeline} />
      <div className="flex shrink-0 flex-col">
        <WorkflowStep title="1. Select data" status="No data" defaultOpen>
          <div className="grid grid-cols-2 gap-2">
            <ImportDropzone
              label="Motion dataset import area"
              icon="/icons/sidebar/motion.svg"
              title="Motion"
              hint="Motion dataset folder"
              className="min-h-[150px] px-3 py-4"
            >
              <Button size="sm" disabled>
                Choose folder
              </Button>
            </ImportDropzone>
            <ImportDropzone
              label="Robot trajectory import area"
              icon="/icons/sidebar/robot.svg"
              title="Robot"
              hint="Robot trajectory folder"
              className="min-h-[150px] px-3 py-4"
            >
              <Button size="sm" disabled>
                Choose folder
              </Button>
            </ImportDropzone>
          </div>
          <p className="mt-2.5 text-xs text-muted-foreground">
            No folder selected
          </p>
          <details className="group mt-2.5 text-xs text-muted-foreground">
            <summary className="cursor-pointer list-none font-medium text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              Supported formats
            </summary>
            <p className="pt-2 leading-[1.5]">
              Motion datasets and robot trajectory folders
            </p>
          </details>
        </WorkflowStep>

        <WorkflowStep title="2. Configure" status="Handcrafted">
          <div className="grid gap-2.5">
            <Field label="Embedding">
              <select className={fieldClass} defaultValue="handcrafted" disabled>
                <option value="handcrafted">Handcrafted features (recommended)</option>
                <option value="pae">PAE (coming soon)</option>
              </select>
            </Field>
            <label className="flex min-h-8 items-center gap-2 text-xs font-medium text-foreground">
              <input type="checkbox" disabled className="size-4 accent-primary" />
              Ignore cache
            </label>
          </div>
        </WorkflowStep>

        <WorkflowStep title="3. Analyze" status="Not started">
          <Button variant="primary" size="sm" disabled>
            Start analysis
          </Button>
        </WorkflowStep>

        <WorkflowStep title="4. Results" status="No results">
          <p className="text-xs leading-[1.5] text-muted-foreground">
            Run an analysis to view metrics, clusters, and recommended subsets.
          </p>
        </WorkflowStep>
      </div>
    </InspectorPage>
  );
}
