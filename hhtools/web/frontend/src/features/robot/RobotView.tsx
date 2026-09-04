import { ImportDropzone } from "@/components/ImportDropzone";
import { InspectorPage } from "@/components/Inspector";
import { SearchField } from "@/components/SearchField";
import { Button } from "@/components/ui/button";

export function RobotView() {
  return (
    <InspectorPage title="Robot">
      <div className="flex shrink-0 flex-col gap-2.5">
        <ImportDropzone
          label="URDF import area"
          icon="/icons/robot/file.svg"
          title="1 · URDF file"
          className="min-h-[120px] px-9 py-3.5"
        >
          <Button size="sm" disabled>
            Choose .urdf
          </Button>
        </ImportDropzone>
        <ImportDropzone
          label="Robot mesh import area"
          icon="/icons/robot/folder.svg"
          title="2 · Mesh folder"
          className="min-h-[120px] px-9 py-3.5"
        >
          <Button size="sm" disabled>
            Choose mesh folder
          </Button>
        </ImportDropzone>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          No URDF selected.
        </p>
      </div>

      <section
        className="flex min-h-[220px] flex-1 flex-col gap-2"
        aria-labelledby="robot-library-title"
      >
        <h2
          id="robot-library-title"
          className="text-[19px] leading-tight font-bold tracking-normal text-foreground"
        >
          Robot Library
        </h2>
        <SearchField
          label="Search the Robot Library"
          placeholder="Search robots..."
          disabled
        />
        <div className="min-h-[138px] flex-1 rounded-md border border-border-subtle bg-surface" />
      </section>
    </InspectorPage>
  );
}
